// ─────────────────────────────────────────────────────────────────────────────
// Due-index: the FINAL lane, and the no-fallback guarantee.
//
// This exists because of a real Production outage. `cron/ai-jobs` runs every three
// minutes and BOTH its runners selected work with `listBookings(500)` — one ZRANGE
// plus a GET per booking, roughly 2N+2 Redis requests per tick. At 480 ticks/day
// that exhausted a 500,000-request Upstash quota and took the site down: health
// 503 `kv_unreachable`, homepage 500.
//
// The two properties that must not rot:
//
//   1. WHEN THE INDEX IS ENABLED, A FAILED INDEX READ MUST NOT FALL BACK TO A SCAN.
//      The fallback IS the query that caused the outage, so a flaky index would
//      silently restore the failure mode. Fail visibly, retry next tick.
//   2. THE TWO LANES MUST NOT COLLIDE. Both indexes are keyed by booking token and
//      one booking can hold an initial AND a final job at once with different due
//      times. Sharing one ZSET would let each lane overwrite the other's score and
//      strand a job.
// ─────────────────────────────────────────────────────────────────────────────
process.env.ADMIN_SESSION_SECRET ||= 'test-secret-at-least-16-chars-long'
process.env.TENANCY_ENABLED = 'true'

import assert from 'node:assert/strict'
import test, { before, after, beforeEach } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { readFileSync } from 'node:fs'

const PORT = 8820 + (process.pid % 100)
process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}`
process.env.KV_REST_API_TOKEN = 'emulator-accepts-anything'

import {
  DUE_KEY, FINAL_DUE_KEY, laneKey, laneDueScore, finalBookingDueScore,
  bookingDueScore, readDueTokens, selectDueFromIndex, dueTelemetry,
  dueIndexMaintained, dueIndexReadEnabled,
} from '../app/lib/ai-due-index'
import { backfillDueIndexes, verifyDueIndexCoverage } from '../app/lib/ai-due-backfill'
import { saveBooking, type Booking } from '../app/lib/bookings'
import { runWithTenant } from '../app/lib/platform/tenancy/context'
import { redis } from '../app/lib/redis'

let kv: ChildProcess | null = null
before(async () => {
  kv = spawn(process.execPath, ['scripts/local-audit/kv-emulator.mjs', '--port', String(PORT)], { stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/__admin/health`)).ok) break } catch { /* not up */ }
    await sleep(50)
  }
})
after(() => { kv?.kill('SIGKILL') })
beforeEach(async () => {
  process.env.OPERION_DUE_INDEX = 'true'
  delete process.env.OPERION_DUE_INDEX_DARK_LAUNCH
  await fetch(`http://127.0.0.1:${PORT}/__admin/flush`, { method: 'POST' }).catch(() => {})
})

const TEN = 'jkiss'
const OTHER = 'supercharged'
const NOW = 1_700_000_000_000
let seq = 0

const job = (over: Record<string, unknown> = {}) => ({
  status: 'queued', attempts: 0, nextRetryAt: NOW - 1_000,
  idempotencyKey: 'k', updatedAt: NOW, initiatedBy: 'system', ...over,
})

const mkBooking = (over: Partial<Booking> = {}): Booking => ({
  token: `t${++seq}`.padEnd(16, '0'),
  bookingNumber: `JK-B-${2000 + seq}`,
  customerName: 'Sam', serviceType: 'junk_removal',
  items: [], availableDates: [], availableWindows: [],
  invoiceAmountCents: 0, depositAmountCents: 0, amountPaidCents: 0,
  status: 'confirmed', payments: [], events: [],
  createdAt: NOW, updatedAt: NOW, ...over,
} as unknown as Booking)

const withT = <T,>(t: string, fn: () => Promise<T>) => runWithTenant({ tenantId: t }, fn)
const seed = (t: string, b: Booking) => withT(t, () => saveBooking(b))
const members = (t: string, key: string) => withT(t, () => redis.zrangebyscore(key, '-inf', '+inf', 0, 100))

// ── 1. The two lanes are independent ─────────────────────────────────────────

test('LANES: initial and final use SEPARATE keys — one booking can be due in both', async () => {
  assert.notEqual(DUE_KEY, FINAL_DUE_KEY)
  assert.equal(laneKey('initial'), DUE_KEY)
  assert.equal(laneKey('final'), FINAL_DUE_KEY)

  const b = mkBooking({
    aiJob: job({ nextRetryAt: NOW - 5_000 }),
    finalAiJob: job({ nextRetryAt: NOW - 1_000 }),
    confirmation: { confirmationVersion: 1 },
  } as Partial<Booking>)
  await seed(TEN, b)

  assert.deepEqual(await members(TEN, DUE_KEY), [b.token], 'initial lane holds it')
  assert.deepEqual(await members(TEN, FINAL_DUE_KEY), [b.token], 'final lane holds it too')

  // The scores DIFFER — a single shared ZSET could not represent both.
  const li = laneDueScore('initial', b)
  const lf = laneDueScore('final', b)
  assert.equal(li, NOW - 5_000)
  assert.equal(lf, NOW - 1_000)
  assert.notEqual(li, lf)
})

test('LANES: retiring one lane leaves the other intact — neither strands the other', async () => {
  const b = mkBooking({
    aiJob: job(), finalAiJob: job(), confirmation: { confirmationVersion: 1 },
  } as Partial<Booking>)
  await seed(TEN, b)

  // The INITIAL job completes; the final job is still queued.
  b.aiJob = job({ status: 'completed' }) as never
  await seed(TEN, b)

  assert.deepEqual(await members(TEN, DUE_KEY), [], 'the completed initial job is retired')
  assert.deepEqual(await members(TEN, FINAL_DUE_KEY), [b.token], 'the final job survives')
})

test('LANES: the final score honours isFinalDue’s EXTRA guards', () => {
  const base = { archived: false, isTest: false, finalAiJob: job() } as never
  assert.equal(finalBookingDueScore({ ...(base as object), confirmation: undefined } as never), null,
    'no confirmation → never due')
  assert.equal(finalBookingDueScore({ ...(base as object), confirmation: { invalidatedAt: NOW } } as never), null,
    'an invalidated confirmation retires the entry')
  assert.equal(finalBookingDueScore({ ...(base as object), confirmation: { confirmationVersion: 1 } } as never), NOW - 1_000)
  // …and the initial score does NOT apply them — the lanes are genuinely different.
  assert.equal(bookingDueScore({ archived: false, isTest: false, aiJob: job() } as never), NOW - 1_000)
})

// ── 2. No silent fallback to a full scan ─────────────────────────────────────

test('NO-FALLBACK: an unreadable index returns ok:false and selects NOTHING', async () => {
  // Point the client at a dead port: a genuine read failure, not a mock.
  const good = process.env.KV_REST_API_URL
  process.env.KV_REST_API_URL = 'http://127.0.0.1:1'
  let loads = 0
  const sel = await withT(TEN, () => selectDueFromIndex('final', NOW, 10,
    async () => { loads++; return null }, () => true))
  process.env.KV_REST_API_URL = good

  assert.equal(sel.ok, false)
  assert.equal(sel.indexReadFailed, true)
  assert.deepEqual(sel.due, [], 'no work is invented from a failed read')
  assert.equal(loads, 0, 'and NOTHING was loaded — a scan would have loaded every booking')
  assert.equal(sel.fullScanPerformed, false)
  assert.ok(sel.error)
})

test('NO-FALLBACK: an unreadable index is DISTINCT from an empty one', async () => {
  const empty = await withT(TEN, () => selectDueFromIndex('final', NOW, 10, async () => null, () => true))
  assert.equal(empty.ok, true, 'nothing due is a successful answer')
  assert.equal(empty.indexReadFailed, false)

  const good = process.env.KV_REST_API_URL
  process.env.KV_REST_API_URL = 'http://127.0.0.1:1'
  const broken = await withT(TEN, () => selectDueFromIndex('final', NOW, 10, async () => null, () => true))
  process.env.KV_REST_API_URL = good
  assert.equal(broken.ok, false, 'an outage is NOT "all caught up"')
})

test('NO-FALLBACK: neither runner calls listBookings on the indexed path', () => {
  const initial = readFileSync(new URL('../app/lib/book-now-ai.ts', import.meta.url), 'utf8')
  const final = readFileSync(new URL('../app/lib/book-now-confirmation.ts', import.meta.url), 'utf8')
  for (const [name, src] of [['initial', initial], ['final', final]] as const) {
    const start = src.indexOf('if (dueIndexReadEnabled())')
    assert.ok(start > 0, `${name}: the indexed branch must exist`)
    const branch = src.slice(start, src.indexOf('} else {', start))
    assert.doesNotMatch(branch, /listBookings/, `${name}: the indexed path must never scan`)
    assert.match(branch, /selectDueFromIndex/, `${name}: uses the shared indexed selection`)
    assert.match(branch, /if \(!selection\.ok\)/, `${name}: handles a failed read explicitly`)
    // The failure branch must RETURN, not fall through into the scan below.
    const fail = branch.slice(branch.indexOf('if (!selection.ok)'))
    assert.match(fail, /return \{ processed: 0/, `${name}: a failed read ends the tick`)
  }
})

test('NO-FALLBACK: telemetry states plainly whether a scan happened', () => {
  const idx = dueTelemetry({
    ok: true, lane: 'final', selectedFromIndex: 3, due: [], staleRetired: 1, missingRetired: 0,
    indexReadFailed: false, estimatedRedisRequests: 5, fullScanPerformed: false,
  }, 3)
  assert.equal(idx.fullScanPerformed, false)
  assert.equal(idx.source, 'index')
  assert.equal(idx.estimatedRedisRequests, 5)

  const scan = dueTelemetry(null, 2, 400)
  assert.equal(scan.fullScanPerformed, true, 'the expensive path stays visible')
  assert.equal(scan.estimatedRedisRequests, 401, '1 ZRANGE + one GET per booking')
})

// ── 3. Idempotent maintenance across every transition ────────────────────────

test('IDEMPOTENT: repeated saves converge — duplicates, retries and replacements', async () => {
  const b = mkBooking({ aiJob: job(), finalAiJob: job(), confirmation: { confirmationVersion: 1 } } as Partial<Booking>)
  for (let i = 0; i < 5; i++) await seed(TEN, b)          // duplicate requests
  assert.deepEqual(await members(TEN, DUE_KEY), [b.token], 'one member, not five')
  assert.deepEqual(await members(TEN, FINAL_DUE_KEY), [b.token])

  // A provider failure reschedules — the score moves, the membership does not.
  b.aiJob = job({ status: 'retrying', attempts: 2, nextRetryAt: NOW + 60_000 }) as never
  await seed(TEN, b)
  assert.deepEqual(await members(TEN, DUE_KEY), [b.token])
  const notYet = await withT(TEN, () => readDueTokens('initial', NOW, 10))
  assert.deepEqual(notYet.ok && notYet.tokens, [], 'and it is no longer due right now')
})

test('IDEMPOTENT: terminal, cancelled and superseded states leave NO active entry', async () => {
  for (const [label, patch] of [
    ['completed', { aiJob: job({ status: 'completed' }), finalAiJob: job({ status: 'completed' }) }],
    ['failed', { aiJob: job({ status: 'failed' }), finalAiJob: job({ status: 'failed' }) }],
    ['manual_review', { aiJob: job({ status: 'manual_review' }), finalAiJob: job({ status: 'manual_review' }) }],
    ['archived', { archived: true, aiJob: job(), finalAiJob: job() }],
    ['test', { isTest: true, aiJob: job(), finalAiJob: job() }],
    ['confirmation invalidated', { aiJob: job({ status: 'completed' }), finalAiJob: job(), confirmation: { invalidatedAt: NOW } }],
  ] as const) {
    await fetch(`http://127.0.0.1:${PORT}/__admin/flush`, { method: 'POST' }).catch(() => {})
    const b = mkBooking({ confirmation: { confirmationVersion: 1 }, ...(patch as object) } as Partial<Booking>)
    await seed(TEN, b)
    assert.deepEqual(await members(TEN, DUE_KEY), [], `${label}: initial entry retired`)
    assert.deepEqual(await members(TEN, FINAL_DUE_KEY), [], `${label}: final entry retired`)
  }
})

test('IDEMPOTENT: a stale entry offered by the index is retired, not processed', async () => {
  const b = mkBooking({ aiJob: job() } as Partial<Booking>)
  await seed(TEN, b)
  // The index still offers it, but re-verification says it is not due.
  const sel = await withT(TEN, () => selectDueFromIndex('initial', NOW, 10,
    async () => b, () => false))
  assert.equal(sel.due.length, 0, 'the record decides, not the score')
  assert.equal(sel.staleRetired, 1)
  assert.deepEqual(await members(TEN, DUE_KEY), [], 'and the tombstone is gone')
})

test('IDEMPOTENT: an index entry whose booking vanished is retired', async () => {
  await withT(TEN, () => redis.zadd(DUE_KEY, NOW - 1, 'ghosttoken000000'))
  const sel = await withT(TEN, () => selectDueFromIndex('initial', NOW, 10, async () => null, () => true))
  assert.equal(sel.missingRetired, 1)
  assert.deepEqual(await members(TEN, DUE_KEY), [])
})

test('IDEMPOTENT: duplicate cron invocations select the same work without duplicating it', async () => {
  const b = mkBooking({ aiJob: job() } as Partial<Booking>)
  await seed(TEN, b)
  const run = () => withT(TEN, () => selectDueFromIndex('initial', NOW, 10, async () => b, () => true))
  const [a, c] = [await run(), await run()]
  assert.deepEqual(a.due.map((x: Booking) => x.token), [b.token])
  assert.deepEqual(c.due.map((x: Booking) => x.token), [b.token], 'a second tick sees the same job, not two')
  assert.equal(a.staleRetired + c.staleRetired, 0)
})

// ── 4. Backfill ──────────────────────────────────────────────────────────────

test('BACKFILL: dry run by DEFAULT — it prices the work and writes nothing', async () => {
  const b = mkBooking({ aiJob: job(), finalAiJob: job(), confirmation: { confirmationVersion: 1 } } as Partial<Booking>)
  process.env.OPERION_DUE_INDEX = 'false'   // index maintenance OFF, so entries are absent
  await seed(TEN, b)
  assert.deepEqual(await members(TEN, DUE_KEY), [], 'precondition: cold index')

  const dry = await withT(TEN, () => backfillDueIndexes())
  assert.equal(dry.dryRun, true, 'writing must be opt-in')
  assert.equal(dry.written, 0)
  assert.equal(dry.wouldAdd.initial, 1)
  assert.equal(dry.wouldAdd.final, 1)
  assert.equal(dry.dueNow.initial, 1, 'reports the jobs a cold index would strand')
  assert.ok(dry.estimatedRedisRequests > 0, 'and what it cost to find out')
  assert.deepEqual(await members(TEN, DUE_KEY), [], 'still cold — nothing was written')
})

test('BACKFILL: writing requires an explicit dryRun:false, then covers both lanes', async () => {
  const b = mkBooking({ aiJob: job(), finalAiJob: job(), confirmation: { confirmationVersion: 1 } } as Partial<Booking>)
  process.env.OPERION_DUE_INDEX = 'false'
  await seed(TEN, b)

  const run = await withT(TEN, () => backfillDueIndexes({ dryRun: false }))
  assert.equal(run.dryRun, false)
  assert.ok(run.written >= 2)
  assert.equal(run.writeFailures, 0)
  assert.deepEqual(await members(TEN, DUE_KEY), [b.token], 'pre-existing queued job now covered')
  assert.deepEqual(await members(TEN, FINAL_DUE_KEY), [b.token])
})

test('BACKFILL: re-running is safe — the second pass changes nothing', async () => {
  const b = mkBooking({ aiJob: job(), finalAiJob: job(), confirmation: { confirmationVersion: 1 } } as Partial<Booking>)
  process.env.OPERION_DUE_INDEX = 'false'
  await seed(TEN, b)
  await withT(TEN, () => backfillDueIndexes({ dryRun: false }))
  const before = await members(TEN, DUE_KEY)
  await withT(TEN, () => backfillDueIndexes({ dryRun: false }))
  assert.deepEqual(await members(TEN, DUE_KEY), before, 'idempotent across reruns')
})

test('BACKFILL: bounded and resumable via a cursor', async () => {
  process.env.OPERION_DUE_INDEX = 'false'
  for (let i = 0; i < 5; i++) await seed(TEN, mkBooking({ aiJob: job() } as Partial<Booking>))

  const first = await withT(TEN, () => backfillDueIndexes({ dryRun: false, pageSize: 2, maxPages: 1 }))
  assert.equal(first.complete, false, 'a bounded call stops early')
  assert.equal(first.nextCursor, 2, 'and says where to resume')
  assert.ok(first.estimatedRequestsToComplete > 0, 'and prices finishing the walk')

  let cursor: number | null = first.nextCursor
  let guard = 0
  while (cursor != null && guard++ < 10) {
    // Bound to a const so the closure captures the NARROWED value, not number|null.
    const from: number = cursor
    const next = await withT(TEN, () => backfillDueIndexes({ dryRun: false, cursor: from, pageSize: 2, maxPages: 1 }))
    cursor = next.nextCursor
  }
  assert.equal((await members(TEN, DUE_KEY)).length, 5, 'resuming covers everything')
})

test('BACKFILL: it never deletes or advances a source job', async () => {
  const b = mkBooking({ aiJob: job(), finalAiJob: job(), confirmation: { confirmationVersion: 1 } } as Partial<Booking>)
  process.env.OPERION_DUE_INDEX = 'false'
  await seed(TEN, b)
  const before = JSON.stringify(await withT(TEN, () => redis.get(`bk:${b.token}`)))
  await withT(TEN, () => backfillDueIndexes({ dryRun: false }))
  assert.equal(JSON.stringify(await withT(TEN, () => redis.get(`bk:${b.token}`))), before,
    'the booking record is byte-identical — only ZSET entries were written')
})

test('COVERAGE: reports the DANGEROUS direction — due jobs the index is missing', async () => {
  process.env.OPERION_DUE_INDEX = 'false'
  const b = mkBooking({ aiJob: job(), finalAiJob: job(), confirmation: { confirmationVersion: 1 } } as Partial<Booking>)
  await seed(TEN, b)

  const cold = await withT(TEN, () => verifyDueIndexCoverage(async (lane, at, limit) => {
    const r = await readDueTokens(lane, at, limit); return r.ok ? r.tokens : []
  }))
  assert.equal(cold.covered, false, 'a cold index is NOT covered')
  assert.deepEqual(cold.missingFromIndex.initial, [b.token])
  assert.deepEqual(cold.missingFromIndex.final, [b.token])

  await withT(TEN, () => backfillDueIndexes({ dryRun: false }))
  const warm = await withT(TEN, () => verifyDueIndexCoverage(async (lane, at, limit) => {
    const r = await readDueTokens(lane, at, limit); return r.ok ? r.tokens : []
  }))
  assert.equal(warm.covered, true, 'after backfill, coverage is provable')
  assert.deepEqual(warm.missingFromIndex.final, [])
})

// ── 5. Tenancy ───────────────────────────────────────────────────────────────

test('TENANCY: due entries never cross a tenant boundary', async () => {
  const mine = mkBooking({ aiJob: job(), finalAiJob: job(), confirmation: { confirmationVersion: 1 } } as Partial<Booking>)
  await seed(TEN, mine)
  assert.deepEqual(await members(TEN, DUE_KEY), [mine.token])
  assert.deepEqual(await members(OTHER, DUE_KEY), [], 'another tenant sees nothing')
  assert.deepEqual(await members(OTHER, FINAL_DUE_KEY), [])

  const theirs = await withT(OTHER, () => readDueTokens('final', NOW, 10))
  assert.deepEqual(theirs.ok && theirs.tokens, [])
})

test('TENANCY: the index fails closed with no tenant context', async () => {
  await assert.rejects(() => redis.zrangebyscore(DUE_KEY, '-inf', '+inf', 0, 10))
})

// ── 6. Flags, and the dark-launch warning ────────────────────────────────────

test('FLAGS: both due-index flags remain OFF by default', () => {
  assert.equal(dueIndexReadEnabled({}), false)
  assert.equal(dueIndexMaintained({}), false)
  assert.equal(dueIndexReadEnabled({ OPERION_DUE_INDEX: 'true' }), true)
  // Dark-launch maintains WITHOUT flipping the read source.
  assert.equal(dueIndexMaintained({ OPERION_DUE_INDEX_DARK_LAUNCH: 'true' }), true)
  assert.equal(dueIndexReadEnabled({ OPERION_DUE_INDEX_DARK_LAUNCH: 'true' }), false)
})

test('DARK-LAUNCH: it does the scan AND an index read — worse, not better, under quota pressure', () => {
  const initial = readFileSync(new URL('../app/lib/book-now-ai.ts', import.meta.url), 'utf8')
  const final = readFileSync(new URL('../app/lib/book-now-confirmation.ts', import.meta.url), 'utf8')
  for (const [name, src] of [['initial', initial], ['final', final]] as const) {
    const scanBranch = src.slice(src.indexOf('} else {', src.indexOf('if (dueIndexReadEnabled())')))
    const parity = scanBranch.slice(0, scanBranch.indexOf('const results'))
    assert.match(parity, /listBookings\(500\)/, `${name}: the scan path still scans`)
    assert.match(parity, /dueIndexMaintained\(\)/, `${name}: parity is gated on dark-launch`)
  }
  // The runbook must say so, so nobody reaches for it as the emergency lever.
  const doc = readFileSync(new URL('../docs/operations/due-index-recovery.md', import.meta.url), 'utf8')
  assert.match(doc, /do not.{0,40}dark[- ]launch/i, 'the runbook must warn against dark-launch as the enable step')
})

test('COST: the arithmetic that caused the outage is written down', () => {
  const doc = readFileSync(new URL('../docs/operations/due-index-recovery.md', import.meta.url), 'utf8')
  assert.match(doc, /2N \+ 2|2N\+2/, 'per-tick cost')
  assert.match(doc, /500,?000/, 'the quota that was exhausted')
  assert.match(doc, /rollback/i, 'every Production step needs a rollback')
})
