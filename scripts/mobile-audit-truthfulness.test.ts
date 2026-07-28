// The mobile audit must never claim a route passed unless it PROVED the intended
// page rendered.
//
// The defect these tests pin: `classifyCheck` only ever asked "did the layout hold?"
// — and a blank page, a sign-in screen, a redirect and a permanent loading skeleton
// all have perfect layout. With ADMIN_PASSWORD unset, `maybeAuth` returned false and
// the run CONTINUED, so ~20 /admin/* routes × 9 viewports were measured against the
// sign-in screen and reported `ok`. Reproduce the old behaviour with:
//   PW_EXE=<chrome-headless-shell> npm run audit:mobile -- --base http://127.0.0.1:3111
// (no ADMIN_PASSWORD) — every admin route used to come back clean.
import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyRoute, summarizeRoutes, MIN_BODY_TEXT, ROUTE_BLOCKED_OUTCOMES } from './mobile-audit-classify.mjs'

type Outcome = 'PASS' | 'FAIL' | 'BLOCKED_AUTH' | 'BLOCKED_ENV' | 'ROUTE_ERROR' | 'INCONCLUSIVE'
type Result = { outcome: Outcome; detail: string }

// A fully-rendered, authenticated admin page that fits its viewport.
type RouteInput = Parameters<typeof classifyRoute>[0]
const goodAdmin = (over: Partial<RouteInput> = {}): RouteInput => ({
  requestedPath: '/admin/operations/timesheets', finalPath: '/admin/operations/timesheets',
  requiresAuth: true, authState: 'ok' as const,
  httpStatus: 200, bodyTextLength: 900,
  hasLoginForm: false, hasErrorBoundary: false, skeletonStillVisible: false,
  readinessSelector: 'h1', readinessFound: true,
  scrollWidth: 390, clientWidth: 390, offenders: [], clipped: [],
  ...over,
})

// ── The pass case has to still pass ──────────────────────────────────────────

test('an authenticated, populated admin page passes', () => {
  const { outcome } = classifyRoute(goodAdmin()) as Result
  assert.equal(outcome, 'PASS')
})

test('real content with an INTERNAL horizontal scroll rail still passes', () => {
  // The Timesheets table scrolls inside its own container by design; the page does
  // not. That must remain a pass, or the audit would punish a deliberate pattern.
  const { outcome } = classifyRoute(goodAdmin({
    scrollWidth: 390, clientWidth: 390, clipped: [],
  })) as Result
  assert.equal(outcome, 'PASS')
})

// ── The states that used to pass and must not ────────────────────────────────

test('a blank client shell FAILS instead of passing on perfect layout', () => {
  const r = classifyRoute(goodAdmin({ bodyTextLength: 0, readinessFound: false })) as Result
  assert.equal(r.outcome, 'FAIL')
  assert.match(r.detail, /blank|empty/i)
})

test('a near-empty body below the minimum FAILS', () => {
  const r = classifyRoute(goodAdmin({ bodyTextLength: MIN_BODY_TEXT - 1 })) as Result
  assert.equal(r.outcome, 'FAIL')
})

test('an admin route with no session is BLOCKED_AUTH — never PASS', () => {
  for (const authState of ['absent', 'failed'] as const) {
    const r = classifyRoute(goodAdmin({ authState })) as Result
    assert.equal(r.outcome, 'BLOCKED_AUTH', `authState=${authState}`)
    assert.notEqual(r.outcome, 'PASS')
  }
})

test('rendering the sign-in screen on an admin route is BLOCKED_AUTH, never PASS', () => {
  const r = classifyRoute(goodAdmin({ hasLoginForm: true })) as Result
  assert.equal(r.outcome, 'BLOCKED_AUTH')
  assert.match(r.detail, /sign-in/i)
})

test('a redirect away from the requested route never passes', () => {
  const admin = classifyRoute(goodAdmin({ finalPath: '/admin' })) as Result
  assert.equal(admin.outcome, 'BLOCKED_AUTH')
  const pub = classifyRoute(goodAdmin({
    requiresAuth: false, authState: 'not_required',
    requestedPath: '/quote', finalPath: '/',
  })) as Result
  assert.equal(pub.outcome, 'FAIL')
  assert.match(pub.detail, /redirect/i)
})

test('an HTTP 200 error boundary FAILS', () => {
  const r = classifyRoute(goodAdmin({ hasErrorBoundary: true, httpStatus: 200 })) as Result
  assert.equal(r.outcome, 'FAIL')
  assert.match(r.detail, /error boundary/i)
})

test('a permanent loading skeleton FAILS', () => {
  const r = classifyRoute(goodAdmin({ skeletonStillVisible: true })) as Result
  assert.equal(r.outcome, 'FAIL')
  assert.match(r.detail, /skeleton/i)
})

test('a missing route-specific readiness assertion FAILS', () => {
  const r = classifyRoute(goodAdmin({ readinessSelector: 'table[data-timesheet]', readinessFound: false })) as Result
  assert.equal(r.outcome, 'FAIL')
  assert.match(r.detail, /readiness/i)
})

// ── Layout findings still work, on top of proven content ─────────────────────

test('page-level horizontal overflow FAILS', () => {
  const r = classifyRoute(goodAdmin({ scrollWidth: 520, clientWidth: 390, offenders: ['div.wide'] })) as Result
  assert.equal(r.outcome, 'FAIL')
  assert.match(r.detail, /scrollW=520/)
})

test('a hidden primary action FAILS where action visibility is required', () => {
  const r = classifyRoute(goodAdmin({
    requireActionSelector: 'button[data-edit-time]', actionVisible: false,
  })) as Result
  assert.equal(r.outcome, 'FAIL')
  assert.match(r.detail, /primary action/i)
})

test('an off-screen control is still a finding', () => {
  const r = classifyRoute(goodAdmin({ clipped: ['"Edit time" L=1131 R=1208'] })) as Result
  assert.equal(r.outcome, 'FAIL')
  assert.match(r.detail, /CLIPPED/)
})

// ── Environment / harness never becomes a pass ───────────────────────────────

test('an unreachable app is BLOCKED_ENV, never PASS', () => {
  const r = classifyRoute({ error: 'net::ERR_CONNECTION_REFUSED' }) as Result
  assert.equal(r.outcome, 'BLOCKED_ENV')
})

test('a navigation timeout is INCONCLUSIVE, not a UI finding and not a pass', () => {
  const r = classifyRoute({ error: 'page.goto: Timeout 20000ms exceeded' }) as Result
  assert.equal(r.outcome, 'INCONCLUSIVE')
})

test('an HTTP error is ROUTE_ERROR', () => {
  const r = classifyRoute(goodAdmin({ httpStatus: 500 })) as Result
  assert.equal(r.outcome, 'ROUTE_ERROR')
})

// ── The summary must not launder blocked results into passes ─────────────────

test('the summary never counts blocked or inconclusive routes as passed', () => {
  const s = summarizeRoutes([
    { outcome: 'PASS' }, { outcome: 'PASS' },
    { outcome: 'BLOCKED_AUTH' }, { outcome: 'BLOCKED_ENV' }, { outcome: 'INCONCLUSIVE' },
  ])
  assert.equal(s.passed, 2, 'only real passes are passes')
  assert.equal(s.blocked, 3)
  assert.equal(s.findings, 0)
  assert.equal(s.fullyMeasured, false)
  assert.equal(s.exitCode, 2, 'an unmeasured run must not exit clean')
})

test('a run where every admin route is blocked does NOT exit 0', () => {
  // This is the exact historical shape: public routes fine, admin routes never
  // authenticated. It used to print all-clean and exit 0.
  const results = [
    ...Array.from({ length: 9 }, () => ({ outcome: 'PASS' as Outcome })),
    ...Array.from({ length: 180 }, () => ({ outcome: 'BLOCKED_AUTH' as Outcome })),
  ]
  const s = summarizeRoutes(results)
  assert.equal(s.passed, 9)
  assert.equal(s.blocked, 180)
  assert.notEqual(s.exitCode, 0, 'must not report a clean run')
  assert.equal(s.exitCode, 2)
})

test('real findings exit 1 when nothing is blocked', () => {
  const s = summarizeRoutes([{ outcome: 'PASS' }, { outcome: 'FAIL' }, { outcome: 'ROUTE_ERROR' }])
  assert.equal(s.findings, 2)
  assert.equal(s.exitCode, 1)
  assert.equal(s.fullyMeasured, true)
})

test('a fully measured, fully passing run exits 0', () => {
  const s = summarizeRoutes(Array.from({ length: 20 }, () => ({ outcome: 'PASS' })))
  assert.equal(s.exitCode, 0)
  assert.equal(s.blocked, 0)
})

test('every blocked outcome is declared, so none can be silently treated as a finding', () => {
  assert.deepEqual([...ROUTE_BLOCKED_OUTCOMES].sort(), ['BLOCKED_AUTH', 'BLOCKED_ENV', 'INCONCLUSIVE'])
})
