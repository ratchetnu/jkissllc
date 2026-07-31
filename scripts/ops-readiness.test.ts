// ─────────────────────────────────────────────────────────────────────────────
// Sprint 7 — operational readiness.
//
// The property under test is HONESTY ABOUT ELAPSED TIME. The roadmap asks for a
// one-week operational gap log; a week is elapsed time, not an artifact, and the
// failure mode this guards against is a system that reports the observation as
// done because someone needed it green.
//
// So: completion is DERIVED from timestamps and the existence of a follow-up
// reading. There is no stored `complete` flag to set, and no code path that can
// assert one. Several tests below try to cheat it — a follow-up taken too early, a
// window with no follow-up at all, a reading with no provenance — and all of them
// must fail to produce "complete".
// ─────────────────────────────────────────────────────────────────────────────
process.env.ADMIN_SESSION_SECRET ||= 'test-secret-at-least-16-chars-long'
process.env.TENANCY_ENABLED = 'true'

import assert from 'node:assert/strict'
import test, { before, after, beforeEach } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { readFileSync } from 'node:fs'

const PORT = 8940 + (process.pid % 50)
process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}`
process.env.KV_REST_API_TOKEN = 'emulator-accepts-anything'

import {
  windowStatus, compareUsage, summariseGaps, readinessVerdict,
  saveGap, getGap, listGaps, saveReading, getReading, listReadings,
  WINDOW_24H, WINDOW_7D,
  type OpsGap, type OpsReading,
} from '../app/lib/platform/ops-readiness'
import { runWithTenant } from '../app/lib/platform/tenancy/context'
import { can } from '../app/lib/rbac'

let kv: ChildProcess | null = null
before(async () => {
  kv = spawn(process.execPath, ['scripts/local-audit/kv-emulator.mjs', '--port', String(PORT)], { stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/__admin/health`)).ok) break } catch { /* not up */ }
    await sleep(50)
  }
})
after(() => { kv?.kill('SIGKILL') })
beforeEach(() => fetch(`http://127.0.0.1:${PORT}/__admin/flush`, { method: 'POST' }).catch(() => {}))

const TEN = 'jkiss'
const OTHER = 'supercharged'
const T0 = 1_800_000_000_000
const H = 3_600_000

const reading = (over: Partial<OpsReading> = {}): OpsReading => ({
  id: 'ops_baseline01', kind: 'baseline', capturedAt: T0, capturedBy: 'u_admin',
  build: 'dpl_test', health: 'healthy', cronRunsPerDay: 297,
  estimatedRedisRequestsPerDay: 2600, ...over,
})

const gap = (over: Partial<OpsGap> = {}): OpsGap => ({
  id: 'gap_test0001', at: T0, observedBy: 'u_admin', severity: 'papercut',
  surface: 'admin', summary: 'something', ...over,
})

const withT = <T,>(t: string, fn: () => Promise<T>) => runWithTenant({ tenantId: t }, fn)

// ── The honesty core ─────────────────────────────────────────────────────────

test('WINDOW: an observation with no follow-up is NEVER complete, however long it ran', () => {
  const w = windowStatus(WINDOW_7D, T0, T0 + 200 * H, null)
  assert.equal(w.elapsed, true, '200h > 168h')
  assert.equal(w.followUpCaptured, false)
  assert.equal(w.complete, false, 'elapsed time alone proves nothing was observed')
  assert.match(w.statement, /AWAITING FOLLOW-UP/)
  assert.match(w.statement, /nothing has been compared/)
})

test('WINDOW: a follow-up cannot complete a window whose clock has not run out', () => {
  const w = windowStatus(WINDOW_7D, T0, T0 + 2 * H, reading({ kind: 'follow_up' }))
  assert.equal(w.followUpCaptured, true)
  assert.equal(w.elapsed, false)
  assert.equal(w.complete, false, 'a reading taken 2h in does not observe a week')
  assert.match(w.statement, /Not complete/)
  assert.equal(w.remainingHours, 166)
})

test('WINDOW: complete requires BOTH elapsed time and a follow-up', () => {
  const w = windowStatus(WINDOW_7D, T0, T0 + 170 * H, reading({ kind: 'follow_up' }))
  assert.equal(w.complete, true)
  assert.match(w.statement, /COMPLETE/)
})

test('WINDOW: it reports progress truthfully mid-flight', () => {
  const w = windowStatus(WINDOW_24H, T0, T0 + 6 * H, null)
  assert.equal(w.elapsedHours, 6)
  assert.equal(w.remainingHours, 18)
  assert.equal(w.complete, false)
  assert.match(w.statement, /IN PROGRESS/)
  assert.match(w.statement, /6h of 24h/)
})

test('WINDOW: there is NO stored completion flag to set — it is always derived', () => {
  const src = readFileSync(new URL('../app/lib/platform/ops-readiness.ts', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('export function windowStatus'), src.indexOf('export type UsageDelta'))
  assert.match(fn, /const complete = elapsed && followUpCaptured/)
  // Nothing may accept completion as an input or persist it.
  assert.doesNotMatch(fn, /complete\s*:\s*(true|input|opts)/, 'completion is never asserted')
  const stored = src.slice(src.indexOf('export type OpsReading'), src.indexOf('export const READING_ID_RE'))
  assert.doesNotMatch(stored, /\bcomplete\b/, 'a stored record must not carry a completion flag')
})

test('WINDOW: a clock that runs backwards does not produce negative progress', () => {
  const w = windowStatus(WINDOW_24H, T0, T0 - 50 * H, null)
  assert.equal(w.elapsedHours, 0)
  assert.equal(w.complete, false)
})

// ── Usage comparison ─────────────────────────────────────────────────────────

test('USAGE: a comparison needs BOTH readings to carry an external reading', () => {
  const base = reading({ upstash: { requestsUsed: 1000, allowance: 500_000, readAt: T0, source: 'console', readBy: 'u' } })
  const follow = reading({ id: 'ops_follow0001', kind: 'follow_up', capturedAt: T0 + 24 * H })
  assert.equal(compareUsage(base, follow), null, 'no follow-up figure → no result, not a zero')
  assert.equal(compareUsage(reading(), base), null, 'no baseline figure → no result')
})

test('USAGE: it projects consumption and flags an allowance breach', () => {
  const base = reading({ upstash: { requestsUsed: 10_000, allowance: 500_000, readAt: T0, source: 'console', readBy: 'u' } })
  const follow = reading({
    id: 'ops_follow0001', kind: 'follow_up', capturedAt: T0 + 24 * H,
    upstash: { requestsUsed: 12_600, allowance: 500_000, readAt: T0 + 24 * H, source: 'console', readBy: 'u' },
  })
  const d = compareUsage(base, follow)!
  assert.equal(d.requestsConsumed, 2_600)
  assert.equal(d.hoursBetween, 24)
  assert.equal(d.projectedPerDay, 2_600)
  assert.equal(d.projectedPer30Days, 78_000)
  assert.equal(d.withinAllowance, true)
  assert.ok(d.projectedPctOfAllowance < 20)

  // The pre-incident rate must read as a breach — the guard has to reject what
  // actually happened, or it means nothing.
  const bad = reading({
    id: 'ops_follow0002', kind: 'follow_up', capturedAt: T0 + 24 * H,
    upstash: { requestsUsed: 10_000 + 20_000, allowance: 500_000, readAt: T0 + 24 * H, source: 'console', readBy: 'u' },
  })
  const d2 = compareUsage(base, bad)!
  assert.equal(d2.projectedPer30Days, 600_000)
  assert.equal(d2.withinAllowance, false)
  assert.ok(d2.projectedPctOfAllowance > 100)
})

test('USAGE: zero elapsed time is not a rate', () => {
  const r = reading({ upstash: { requestsUsed: 1, allowance: 10, readAt: T0, source: 's', readBy: 'u' } })
  assert.equal(compareUsage(r, { ...r, id: 'ops_follow0001' }), null, 'no division by zero hours')
})

// ── Gap log + verdict ────────────────────────────────────────────────────────

test('VERDICT: an open blocker is disqualifying', () => {
  const s = summariseGaps([gap({ severity: 'blocker' })])
  const done = windowStatus(WINDOW_7D, T0, T0 + 200 * H, reading({ kind: 'follow_up' }))
  const v = readinessVerdict(s, [done])
  assert.equal(v.ready, false)
  assert.ok(v.reasons.some(r => r.startsWith('open_blockers')))
})

test('VERDICT: a resolved blocker no longer blocks', () => {
  const s = summariseGaps([gap({ severity: 'blocker', resolvedAt: T0 + H })])
  const done = windowStatus(WINDOW_7D, T0, T0 + 200 * H, reading({ kind: 'follow_up' }))
  assert.equal(readinessVerdict(s, [done]).ready, true)
})

test('VERDICT: an INCOMPLETE observation blocks readiness even with a clean gap log', () => {
  const s = summariseGaps([])
  const running = windowStatus(WINDOW_7D, T0, T0 + 10 * H, null)
  const v = readinessVerdict(s, [running])
  assert.equal(v.ready, false, 'no gaps found is not the same as having looked for a week')
  assert.ok(v.reasons.some(r => r.includes('observation_incomplete')))
  assert.ok(v.reasons.some(r => r.includes('10h/168h')), 'and it says how far short')
})

test('SUMMARY: gaps roll up by severity and surface', () => {
  const s = summariseGaps([
    gap({ id: 'gap_a0000001', severity: 'blocker', surface: 'book-now' }),
    gap({ id: 'gap_b0000001', severity: 'degraded', surface: 'book-now', resolvedAt: T0 + H }),
    gap({ id: 'gap_c0000001', severity: 'papercut', surface: 'crew-portal' }),
  ])
  assert.equal(s.total, 3); assert.equal(s.open, 2); assert.equal(s.resolved, 1)
  assert.equal(s.bySeverity.blocker, 1)
  assert.equal(s.openBlockers, 1)
  assert.deepEqual(s.surfaces[0], { surface: 'book-now', total: 2, open: 1 })
})

// ── Storage, idempotency, tenancy ────────────────────────────────────────────

test('STORE: gaps and readings round-trip and list newest-first', async () => {
  await withT(TEN, async () => {
    await saveGap(gap({ id: 'gap_old00001', at: T0 }))
    await saveGap(gap({ id: 'gap_new00001', at: T0 + H }))
    await saveReading(reading())
  })
  const gaps = await withT(TEN, () => listGaps(10))
  assert.deepEqual(gaps.map(g => g.id), ['gap_new00001', 'gap_old00001'])
  assert.equal((await withT(TEN, () => listReadings(10))).length, 1)
})

test('STORE: a malformed id never reaches the store', async () => {
  for (const bad of ['', 'nope', '../../etc/passwd', 'gap_x', 'GAP_ABCDEFGH']) {
    assert.equal(await withT(TEN, () => getGap(bad)), null, bad)
  }
  for (const bad of ['', 'ops_x', 'baseline']) {
    assert.equal(await withT(TEN, () => getReading(bad)), null, bad)
  }
})

test('TENANCY: readiness records never cross a tenant boundary', async () => {
  await withT(TEN, () => saveGap(gap({ id: 'gap_mine0001' })))
  assert.ok(await withT(TEN, () => getGap('gap_mine0001')))
  assert.equal(await withT(OTHER, () => getGap('gap_mine0001')), null)
  assert.deepEqual(await withT(OTHER, () => listGaps(10)), [])
})

test('TENANCY: the store fails closed with no tenant context', async () => {
  await assert.rejects(() => listGaps(5))
  await assert.rejects(() => getGap('gap_mine0001'))
})

// ── Authorization + provenance ───────────────────────────────────────────────

test('RBAC: reading takes audit:view (admin-only); writing takes settings:manage', () => {
  assert.equal(can('admin', 'audit:view'), true)
  assert.equal(can('manager', 'audit:view'), false, 'rbac.ts keeps audit:view admin-only')
  assert.equal(can('admin', 'settings:manage'), true)
  assert.equal(can('manager', 'settings:manage'), false)
  assert.equal(can('crew', 'audit:view'), false)

  const src = readFileSync(new URL('../app/api/admin/operations/readiness/route.ts', import.meta.url), 'utf8')
  const get = src.slice(src.indexOf('export const GET'), src.indexOf('export const POST'))
  const post = src.slice(src.indexOf('export const POST'))
  assert.match(get, /requirePermission\(req, 'audit:view'\)/)
  assert.match(post, /requirePermission\(req, 'settings:manage'\)/)
  assert.equal((src.match(/withTenantRoute\(/g) ?? []).length, 2)
})

test('PROVENANCE: a transcribed usage figure without a source is REFUSED', () => {
  const src = readFileSync(new URL('../app/api/admin/operations/readiness/route.ts', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('function parseUsage'), src.indexOf('export const GET'))
  assert.match(fn, /if \(!source\) return 'invalid'/,
    'a number with no stated source is indistinguishable from a guess')
  assert.match(fn, /readBy: who/, 'and the reader is recorded, not supplied by the caller')
  assert.match(src, /not a reading/, 'the refusal explains itself to the operator')
})

test('IDEMPOTENT: re-recording a gap preserves its ORIGINAL time and observer', () => {
  const src = readFileSync(new URL('../app/api/admin/operations/readiness/route.ts', import.meta.url), 'utf8')
  const branch = src.slice(src.indexOf("if (action === 'record_gap')"), src.indexOf("if (action === 'resolve_gap')"))
  assert.match(branch, /at: existing\?\.at \?\? Date\.now\(\)/, 'a retry cannot backdate an observation')
  assert.match(branch, /observedBy: existing\?\.observedBy \?\? who\.sub/, 'nor re-attribute it')
  const resolve = src.slice(src.indexOf("if (action === 'resolve_gap')"), src.indexOf("if (action === 'capture_reading')"))
  assert.match(resolve, /resolvedAt: gap\.resolvedAt \?\? Date\.now\(\)/, 'the first resolution time stands')
})

test('ELIGIBILITY: a follow-up only satisfies a window it actually outlasted', () => {
  const src = readFileSync(new URL('../app/api/admin/operations/readiness/route.ts', import.meta.url), 'utf8')
  assert.match(src, /capturedAt - baseline\.capturedAt >= t\.hours \* 3_600_000/,
    'an early reading must not satisfy a longer window')
})

// ── The runbook must exist and must not overclaim ────────────────────────────

test('DOCS: the follow-up procedure is documented as read-only and sparse', () => {
  const doc = readFileSync(new URL('../docs/operations/17-operational-readiness.md', import.meta.url), 'utf8')
  assert.match(doc, /24[- ]hour/i)
  assert.match(doc, /seven[- ]day|7[- ]day/i)
  assert.match(doc, /rollback/i, 'every Production action needs a rollback')
  assert.match(doc, /read-only/i)
  // It must state plainly that the observations are NOT done.
  assert.match(doc, /not been performed|outstanding|follow-up/i)
})
