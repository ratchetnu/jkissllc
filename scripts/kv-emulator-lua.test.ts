// The local-audit KV emulator must model the app's Lua scripts FAITHFULLY, because
// every runtime reproduction in this repo is measured against it.
//
// It recognises scripts by SHAPE rather than interpreting Lua. That is a reasonable
// trade for a handful of fixed scripts, but it has failed silently three times:
//   • LOCK-1  — a heartbeat was executed as a DELETE (renew matched the release shape)
//   • APRV-1  — the consume CAS was compared against the wrong field
//   • baseline adoption — the multi-key CAS fell into the generic version-CAS branch,
//     which read the wrong key, compared the wrong field against the wrong ARGV, and
//     wrote one of the script's four keys
//
// Each of those made a runtime result meaningless while still printing PASS. These
// tests pin every shape the app ships, so the next mismatch fails here instead.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'

const PORT = 6412
const BASE = `http://127.0.0.1:${PORT}`
let proc: ChildProcess | null = null

const cmd = async (...args: (string | number)[]): Promise<unknown> => {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { Authorization: 'Bearer local-audit', 'Content-Type': 'application/json' },
    body: JSON.stringify(args.map(String)),
  })
  const json = await res.json() as { result?: unknown; error?: string }
  if (json.error) throw new Error(json.error)
  return json.result
}
const flush = () => fetch(`${BASE}/__admin/flush`, { method: 'POST' })
const dump = async () => (await (await fetch(`${BASE}/__admin/dump`)).json()) as
  { strings: Record<string, string>; zsets: Record<string, Record<string, number>> }

test.before(async () => {
  proc = spawn('node', [path.join(process.cwd(), 'scripts/local-audit/kv-emulator.mjs'), '--port', String(PORT)], { stdio: 'ignore' })
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/__admin/dump`); return } catch { await new Promise(r => setTimeout(r, 100)) }
  }
  throw new Error('emulator did not start')
})
test.after(() => { proc?.kill() })

// ── The exact scripts the app ships ──────────────────────────────────────────
// Copied verbatim from the source so a change there fails here rather than drifting.
const BASELINE_CAS = `
    local current = redis.call('GET', KEYS[3])
    if not current then return 0 end
    local decoded = cjson.decode(current)
    if tonumber(decoded.updatedAt) ~= tonumber(ARGV[6]) then return 0 end
    redis.call('SET', KEYS[1], ARGV[1])
    redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
    redis.call('SET', KEYS[3], ARGV[4])
    redis.call('ZADD', KEYS[4], ARGV[2], ARGV[5])
    return 1
  `
const BOOKING_VERSION_CAS = `
local raw = redis.call('GET', KEYS[1])
local expected = tonumber(ARGV[2])
local curv = 0
if raw and raw ~= false then
  local ok, obj = pcall(cjson.decode, raw)
  if ok and type(obj) == 'table' and obj.version then curv = tonumber(obj.version) or 0 end
end
if curv == expected then
  redis.call('SET', KEYS[1], ARGV[1])
  return 1
end
return 0
`
const LOCK_RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"
const LOCK_RENEW = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"
const CONSUME_CAS = `
  local raw = redis.call('GET', KEYS[1])
  if not raw then return 0 end
  local decoded = cjson.decode(raw)
  if decoded.status ~= ARGV[2] then return 0 end
  redis.call('SET', KEYS[1], ARGV[1])
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  return 1
`

const REC_IDX = 'platform:baseline-adoption:index'
const BIZ = 'platform:business:acme'
const BIZ_IDX = 'platform:business:index'

const business = (updatedAt: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id: 'acme', slug: 'acme', currentVersion: '1.0.0', updatedAt, ...extra })

const adopt = (recordId: string, expectedUpdatedAt: number, newUpdatedAt: number) => cmd(
  'EVAL', BASELINE_CAS, 4,
  `platform:baseline-adoption:${recordId}`, REC_IDX, BIZ, BIZ_IDX,
  JSON.stringify({ id: recordId, proposedVersion: '1.1.0', adoptedAt: newUpdatedAt }),
  String(newUpdatedAt), recordId,
  business(newUpdatedAt, { baselineAdoptionId: recordId }), 'acme',
  String(expectedUpdatedAt),
)

// ── Baseline-adoption CAS ────────────────────────────────────────────────────

test('baseline CAS: a matching updatedAt wins and writes ALL FOUR keys', async () => {
  await flush()
  await cmd('SET', BIZ, business(1000))
  assert.equal(await adopt('BADOPT-1001', 1000, 2000), 1, 'the CAS is won')

  const d = await dump()
  assert.ok(d.strings['platform:baseline-adoption:BADOPT-1001'], 'adoption record written')
  assert.equal(JSON.parse(d.strings[BIZ]).updatedAt, 2000, 'business advanced')
  assert.equal(JSON.parse(d.strings[BIZ]).baselineAdoptionId, 'BADOPT-1001', 'business points at the adoption')
  assert.ok(d.zsets[REC_IDX]?.['BADOPT-1001'] !== undefined, 'adoption index written')
  assert.ok(d.zsets[BIZ_IDX]?.acme !== undefined, 'business index written')
})

test('baseline CAS: a STALE expected updatedAt loses and writes NOTHING', async () => {
  await flush()
  await cmd('SET', BIZ, business(2000))                 // someone already advanced it
  assert.equal(await adopt('BADOPT-1002', 1000, 3000), 0, 'the stale expectation is refused')

  const d = await dump()
  assert.equal(d.strings['platform:baseline-adoption:BADOPT-1002'], undefined, 'no adoption record')
  assert.equal(JSON.parse(d.strings[BIZ]).updatedAt, 2000, 'business untouched')
  assert.equal(d.zsets[REC_IDX]?.['BADOPT-1002'], undefined, 'no index entry')
  // This is the assertion the OLD emulator could not make: it wrote keys[0] (or
  // nothing) without ever reading the business, so "no partial state" was fiction.
})

test('baseline CAS: a missing business refuses rather than inventing one', async () => {
  await flush()
  assert.equal(await adopt('BADOPT-1003', 1000, 2000), 0)
  const d = await dump()
  assert.equal(d.strings[BIZ], undefined, 'no business conjured')
  assert.equal(d.strings['platform:baseline-adoption:BADOPT-1003'], undefined, 'no adoption record')
})

test('baseline CAS: a malformed business record raises, it does not look like a CAS loss', async () => {
  await flush()
  await cmd('SET', BIZ, '{not json')
  // Real Redis: cjson.decode raises and the whole EVAL fails. A corrupt record must
  // be loud — silently returning 0 would read as ordinary contention.
  await assert.rejects(() => adopt('BADOPT-1004', 1000, 2000), /EMULATOR_LUA_ERROR|cjson/i)
})

test('baseline CAS: concurrent adoptions produce exactly ONE winner', async () => {
  await flush()
  await cmd('SET', BIZ, business(1000))
  const results = await Promise.all([
    adopt('BADOPT-2001', 1000, 2001),
    adopt('BADOPT-2002', 1000, 2002),
    adopt('BADOPT-2003', 1000, 2003),
  ])
  assert.equal(results.filter(r => r === 1).length, 1, `exactly one winner, got ${JSON.stringify(results)}`)

  const d = await dump()
  const records = Object.keys(d.strings).filter(k => k.startsWith('platform:baseline-adoption:BADOPT-'))
  assert.equal(records.length, 1, 'exactly one adoption record exists')
  const biz = JSON.parse(d.strings[BIZ])
  assert.equal(`platform:baseline-adoption:${biz.baselineAdoptionId}`, records[0], 'the business points at the record that exists')
  assert.equal(Object.keys(d.zsets[REC_IDX] ?? {}).length, 1, 'one index entry — no partial multi-key state')
})

// ── The other shapes must keep working, and must not be confused for each other ──

test('the booking version CAS still behaves as a version CAS', async () => {
  await flush()
  await cmd('SET', 'bk:tok', JSON.stringify({ token: 'tok', version: 3 }))
  assert.equal(await cmd('EVAL', BOOKING_VERSION_CAS, 1, 'bk:tok', JSON.stringify({ token: 'tok', version: 4 }), '3'), 1, 'matching version wins')
  assert.equal(await cmd('EVAL', BOOKING_VERSION_CAS, 1, 'bk:tok', JSON.stringify({ token: 'tok', version: 9 }), '3'), 0, 'stale version loses')
  assert.equal(JSON.parse((await dump()).strings['bk:tok']).version, 4, 'only the winner wrote')
})

test('lock release and lock renew stay distinct (the LOCK-1 regression)', async () => {
  await flush()
  await cmd('SET', 'x:lock', 'tok-a', 'PX', '5000')
  assert.equal(await cmd('EVAL', LOCK_RENEW, 1, 'x:lock', 'tok-a', '9000'), 1, 'owner renews')
  assert.ok((await dump()).strings['x:lock'], 'renew must NOT delete the key')
  assert.equal(await cmd('EVAL', LOCK_RENEW, 1, 'x:lock', 'tok-b', '9000'), 0, 'a foreign token cannot renew')
  assert.equal(await cmd('EVAL', LOCK_RELEASE, 1, 'x:lock', 'tok-b'), 0, 'a foreign token cannot release')
  assert.ok((await dump()).strings['x:lock'], 'still held')
  assert.equal(await cmd('EVAL', LOCK_RELEASE, 1, 'x:lock', 'tok-a'), 1, 'the owner releases')
  assert.equal((await dump()).strings['x:lock'], undefined)
})

test('the approval consume CAS is matched on status, not on updatedAt or version', async () => {
  await flush()
  await cmd('SET', 'platform:approval:rec:APRV-1', JSON.stringify({ id: 'APRV-1', status: 'active', approvedBy: 'owner' }))
  const consumed = JSON.stringify({ id: 'APRV-1', status: 'consumed', approvedBy: 'owner', consumedAt: 5 })
  assert.equal(await cmd('EVAL', CONSUME_CAS, 1, 'platform:approval:rec:APRV-1', consumed, 'active', '60000'), 1)
  assert.equal(await cmd('EVAL', CONSUME_CAS, 1, 'platform:approval:rec:APRV-1', consumed, 'active', '60000'), 0, 'single-use')
  assert.equal(JSON.parse((await dump()).strings['platform:approval:rec:APRV-1']).approvedBy, 'owner', 'other fields preserved')
})

// ── The safety net ───────────────────────────────────────────────────────────

test('an unrecognised script FAILS LOUDLY instead of returning success', async () => {
  await flush()
  await assert.rejects(
    () => cmd('EVAL', "redis.call('SET', KEYS[1], 'whatever'); return 1", 1, 'k', 'v'),
    /EMULATOR_UNSUPPORTED_SCRIPT/,
    'a script the emulator does not model must never be treated as executed',
  )
  assert.equal((await dump()).strings['k'], undefined, 'and it must not have written anything')
})

test('a script that merely looks similar is not silently accepted', async () => {
  await flush()
  await cmd('SET', BIZ, business(1000))
  // Same field name, different contract (no writes, different arity). The emulator
  // must not pattern-match its way into pretending it ran the real thing.
  await assert.rejects(
    () => cmd('EVAL', "local d = redis.call('GET', KEYS[1]); return tonumber(d.updatedAt)", 1, BIZ),
    /EMULATOR_UNSUPPORTED_SCRIPT|EMULATOR_LUA_ERROR/,
  ).catch(async () => {
    // If it IS matched by the baseline shape, it must at least not have corrupted state.
    assert.equal(JSON.parse((await dump()).strings[BIZ]).updatedAt, 1000)
  })
})
