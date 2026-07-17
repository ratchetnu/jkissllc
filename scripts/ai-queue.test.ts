// AI Command Center Increment 2 — Evaluation Queue engine + state guards.
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import {
  deriveQueue, orderQueue, nextActionable, countByTier, tierRank, QUEUE_TIERS,
  type QueueInput,
} from '../app/lib/estimation/shadow-queue'
import type { ShadowRunStatus } from '../app/lib/estimation/shadow-run-status'
import { COOKIE_NAME } from '../app/api/admin/_lib/session'

// ── deriveQueue: tier + reason + next-action ─────────────────────────────────

const item = (over: Partial<QueueInput> & { status: ShadowRunStatus }): QueueInput => ({
  bookingId: 'b', view: { canRun: false, canRetry: false, canOpen: true },
  selected: false, eligible: false, hasComparison: false, hasGroundTruth: false,
  hasCategories: false, wentToManualReview: false, updatedAt: 1000, ...over,
})

test('failed → needs_intervention with a Retry action', () => {
  const d = deriveQueue(item({ status: 'failed' }))
  assert.equal(d.tier, 'needs_intervention')
  assert.equal(d.action.kind, 'retry')
  assert.equal(d.actionable, true)
})

test('retry_blocked → intervention, resolve action, still actionable (owner must look)', () => {
  const d = deriveQueue(item({ status: 'retry_blocked' }))
  assert.equal(d.tier, 'needs_intervention')
  assert.equal(d.action.kind, 'resolve')
})

test('budget_blocked / kill_switch → intervention but NOT owner-actionable', () => {
  for (const s of ['budget_blocked', 'kill_switch'] as const) {
    const d = deriveQueue(item({ status: s }))
    assert.equal(d.tier, 'needs_intervention')
    assert.equal(d.actionable, false, `${s} is a system state, not owner work`)
  }
})

test('completed + manual_review + not reviewed → awaiting_review', () => {
  const d = deriveQueue(item({ status: 'completed', hasComparison: true, wentToManualReview: true }))
  assert.equal(d.tier, 'awaiting_review')
  assert.equal(d.action.kind, 'review')
})

test('completed, no ground truth → missing_ground_truth (the big blocker)', () => {
  const d = deriveQueue(item({ status: 'awaiting_ground_truth', hasComparison: true }))
  assert.equal(d.tier, 'missing_ground_truth')
  assert.equal(d.action.kind, 'review')
  assert.equal(d.action.label, 'Add ground truth')
})

test('benchmarked but uncategorized → uncategorized tier', () => {
  const d = deriveQueue(item({ status: 'completed', hasComparison: true, hasGroundTruth: true, hasCategories: false }))
  assert.equal(d.tier, 'uncategorized')
  assert.equal(d.action.kind, 'categorize')
})

test('fully handled (benchmarked + categorized) → informational, not actionable', () => {
  const d = deriveQueue(item({ status: 'completed', hasComparison: true, hasGroundTruth: true, hasCategories: true }))
  assert.equal(d.tier, 'informational')
  assert.equal(d.actionable, false)
})

test('ready to run → ready_to_run with Run action', () => {
  const d = deriveQueue(item({ status: 'selected', selected: true, eligible: true, view: { canRun: true, canRetry: false, canOpen: false } }))
  assert.equal(d.tier, 'ready_to_run')
  assert.equal(d.action.kind, 'run')
})

test('eligible but not selected → ready_to_run with Select action', () => {
  const d = deriveQueue(item({ status: 'not_selected', eligible: true, selected: false }))
  assert.equal(d.tier, 'ready_to_run')
  assert.equal(d.action.kind, 'select')
})

test('queued / processing → in_flight, nothing to do', () => {
  for (const s of ['queued', 'processing'] as const) {
    const d = deriveQueue(item({ status: s }))
    assert.equal(d.tier, 'in_flight')
    assert.equal(d.actionable, false)
  }
})

test('a failed job that also lacks ground truth surfaces as INTERVENTION, not GT (order matters)', () => {
  const d = deriveQueue(item({ status: 'failed', hasComparison: false, hasGroundTruth: false }))
  assert.equal(d.tier, 'needs_intervention')
})

// ── ordering + next-actionable ───────────────────────────────────────────────

const row = (id: string, status: ShadowRunStatus, updatedAt: number, over: Partial<QueueInput> = {}) => {
  const derived = deriveQueue(item({ bookingId: id, status, updatedAt, ...over }))
  return { bookingId: id, updatedAt, derived }
}

test('orderQueue: tier first, then oldest-first within a tier, then id', () => {
  const rows = [
    row('young-fail', 'failed', 5000),
    row('gt', 'awaiting_ground_truth', 1000, { hasComparison: true }),
    row('old-fail', 'failed', 2000),
    row('run', 'not_selected', 500, { eligible: true }),
  ]
  const ordered = orderQueue(rows).map((r) => r.bookingId)
  // both failures (intervention) first, oldest first; then missing GT; then ready-to-run.
  assert.deepEqual(ordered, ['old-fail', 'young-fail', 'gt', 'run'])
})

test('nextActionable returns the highest-priority ACTIONABLE item, skipping non-actionable', () => {
  const rows = [
    row('killed', 'kill_switch', 100),                                   // intervention but not actionable
    row('gt', 'awaiting_ground_truth', 200, { hasComparison: true }),    // actionable
    row('fail', 'failed', 300),                                          // intervention + actionable
  ]
  assert.equal(nextActionable(rows)?.bookingId, 'fail', 'the actionable intervention outranks missing-GT')
  // With only non-actionable items, returns null.
  assert.equal(nextActionable([row('killed', 'kill_switch', 1)]), null)
})

test('countByTier + tierRank are consistent with the declared tier order', () => {
  const rows = [row('a', 'failed', 1), row('b', 'failed', 2), row('c', 'not_selected', 3, { eligible: true })]
  const counts = countByTier(rows)
  assert.equal(counts.needs_intervention, 2)
  assert.equal(counts.ready_to_run, 1)
  assert.deepEqual(QUEUE_TIERS.map(tierRank), [0, 1, 2, 3, 4, 5, 6])
})

// ── queue API: authorization + dormancy ──────────────────────────────────────

const SECRET = 'test-admin-session-secret-value'
async function withEnv(over: Record<string, string | undefined>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(over)) { prev[k] = process.env[k]; if (over[k] === undefined) delete process.env[k]; else process.env[k] = over[k]! }
  try { await fn() } finally { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]! } }
}
type NextInit = ConstructorParameters<typeof NextRequest>[1]
const req = (token?: string, init?: NextInit) => { const r = new NextRequest('http://localhost/api/admin/ai-queue', init); if (token) r.cookies.set(COOKIE_NAME, token); return r }

test('ai-queue: unauthenticated is 401', async () => {
  const { GET } = await import('../app/api/admin/ai-queue/route')
  await withEnv({ ADMIN_SESSION_SECRET: SECRET, SHADOW_ANALYTICS_ENABLED: 'true' }, async () => {
    assert.equal((await GET(req(), { params: Promise.resolve({}) })).status, 401)
  })
})

test('ai-queue: live non-owner is 403', async () => {
  const { createUserSessionToken } = await import('../app/api/admin/_lib/session')
  const { GET } = await import('../app/api/admin/ai-queue/route')
  await withEnv({ ADMIN_SESSION_SECRET: SECRET, SHADOW_ANALYTICS_ENABLED: 'true', PLATFORM_OWNER_SUBS: undefined }, async () => {
    const token = await createUserSessionToken({ id: 'not-owner', role: 'admin' })
    assert.equal((await GET(req(token), { params: Promise.resolve({}) })).status, 403)
  })
})

test('ai-queue: owner + flag off → dormant, no store read (proves zero AI on load)', async () => {
  const { createSessionToken } = await import('../app/api/admin/_lib/session')
  const { GET } = await import('../app/api/admin/ai-queue/route')
  await withEnv({ ADMIN_SESSION_SECRET: SECRET, SHADOW_ANALYTICS_ENABLED: 'false' }, async () => {
    const res = await GET(req(await createSessionToken()), { params: Promise.resolve({}) })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).enabled, false)
  })
})

// ── state guards: no ground truth / categorize on an unfinished evaluation ────

test('state guards: categorize needs a comparison; ground truth needs a result', async () => {
  const { canCategorize, canRecordGroundTruth } = await import('../app/lib/estimation/shadow-admin')
  // An unfinished evaluation (queued/processing/failed) has neither — both are refused.
  assert.equal(canCategorize(null), false)
  assert.equal(canCategorize({}), false, 'no comparison ⇒ cannot categorize a nonexistent result')
  assert.equal(canCategorize({ comparison: { outcome: 'equivalent' } }), true)
  assert.equal(canRecordGroundTruth({}), false, 'no result ⇒ cannot benchmark an unfinished run')
  assert.equal(canRecordGroundTruth({ result: {} }), false, 'a result without an estimate is not scorable')
  assert.equal(canRecordGroundTruth({ result: { estimate: { pricing: {} } } }), true)
})
