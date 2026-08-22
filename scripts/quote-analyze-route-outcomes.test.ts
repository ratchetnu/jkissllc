// ── Every exit from /api/quote/analyze is named, and every one is recorded ──
//
// The outage this closes was invisible, not just broken. The route rejected every
// real browser at the bot check and returned BEFORE any funnel write, so
// `quote_analyze_started` read zero for five weeks and looked like an absence of
// traffic rather than a total failure.
//
// SCOPE. The claim/persist/publish PROTOCOL is no longer asserted here — it moved to
// app/lib/ai/quote-analysis-lifecycle.ts precisely so it could be driven for real,
// and scripts/quote-analysis-lifecycle.test.ts executes it against a store emulator.
// What remains the route's own business is asserted below: the gates it must keep,
// the delegation it must perform, and the outcome vocabulary it must speak. These
// are source-level guards because this repo runs `tsx --test` with no request
// harness — the same approach as scripts/quote-confirmation-nav.test.ts.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { FUNNEL_EVENTS } from '../app/lib/analytics-events'

const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const ROUTE = src('../app/api/quote/analyze/route.ts')

/** The junk lane — everything after the moving-lane early return. */
const JUNK_LANE = ROUTE.slice(ROUTE.indexOf('// The full AI → monitor → pricing → critic chain'))
const BOT_GUARD = ROUTE.slice(ROUTE.indexOf('if (await isBlockedBot())'), ROUTE.indexOf('const body = await req.json'))

test('a bot rejection is recorded before it is returned', () => {
  assert.match(BOT_GUARD, /recordFunnelEvent\('ai_analysis_blocked'/, 'the rejection rate must be observable')
  assert.ok(
    BOT_GUARD.indexOf("recordFunnelEvent('ai_analysis_blocked'") < BOT_GUARD.indexOf('status: 403'),
    'the funnel write must precede the response — recording after the return records nothing',
  )
})

test('the customer is told nothing about why they were blocked', () => {
  // Observability for us must not become a probing oracle for a bot.
  const body = BOT_GUARD.slice(BOT_GUARD.indexOf('NextResponse.json'))
  for (const leak of ['botid', 'BotID', 'isBot', 'confidence', 'score']) {
    assert.ok(!body.includes(leak), `the 403 body must not disclose "${leak}"`)
  }
})

test('the new funnel events are registered in the runtime list', () => {
  // A FunnelEvent that exists only in the union type is never persisted by getFunnel.
  for (const e of ['ai_analysis_blocked', 'ai_analysis_deduped'] as const) {
    assert.ok(FUNNEL_EVENTS.includes(e), `${e} must be in FUNNEL_EVENTS, not just the type`)
  }
})

test('every junk-lane exit carries a stable machine-readable outcome', () => {
  for (const outcome of [
    'analysis_complete', 'analysis_pending', 'analysis_timeout',
    'analysis_budget_exhausted', 'analysis_output_truncated', 'analysis_failed', 'manual_review',
  ]) {
    assert.ok(JUNK_LANE.includes(`'${outcome}'`), `${outcome} is a declared outcome`)
  }
})

test('a skipped read, a timed-out read and a considered review are three different codes', () => {
  // They call for different operational responses: budget_exhausted spent nothing and
  // never called the provider; analysis_timeout did call and ran out of clock; a
  // manual_review actually read the photos. Collapsing them is how a silent failure
  // stays silent.
  assert.match(JUNK_LANE, /degraded === 'budget_exhausted' \? 'analysis_budget_exhausted'/)
  assert.match(JUNK_LANE, /degraded \? 'analysis_timeout'/)
  assert.match(JUNK_LANE, /analysisOutcome === 'output_truncated' \? 'analysis_output_truncated'/)
  assert.match(JUNK_LANE, /decision === 'manual_review' \? 'manual_review'/)
})

test('the route delegates ownership and ordering to the tested lifecycle', () => {
  // The route must not re-implement the claim protocol inline — that is what made it
  // untestable and let the publish-before-save ordering ship.
  assert.match(JUNK_LANE, /runAnalysisLifecycle\(/, 'the protocol is delegated')
  assert.ok(!JUNK_LANE.includes('completeAnalysis('), 'the route never publishes a marker itself')
  assert.ok(!JUNK_LANE.includes('releaseAnalysis('), 'the route never releases a claim itself')
  assert.ok(!JUNK_LANE.includes('discardStaleDone('), 'the route never retires a marker itself')
})

test('the provider call is reachable ONLY through the lifecycle', () => {
  // buildPhotoEstimate must sit inside the lifecycle's `analyze` callback, so it can
  // never run on a path that did not first win (or fail-open past) a claim.
  const lifecycleAt = JUNK_LANE.indexOf('runAnalysisLifecycle(')
  const buildAt = JUNK_LANE.indexOf('buildPhotoEstimate(')
  assert.ok(lifecycleAt > -1 && buildAt > lifecycleAt, 'the paid call is nested inside the lifecycle')
})

test('the reuse and pending branches answer without analysing', () => {
  const reuse = JUNK_LANE.slice(JUNK_LANE.indexOf("lifecycle.kind === 'reused'"), JUNK_LANE.indexOf("lifecycle.kind === 'pending'"))
  assert.match(reuse, /outcome: 'analysis_complete', reused: true/)
  assert.match(reuse, /recordFunnelEvent\('ai_analysis_deduped'/, 'suppressed duplicates are counted')
  const pending = JUNK_LANE.slice(JUNK_LANE.indexOf("lifecycle.kind === 'pending'"))
  assert.match(pending.slice(0, 600), /outcome: 'analysis_pending'/)
})

test('the route still bot-checks, rate-limits and validates its inputs', () => {
  // The fix registers the path with BotID; it must not have WEAKENED any gate.
  assert.match(ROUTE, /rateLimit\(req, 'quoteanalyze'/)
  assert.match(ROUTE, /isBlockedBot\(\)/)
  assert.match(ROUTE, /filterPhotoUrls\(body\.photos, 8\)/, 'only our own Blob URLs ever reach the model')
  assert.match(ROUTE, /SERVICE_TYPES\.includes\(body\.service\)/, 'the lane is never caller-selected')
})

test('no raw photo URL is written into a funnel event', () => {
  // Funnel writes carry an event name and a timestamp — never customer material.
  for (const m of ROUTE.matchAll(/recordFunnelEvent\(([^)]*)\)/g)) {
    assert.ok(!/photos|photoUrls|body\./.test(m[1]), `funnel call must carry no request data: ${m[1]}`)
  }
})
