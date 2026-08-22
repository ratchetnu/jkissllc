// ── Lua argument-expansion guard for every shipped redis.eval() script ───────
//
// In Lua, a function call in the LAST argument position expands to ALL of its
// return values. `string.gsub` returns TWO — the new string AND a replacement
// count — so
//
//     redis.call('SET', recordKey, string.gsub(ARGV[1], ARGV[4], key, 1))
//
// does not call SET with a value. It calls `SET key value 1`, and real Redis
// answers `ERR syntax error`. The script then aborts PART-WAY THROUGH, and Redis
// does not roll back what a script already did — so an `INCR` executed above it
// stands while the write that was supposed to follow never happens.
//
// This shipped in this repository once (automatic release discovery, caught in
// review before it ever ran). No JavaScript test could see it: the local emulator
// and every unit-test fake model these scripts in JS rather than interpreting Lua,
// so a script that cannot execute at all still "passes". This guard is the cheap
// mechanism that does see it, and it runs everywhere without a Lua runtime.
//
// The rule: a multi-return function may not sit in the final argument position of
// `redis.call(...)`. Assign it to a local first, or wrap it in parentheses — both
// truncate it to one value.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/** Lua standard functions that return more than one value. */
const MULTI_RETURN = [
  'string.gsub', 'string.find', 'string.gmatch', 'string.byte',
  'pcall', 'xpcall', 'unpack', 'table.unpack', 'next', 'load', 'loadstring',
  'coroutine.resume', 'os.date',
]

const APP = path.resolve(import.meta.dirname, '..', 'app')

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) return tsFiles(full)
    return full.endsWith('.ts') || full.endsWith('.tsx') ? [full] : []
  })
}

/** Split a `redis.call(...)` argument list on top-level commas. */
function argumentsOf(source: string, openParen: number): string[] | null {
  let depth = 0
  let start = openParen + 1
  let quote: string | null = null
  const args: string[] = []
  for (let i = openParen; i < source.length; i++) {
    const c = source[i]
    if (quote) { if (c === quote && source[i - 1] !== '\\') quote = null; continue }
    if (c === "'" || c === '"') { quote = c; continue }
    if (c === '(') { depth++; if (depth === 1) start = i + 1; continue }
    if (c === ')') {
      depth--
      if (depth === 0) { args.push(source.slice(start, i)); return args }
      continue
    }
    if (c === ',' && depth === 1) { args.push(source.slice(start, i)); start = i + 1 }
  }
  return null
}

/**
 * Every `redis.call(...)` in `source` whose LAST argument is a bare multi-return
 * call. Both tests below go through THIS function — the self-check would be
 * worthless if it re-implemented the scan it is meant to prove.
 */
function offendersIn(source: string): { fn: string; line: number }[] {
  const found: { fn: string; line: number }[] = []
  let from = 0
  for (;;) {
    const at = source.indexOf('redis.call(', from)
    if (at === -1) return found
    from = at + 'redis.call('.length
    const args = argumentsOf(source, at + 'redis.call'.length)
    if (!args || args.length === 0) continue
    const last = args[args.length - 1].trim()
    const fn = MULTI_RETURN.find((name) => last.startsWith(`${name}(`))
    if (fn) found.push({ fn, line: source.slice(0, at).split('\n').length })
  }
}

test('no shipped Lua script expands a multi-return call in redis.call argument position', () => {
  const offenders: string[] = []
  for (const file of tsFiles(APP)) {
    for (const o of offendersIn(readFileSync(file, 'utf8'))) {
      offenders.push(`${path.relative(APP, file)}:${o.line} — ${o.fn}() is the last argument to redis.call`)
    }
  }
  assert.deepEqual(offenders, [], `\n${offenders.join('\n')}\n\nAssign it to a local (\`local x = string.gsub(...)\`) or wrap it in parentheses — both truncate the call to a single value. See the header of this file.`)
})

test('the guard actually detects the shape it exists to catch', () => {
  // Mutation-proof for the guard itself: break `offendersIn` and this fails, so a
  // silently-broken extractor cannot report "no offenders" forever.
  const sample = `
    redis.call('SET', recordKey, string.gsub(ARGV[1], ARGV[4], key, 1))
    redis.call('SET', KEYS[1], cjson.encode(record), 'PX', math.max(1, ttl))
    local safe = string.gsub(ARGV[1], ARGV[4], key, 1)
    redis.call('SET', recordKey, safe)
    redis.call('SET', recordKey, (string.gsub(ARGV[1], ARGV[4], key, 1)))
  `
  // Only the FIRST line is an offender: a single-return call (math.max), a local
  // assignment and a parenthesized call are all correct and must not be flagged.
  assert.deepEqual(offendersIn(sample).map((o) => o.fn), ['string.gsub'])
  assert.equal(offendersIn(sample).length, 1)
})
