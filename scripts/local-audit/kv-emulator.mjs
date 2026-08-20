#!/usr/bin/env node
// ── Disposable local KV emulator (AUDIT / LOCAL DEV ONLY) ────────────────────
//
// app/lib/redis.ts talks to Upstash over its REST protocol: POST a JSON array of
// command args, get back `{ result }` or `{ error }`. A stock local Redis speaks
// RESP, not this, so it cannot stand in without a shim. This IS the shim — an
// in-memory store behind the same REST contract, bound to loopback only.
//
// Why in-memory + loopback: it makes connecting to a real datastore structurally
// impossible. There is no remote host to misconfigure and no credential to leak,
// so a local run can never touch Production (see docs note in README-local-audit).
//
// NOT for Preview or Production. Data lives in the process and dies with it.
//
//   start : node scripts/local-audit/kv-emulator.mjs [--port 6390] [--seed FILE]
//   stop  : Ctrl-C, or kill the pid in .local-audit/kv.pid
//   reset : restart it (memory only), or POST /__admin/flush
//   dump  : GET /__admin/dump   (inspect what the app wrote)

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const PORT = Number(argOf('--port', process.env.LOCAL_KV_PORT || 6390))
const SEED = argOf('--seed', '')

// ── store ────────────────────────────────────────────────────────────────────
/** @type {Map<string, {v: string, exp: number|null}>} */ const strings = new Map()
/** @type {Map<string, Map<string, number>>} */ const zsets = new Map()   // key -> member -> score
/** @type {Map<string, Map<string, number>>} */ const hashes = new Map()  // key -> field -> int
/** @type {Map<string, Set<string>>} */ const hll = new Map()             // PF* approximated exactly

function alive(rec) {
  if (!rec) return false
  if (rec.exp !== null && Date.now() > rec.exp) return false
  return true
}
function getStr(k) {
  const rec = strings.get(k)
  if (!alive(rec)) { strings.delete(k); return null }
  return rec.v
}
function zset(k) { if (!zsets.has(k)) zsets.set(k, new Map()); return zsets.get(k) }
function sortedMembers(k) {
  return [...zset(k).entries()]
    .sort((a, b) => (a[1] - b[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([m]) => m)
}
// Redis inclusive slice with negative index support.
function slice(arr, start, stop) {
  const n = arr.length
  let s = start < 0 ? n + start : start
  let e = stop < 0 ? n + stop : stop
  if (s < 0) s = 0
  if (e >= n) e = n - 1
  if (n === 0 || s > e) return []
  return arr.slice(s, e + 1)
}
function parseScoreBound(tok) {
  const t = String(tok)
  if (t === '-inf') return { v: -Infinity, ex: false }
  if (t === '+inf' || t === 'inf') return { v: Infinity, ex: false }
  if (t.startsWith('(')) return { v: Number(t.slice(1)), ex: true }
  return { v: Number(t), ex: false }
}

// The Lua scripts the app actually uses. Recognized by shape rather than
// interpreted — a Lua VM would be far more machinery than three fixed scripts need.
//
// ORDER MATTERS. Release and renew share the same ownership test
// (`get(KEYS[1]) == ARGV[1]`) and differ only in what they then DO, so the renew
// shape must be checked FIRST — otherwise a heartbeat is executed as a delete and
// a renewed lock silently destroys itself. (That is exactly what happened when the
// LOCK-1 heartbeat was first verified against this emulator.)
const OWNED_RE = /redis\.call\('get',\s*KEYS\[1\]\)\s*==\s*ARGV\[1\]/i
const RENEW_RE = /pexpire/i
const CAS_RE = /cjson\.decode/i
const PAY_ISSUE_RE = /missing statement number placeholder/i
const PAY_PERSIST_RE = /statement\.status\s*~=\s*'void'/i
const PAY_EMAIL_RE = /return 'NOT_ISSUED'/i
// APRV-1's single-use transition also decodes JSON, so it must be recognised BEFORE
// the generic version-CAS branch or it would be compared against the wrong field.
const STATUS_CAS_RE = /decoded\.status/i
// Baseline adoption's multi-key CAS decodes JSON too. Before this branch existed it
// fell into the generic version-CAS below, which read the WRONG KEY (the adoption
// record instead of the business), compared the WRONG FIELD (`version` instead of
// `updatedAt`), compared it against the WRONG ARGV (adoptedAt instead of the expected
// updatedAt), and wrote ONE of the script's FOUR keys. The CAS condition was never
// evaluated, so a baseline-adoption runtime check against this emulator proved
// nothing — assertions phrased as "not more than one adoption" passed vacuously on
// zero adoptions, and "no partial state" was measured against a partial write the
// emulator itself invented.
const BASELINE_CAS_RE = /decoded\.updatedAt/i

function evalScript(script, keys, args) {
  if (OWNED_RE.test(script) && RENEW_RE.test(script)) {  // compare-and-extend lock renewal
    const cur = getStr(keys[0])
    if (cur !== null && cur === args[0]) {
      const rec = strings.get(keys[0])
      if (rec) rec.exp = Date.now() + Number(args[1])
      return 1
    }
    return 0
  }
  if (OWNED_RE.test(script)) {                         // compare-and-delete lock release
    const cur = getStr(keys[0])
    if (cur !== null && cur === args[0]) { strings.delete(keys[0]); return 1 }
    return 0
  }
  if (PAY_EMAIL_RE.test(script)) {                     // status-safe email metadata update
    const raw = getStr(keys[0])
    if (raw === null) return 'NOT_FOUND'
    const statement = JSON.parse(raw)
    if (statement.status !== 'issued') return 'NOT_ISSUED'
    const encoded = args[0]
    strings.set(keys[0], { v: encoded, exp: null })
    return encoded
  }
  if (PAY_ISSUE_RE.test(script)) {                     // allocate + persist one statement atomically
    const current = Number(getStr(keys[0]) ?? 0) + 1
    strings.set(keys[0], { v: String(current), exp: null })
    const encoded = args[0].replace(args[4], `${args[1]}${1000 + current}`)
    strings.set(keys[1], { v: encoded, exp: null })
    zset(keys[2]).set(args[3], Number(args[2]))
    zset(keys[3]).set(args[3], Number(args[2]))
    strings.set(keys[4], { v: args[3], exp: null })
    return encoded
  }
  if (PAY_PERSIST_RE.test(script)) {                   // record + indexes as one statement write
    const statement = JSON.parse(args[0])
    strings.set(keys[0], { v: args[0], exp: null })
    zset(keys[1]).set(args[2], Number(args[1]))
    zset(keys[2]).set(args[2], Number(args[1]))
    if (statement.status !== 'void') strings.set(keys[3], { v: args[2], exp: null })
    return 1
  }
  if (STATUS_CAS_RE.test(script)) {                    // status CAS: active → consumed
    const raw = getStr(keys[0])
    if (raw === null) return 0
    let cur = null
    try { cur = JSON.parse(raw).status } catch { return 0 }
    if (cur !== args[1]) return 0
    strings.set(keys[0], { v: args[0], exp: args[2] ? Date.now() + Number(args[2]) : null })
    return 1
  }
  if (BASELINE_CAS_RE.test(script)) {
    // Baseline adoption (app/lib/platform/updates/store.ts):
    //   local current = redis.call('GET', KEYS[3])          -- the BUSINESS record
    //   if not current then return 0 end
    //   if tonumber(cjson.decode(current).updatedAt) ~= tonumber(ARGV[6]) then return 0 end
    //   SET KEYS[1] ARGV[1]                                  -- adoption record
    //   ZADD KEYS[2] ARGV[2] ARGV[3]                         -- adoption index
    //   SET KEYS[3] ARGV[4]                                  -- business record
    //   ZADD KEYS[4] ARGV[2] ARGV[5]                         -- business index
    // Lua is 1-indexed, so KEYS[3] is keys[2] and ARGV[6] is args[5] here.
    const business = getStr(keys[2])
    if (business === null) return 0                    // missing business → refuse
    let decoded
    try { decoded = JSON.parse(business) } catch {
      // Faithful to Redis: cjson.decode raises on malformed input and the whole
      // EVAL fails — it does NOT quietly return 0. Surfacing it keeps a corrupt
      // record loud instead of looking like an ordinary CAS loss.
      throw new Error('EMULATOR_LUA_ERROR: cjson.decode failed on KEYS[3]')
    }
    if (Number(decoded?.updatedAt) !== Number(args[5])) return 0   // stale expectation
    // All four writes, or none. This is the property the script exists to provide.
    strings.set(keys[0], { v: args[0], exp: null })
    zset(keys[1]).set(args[2], Number(args[1]))
    strings.set(keys[2], { v: args[3], exp: null })
    zset(keys[3]).set(args[4], Number(args[1]))
    return 1
  }
  if (CAS_RE.test(script)) {                           // optimistic version CAS on a JSON doc
    const raw = getStr(keys[0])
    const expected = Number(args[1])
    let curv = 0
    if (raw) { try { const o = JSON.parse(raw); if (o && typeof o === 'object' && o.version) curv = Number(o.version) || 0 } catch { /* treat as 0 */ } }
    if (curv === expected) { strings.set(keys[0], { v: args[0], exp: null }); return 1 }
    return 0
  }
  throw new Error('EMULATOR_UNSUPPORTED_SCRIPT')
}

function exec(args) {
  const cmd = String(args[0]).toUpperCase()
  const A = args.map(String)
  switch (cmd) {
    case 'PING': return 'PONG'
    case 'GET': return getStr(A[1])
    case 'MGET': return A.slice(1).map(getStr)
    case 'SET': {
      const [, k, v, ...rest] = A
      const flags = rest.map((f) => f.toUpperCase())
      const nx = flags.includes('NX')
      if (nx && getStr(k) !== null) return null      // Upstash returns null when NX fails
      let exp = null
      const pxi = flags.indexOf('PX'); if (pxi >= 0) exp = Date.now() + Number(rest[pxi + 1])
      const exi = flags.indexOf('EX'); if (exi >= 0) exp = Date.now() + Number(rest[exi + 1]) * 1000
      strings.set(k, { v, exp })
      return 'OK'
    }
    case 'DEL': { let n = 0; for (const k of A.slice(1)) { if (strings.delete(k)) n++; zsets.delete(k); hashes.delete(k); hll.delete(k) } return n }
    case 'INCR': { const cur = Number(getStr(A[1]) ?? 0) + 1; strings.set(A[1], { v: String(cur), exp: null }); return cur }
    case 'EXPIRE': { const r = strings.get(A[1]); if (!alive(r)) return 0; r.exp = Date.now() + Number(A[2]) * 1000; return 1 }
    case 'PEXPIRE': { const r = strings.get(A[1]); if (!alive(r)) return 0; r.exp = Date.now() + Number(A[2]); return 1 }
    case 'ZADD': { zset(A[1]).set(A[3], Number(A[2])); return 1 }
    case 'ZREM': { return zset(A[1]).delete(A[2]) ? 1 : 0 }
    case 'ZCARD': return zset(A[1]).size
    case 'ZRANGE': return slice(sortedMembers(A[1]), Number(A[2]), Number(A[3]))
    case 'ZREVRANGE': return slice([...sortedMembers(A[1])].reverse(), Number(A[2]), Number(A[3]))
    case 'ZRANGEBYSCORE': {
      const min = parseScoreBound(A[2]); const max = parseScoreBound(A[3])
      let out = [...zset(A[1]).entries()]
        .filter(([, s]) => (min.ex ? s > min.v : s >= min.v) && (max.ex ? s < max.v : s <= max.v))
        .sort((a, b) => a[1] - b[1]).map(([m]) => m)
      const li = A.findIndex((t) => t.toUpperCase() === 'LIMIT')
      if (li >= 0) { const off = Number(A[li + 1]); const cnt = Number(A[li + 2]); out = out.slice(off, cnt < 0 ? undefined : off + cnt) }
      return out
    }
    case 'HINCRBY': {
      if (!hashes.has(A[1])) hashes.set(A[1], new Map())
      const h = hashes.get(A[1]); const nv = (h.get(A[2]) ?? 0) + Number(A[3]); h.set(A[2], nv); return nv
    }
    case 'HGETALL': { const h = hashes.get(A[1]); if (!h) return []; return [...h.entries()].flatMap(([f, v]) => [f, String(v)]) }
    case 'PFADD': { if (!hll.has(A[1])) hll.set(A[1], new Set()); const s = hll.get(A[1]); const before = s.size; for (const m of A.slice(2)) s.add(m); return s.size > before ? 1 : 0 }
    case 'PFCOUNT': { const u = new Set(); for (const k of A.slice(1)) for (const m of (hll.get(k) ?? [])) u.add(m); return u.size }
    case 'EVAL': { const nk = Number(A[2]); return evalScript(A[1], A.slice(3, 3 + nk), A.slice(3 + nk)) }
    default: throw new Error(`EMULATOR_UNSUPPORTED_COMMAND:${cmd}`)
  }
}

function flushAll() { strings.clear(); zsets.clear(); hashes.clear(); hll.clear() }

function dump() {
  return {
    strings: Object.fromEntries([...strings.entries()].filter(([, r]) => alive(r)).map(([k, r]) => [k, r.v])),
    zsets: Object.fromEntries([...zsets.entries()].map(([k, m]) => [k, Object.fromEntries(m)])),
    hashes: Object.fromEntries([...hashes.entries()].map(([k, m]) => [k, Object.fromEntries(m)])),
    counts: { strings: strings.size, zsets: zsets.size, hashes: hashes.size, hll: hll.size },
  }
}

function loadSeed(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const [k, v] of Object.entries(raw.strings ?? {})) strings.set(k, { v: typeof v === 'string' ? v : JSON.stringify(v), exp: null })
  for (const [k, members] of Object.entries(raw.zsets ?? {})) for (const [m, s] of Object.entries(members)) zset(k).set(m, Number(s))
  for (const [k, fields] of Object.entries(raw.hashes ?? {})) { hashes.set(k, new Map(Object.entries(fields).map(([f, n]) => [f, Number(n)]))) }
  console.log(`[kv-emulator] seeded from ${path.basename(file)} — ${strings.size} strings, ${zsets.size} zsets`)
}

const server = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }

  if (req.method === 'GET' && req.url === '/__admin/dump') return send(200, dump())
  if (req.method === 'POST' && req.url === '/__admin/flush') { flushAll(); return send(200, { ok: true, flushed: true }) }
  if (req.method === 'GET' && req.url === '/__admin/health') return send(200, { ok: true, emulator: true, port: PORT })

  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    // Deliberately NOT checking the bearer token: the emulator is loopback-only and
    // holds nothing real. Accepting any token means the app's synthetic credential
    // never has to match anything, which keeps real tokens out of the local env file.
    let args
    try { args = JSON.parse(body || '[]') } catch { return send(400, { error: 'bad json' }) }
    try {
      // Upstash accepts a single command, or an array of commands (pipeline).
      if (Array.isArray(args[0])) return send(200, args.map((a) => ({ result: exec(a) })))
      return send(200, { result: exec(args) })
    } catch (e) {
      return send(200, { error: e instanceof Error ? e.message : 'emulator error' })
    }
  })
})

if (SEED) loadSeed(SEED)

server.listen(PORT, '127.0.0.1', () => {
  try {
    fs.mkdirSync('.local-audit', { recursive: true })
    fs.writeFileSync('.local-audit/kv.pid', String(process.pid))
  } catch { /* pid file is a convenience, not a requirement */ }
  console.log(`[kv-emulator] listening on http://127.0.0.1:${PORT} (loopback only, in-memory, disposable)`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { fs.rmSync('.local-audit/kv.pid', { force: true }) } catch { /* ignore */ }
    console.log('\n[kv-emulator] stopped — all data discarded')
    process.exit(0)
  })
}
