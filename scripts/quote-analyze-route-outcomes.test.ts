// ── Every exit from /api/quote/analyze is named, and every one is recorded ──
//
// The outage this closes was invisible, not just broken. The route rejected every
// real browser at the bot check and returned BEFORE any funnel write, so
// `quote_analyze_started` read zero for five weeks and looked like an absence of
// traffic rather than a total failure. Nothing distinguished "we never read the
// photos" from "we read them and chose a human", either — both came back as a
// 200 whose only difference was the numbers inside it.
//
// Source-level guards: the route is a Next handler with a tenancy wrapper, BotID and
// Redis, and this repo runs `tsx --test` with no request harness — so these assert
// the wiring the way scripts/quote-confirmation-nav.test.ts asserts the wizard's.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { FUNNEL_EVENTS } from '../app/lib/analytics-events'

const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const ROUTE = src('../app/api/quote/analyze/route.ts')

/** The junk lane — everything after the moving-lane early return. */
const JUNK_LANE = ROUTE.slice(ROUTE.indexOf('// The full AI → monitor → pricing → critic chain'))

test('a bot rejection is recorded before it is returned', () => {
  const guard = ROUTE.slice(ROUTE.indexOf('if (await isBlockedBot())'), ROUTE.indexOf('const body = await req.json'))
  assert.match(guard, /recordFunnelEvent\('ai_analysis_blocked'/, 'the rejection rate must be observable')
  // Order matters: recording AFTER the return records nothing at all.
  assert.ok(
    guard.indexOf("recordFunnelEvent('ai_analysis_blocked'") < guard.indexOf('status: 403'),
    'the funnel write must precede the response',
  )
})

test('the customer is told nothing about why they were blocked', () => {
  const guard = ROUTE.slice(ROUTE.indexOf('if (await isBlockedBot())'), ROUTE.indexOf('const body = await req.json'))
  // Observability for us must not become a probing oracle for a bot.
  for (const leak of ['botid', 'BotID', 'isBot', 'confidence', 'score']) {
    const body = guard.slice(guard.indexOf('NextResponse.json'))
    assert.ok(!body.includes(leak), `the 403 body must not disclose "${leak}"`)
  }
})

test('both new funnel events are registered in the runtime list', () => {
  // A FunnelEvent that is only in the union type is not persisted by getFunnel.
  for (const e of ['ai_analysis_blocked', 'ai_analysis_deduped'] as const) {
    assert.ok(FUNNEL_EVENTS.includes(e), `${e} must be in FUNNEL_EVENTS, not just the type`)
  }
})

test('every junk-lane exit carries a stable machine-readable outcome', () => {
  for (const outcome of ['analysis_complete', 'analysis_pending', 'analysis_timeout', 'analysis_failed', 'manual_review']) {
    assert.ok(JUNK_LANE.includes(`'${outcome}'`), `${outcome} is a declared outcome`)
  }
})

test('a timeout is distinguishable from a considered manual review', () => {
  // These mean different things operationally: the first owes a durable retry, the
  // second does not. Collapsing them is how a silent failure stays silent.
  assert.match(
    JUNK_LANE,
    /!analyzedOk[\s\S]{0,120}degraded \? 'analysis_timeout' : 'analysis_failed'/,
    'a failed read reports WHY it failed',
  )
  assert.match(JUNK_LANE, /decision === 'manual_review' \? 'manual_review'/)
})

test('the analysis is claimed before the provider is called', () => {
  const claimAt = JUNK_LANE.indexOf('claimAnalysis(')
  const buildAt = JUNK_LANE.indexOf('buildPhotoEstimate(')
  assert.ok(claimAt > -1 && buildAt > -1)
  assert.ok(claimAt < buildAt, 'claiming AFTER the call would be paying first and asking later')
})

test('a pending duplicate returns without calling the provider', () => {
  const pending = JUNK_LANE.slice(JUNK_LANE.indexOf("claim.state === 'pending'"), JUNK_LANE.indexOf('const budget ='))
  assert.match(pending, /outcome: 'analysis_pending'/)
  assert.match(pending, /recordFunnelEvent\('ai_analysis_deduped'/, 'suppressed duplicates are counted')
  assert.ok(!pending.includes('buildPhotoEstimate'), 'the whole point is that no analysis runs here')
})

test('a completed duplicate serves the stored draft instead of re-analysing', () => {
  const done = JUNK_LANE.slice(JUNK_LANE.indexOf("claim.state === 'done'"), JUNK_LANE.indexOf("claim.state === 'pending'"))
  assert.match(done, /getDraftEstimate\(/)
  assert.ok(!done.includes('buildPhotoEstimate'), 'a cached answer costs nothing')
})

test('success records the claim, failure releases it', () => {
  assert.match(
    JUNK_LANE,
    /if \(analyzedOk\) await completeAnalysis\([\s\S]{0,60}else await releaseAnalysis\(/,
    'caching a failure would lock the customer out of their own retry for the done-TTL',
  )
})

test('the draft is persisted so a refresh or a retry never loses the request', () => {
  assert.match(JUNK_LANE, /saveDraftEstimate\(stored\)/)
})

test('the route still bot-checks, rate-limits and validates its photo URLs', () => {
  // The fix registers the path with BotID; it must not have WEAKENED any gate.
  assert.match(ROUTE, /rateLimit\(req, 'quoteanalyze'/)
  assert.match(ROUTE, /isBlockedBot\(\)/)
  assert.match(ROUTE, /filterPhotoUrls\(body\.photos, 8\)/, 'only our own Blob URLs ever reach the model')
  assert.match(ROUTE, /SERVICE_TYPES\.includes\(body\.service\)/, 'the lane is never caller-selected')
})
