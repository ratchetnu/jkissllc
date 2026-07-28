// Wave 3: the audit must stop passing pages that render correctly and load nothing.
//
// After Waves 1–2 the audit proved authentication, the final route, route-specific
// shell content and responsive layout — and still reported PASS for six route×role
// combinations whose required request returned 403:
//
//   admin   /admin/operations/ai              /api/admin/ai-overview    → 403
//   admin   /admin/operations/ai/performance  /api/admin/shadow-learning→ 403
//   admin   /admin/operations/ai/learning     /api/admin/shadow-learning→ 403
//   admin   /admin/operations/ai/alerts       /api/admin/ai-alerts      → 403
//   manager /admin/operations/businesses      /api/admin/route-invoices → 403
//   manager /admin/operations/release         /api/admin/release        → 403
//
// Correct heading, correct URL, perfect layout, empty page. `PASS` meant "the layout
// held", never "the page works".
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { classifyRoute, summarizeRoutes } from './mobile-audit-classify.mjs'
import {
  redactMessage, summarizeRuntimeSignals, evaluateRequests,
  isApplicationRequest, isHydrationMessage, isAllowlistedNoise, isNetworkEcho,
  CONSOLE_NOISE_ALLOWLIST, MAX_MESSAGE_LENGTH,
} from './mobile-audit-runtime-signals.mjs'

type Outcome = 'PASS' | 'FAIL' | 'BLOCKED_AUTH' | 'BLOCKED_ENV' | 'ROUTE_ERROR' | 'INCONCLUSIVE'
type Result = { outcome: Outcome; detail: string; state: string | null }
type RouteInput = Parameters<typeof classifyRoute>[0]
const cls = (i: RouteInput) => classifyRoute(i) as Result

/** A page that is authenticated, on-route, rendered and correctly laid out. */
const good = (over: Partial<RouteInput> = {}): RouteInput => ({
  requestedPath: '/admin/operations/ai', finalPath: '/admin/operations/ai',
  requiredRole: 'admin', activeRole: 'admin', authState: 'ok',
  httpStatus: 200, bodyTextLength: 900,
  readinessSelector: 'h1', readinessFound: true,
  scrollWidth: 390, clientWidth: 390,
  ...over,
})

// ── Console capture ──────────────────────────────────────────────────────────

test('a console error prevents PASS', () => {
  const r = cls(good({ consoleErrors: ['TypeError: undefined is not a function'] }))
  assert.equal(r.outcome, 'FAIL')
  assert.equal(r.state, 'runtime')
  assert.match(r.detail, /console error/)
})

test('an unknown console error is preserved verbatim in the finding', () => {
  const r = cls(good({ consoleErrors: ['Something nobody has explained yet'] }))
  assert.equal(r.outcome, 'FAIL')
  assert.match(r.detail, /Something nobody has explained yet/)
})

test('an allowlisted harmless message does not fail the route', () => {
  const { consoleErrors, ignored } = summarizeRuntimeSignals({
    consoleErrors: ['Failed to load resource: /favicon.ico 404 (Not Found)'],
  })
  assert.deepEqual(consoleErrors, [])
  assert.equal(ignored.length, 1)
  assert.equal(cls(good({ consoleErrors })).outcome, 'PASS')
})

test('the noise allowlist stays narrow and every entry explains itself', () => {
  assert.ok(CONSOLE_NOISE_ALLOWLIST.length <= 5, 'allowlist must stay small')
  for (const e of CONSOLE_NOISE_ALLOWLIST) {
    assert.ok(e.why && e.why.length > 5, 'every allowlist entry needs a reason')
  }
  // The default is "this matters".
  assert.equal(isAllowlistedNoise('Uncaught TypeError: x is not a function'), false)
  assert.equal(isAllowlistedNoise('Failed to load resource: 403 (Forbidden)'), false)
})

test("Chrome's generic resource-failure echo is owned by the network layer, not the console", () => {
  // The text names no URL, so the console cannot tell whether the endpoint mattered.
  // Judging it here would sentence the same failure twice, the second time blind.
  const { consoleErrors, networkEchoes } = summarizeRuntimeSignals({
    consoleErrors: ['Failed to load resource: the server responded with a status of 429 ()'],
  })
  assert.deepEqual(consoleErrors, [])
  assert.equal(networkEchoes.length, 1, 'still reported, just not independently disqualifying')
  assert.equal(cls(good({ consoleErrors })).outcome, 'PASS')
})

test('a required endpoint failure still fails even though its console echo does not', () => {
  const ev = evaluateRequests([{ path: '/api/admin/ai-overview', method: 'GET', status: 403 }], ['/api/admin/ai-overview'])
  const { consoleErrors } = summarizeRuntimeSignals({
    consoleErrors: ['Failed to load resource: the server responded with a status of 403 ()'],
  })
  assert.deepEqual(consoleErrors, [], 'the echo alone is not the mechanism')
  const r = cls(good({ ...ev, consoleErrors }))
  assert.equal(r.outcome, 'FAIL')
  assert.equal(r.state, 'data', 'the network contract is what fails it')
})

test('a real application console error still fails, echoes notwithstanding', () => {
  const { consoleErrors } = summarizeRuntimeSignals({
    consoleErrors: [
      'Failed to load resource: the server responded with a status of 404 ()',
      "TypeError: Cannot read properties of null (reading 'id')",
    ],
  })
  assert.equal(consoleErrors.length, 1)
  assert.match(consoleErrors[0], /TypeError/)
  assert.equal(cls(good({ consoleErrors })).outcome, 'FAIL')
})

test('duplicate messages are de-duplicated', () => {
  // One failing fetch in a render loop emits the same line hundreds of times. A report
  // that repeats it hundreds of times is unreadable without being any more true.
  const { consoleErrors } = summarizeRuntimeSignals({
    consoleErrors: Array(50).fill("TypeError: Cannot read properties of null (reading 'id')"),
  })
  assert.equal(consoleErrors.length, 1)

  const { networkEchoes } = summarizeRuntimeSignals({
    consoleErrors: Array(50).fill('Failed to load resource: the server responded with a status of 403'),
  })
  assert.equal(networkEchoes.length, 1, 'echoes are de-duplicated too')
  assert.equal(isNetworkEcho('Failed to load resource: the server responded with a status of 403'), true)
})

test('a console message echoing a page error is not counted twice', () => {
  const { consoleErrors, pageErrors } = summarizeRuntimeSignals({
    pageErrors: ['Boom'], consoleErrors: ['Boom'],
  })
  assert.deepEqual(pageErrors, ['Boom'])
  assert.deepEqual(consoleErrors, [])
})

// ── Redaction ────────────────────────────────────────────────────────────────

test('secret-like values are redacted before storage', () => {
  const cases = [
    'Authorization: Bearer abcdefghijklmnop',
    'cookie=jk_admin_session=supersecretvalue123',
    'x-vercel-protection-bypass: 0123456789abcdef0123456789abcdef',
    'token: "eyJhbGciOi.eyJzdWIiOm.SflKxwRJSM"',
    'fetch https://user:hunter2@example.com/x failed',
    'password=hunter2',
  ]
  for (const c of cases) {
    const out = redactMessage(c)
    for (const leak of ['abcdefghijklmnop', 'supersecretvalue123', '0123456789abcdef0123456789abcdef', 'hunter2']) {
      assert.ok(!out.includes(leak), `redaction leaked "${leak}" from: ${c}\n  → ${out}`)
    }
  }
})

test('a long response body is truncated rather than stored whole', () => {
  const out = redactMessage('x'.repeat(5000))
  assert.ok(out.length <= MAX_MESSAGE_LENGTH + 20)
  assert.match(out, /truncated/)
})

test('redaction survives the full signal pipeline', () => {
  const { consoleErrors } = summarizeRuntimeSignals({ consoleErrors: ['Authorization: Bearer abcdefghijklmnop'] })
  assert.ok(!consoleErrors[0].includes('abcdefghijklmnop'))
})

// ── Page errors ──────────────────────────────────────────────────────────────

test('an uncaught page error prevents PASS even when layout measured fine', () => {
  const r = cls(good({ pageErrors: ["Cannot read properties of undefined (reading 'map')"] }))
  assert.equal(r.outcome, 'FAIL')
  assert.equal(r.state, 'runtime')
  assert.match(r.detail, /uncaught page error/)
})

test('an unhandled promise rejection prevents PASS', () => {
  assert.equal(cls(good({ pageErrors: ['Unhandled promise rejection: fetch failed'] })).outcome, 'FAIL')
})

test('a browser/process failure is ROUTE_ERROR, not a content finding', () => {
  const r = cls(good({ pageErrors: ['Page crashed'] }))
  assert.equal(r.outcome, 'ROUTE_ERROR')
  assert.match(r.detail, /browser\/process failure/)
})

// ── Hydration ────────────────────────────────────────────────────────────────

test('a hydration mismatch prevents PASS and is reported as hydration', () => {
  const { hydrationErrors, consoleErrors } = summarizeRuntimeSignals({
    consoleErrors: ['Warning: Text content did not match. Server: "A" Client: "B"'],
  })
  assert.equal(hydrationErrors.length, 1)
  assert.equal(consoleErrors.length, 0, 'hydration is classified separately, not double-counted')
  const r = cls(good({ hydrationErrors }))
  assert.equal(r.outcome, 'FAIL')
  assert.match(r.detail, /hydration failure/)
})

test('hydration detection recognises the common React phrasings', () => {
  for (const m of [
    'Hydration failed because the initial UI does not match',
    'Text content does not match server-rendered HTML',
    'An error occurred during hydration. The server HTML was replaced',
  ]) assert.equal(isHydrationMessage(m), true, m)
})

test('slow data is NOT reported as a hydration failure', () => {
  // An unresolved skeleton is its own outcome and keeps its own reason.
  const r = cls(good({ skeletonStillVisible: true }))
  assert.equal(r.outcome, 'FAIL')
  assert.match(r.detail, /skeleton never resolved/)
  assert.doesNotMatch(r.detail, /hydration/)
  assert.equal(isHydrationMessage('Failed to load resource: 500'), false)
})

// ── Network / data contract ──────────────────────────────────────────────────

test('only same-origin application requests are considered', () => {
  const B = 'https://jkissllc-abc123xyz-team.vercel.app'
  assert.equal(isApplicationRequest(`${B}/api/admin/ai-overview`, B), true)
  assert.equal(isApplicationRequest('https://fonts.googleapis.com/css2?x', B), false)
  assert.equal(isApplicationRequest(`${B}/_next/static/chunk.js`, B), false)
  assert.equal(isApplicationRequest(`${B}/logo.png`, B), false)
})

test('a required endpoint returning 403 prevents PASS', () => {
  const { requiredFailures } = evaluateRequests(
    [{ path: '/api/admin/ai-overview', method: 'GET', status: 403 }],
    ['/api/admin/ai-overview'],
  )
  assert.deepEqual(requiredFailures, ['GET /api/admin/ai-overview → 403'])
  const r = cls(good({ requiredFailures }))
  assert.equal(r.outcome, 'FAIL')
  assert.equal(r.state, 'data')
  assert.match(r.detail, /required data request failed/)
})

test('a required endpoint returning 500 prevents PASS', () => {
  const { requiredFailures } = evaluateRequests(
    [{ path: '/api/admin/release', method: 'GET', status: 500 }], ['/api/admin/release'],
  )
  assert.equal(cls(good({ requiredFailures })).outcome, 'FAIL')
})

test('a required endpoint that was never called prevents PASS', () => {
  const { missingRequired } = evaluateRequests([], ['/api/admin/ai-overview'])
  assert.deepEqual(missingRequired, ['/api/admin/ai-overview'])
  const r = cls(good({ missingRequired }))
  assert.equal(r.outcome, 'FAIL')
  assert.match(r.detail, /never made/)
})

test('a required endpoint returning 200 plus a loaded state can PASS', () => {
  const ev = evaluateRequests([{ path: '/api/admin/ai-overview', method: 'GET', status: 200 }], ['/api/admin/ai-overview'])
  const r = cls(good({ ...ev, dataLoadedText: 'Requests today', dataLoadedFound: true }))
  assert.equal(r.outcome, 'PASS')
  assert.equal(r.state, 'content')
})

test('query strings and sub-paths still match a declared required endpoint', () => {
  const ev = evaluateRequests(
    [{ path: '/api/admin/shadow-learning', method: 'GET', status: 403 }],
    ['/api/admin/shadow-learning'],
  )
  assert.equal(ev.requiredFailures.length, 1)
  const sub = evaluateRequests(
    [{ path: '/api/admin/release/businesses', method: 'GET', status: 403 }], ['/api/admin/release'],
  )
  assert.equal(sub.requiredFailures.length, 1)
  assert.equal(sub.missingRequired.length, 0)
})

test('an optional background failure is reported but does not fail the route', () => {
  const ev = evaluateRequests(
    [
      { path: '/api/admin/ai-overview', method: 'GET', status: 200 },
      { path: '/api/analytics/beacon', method: 'POST', status: 500 },
    ],
    ['/api/admin/ai-overview'],
  )
  assert.deepEqual(ev.requiredFailures, [])
  assert.deepEqual(ev.otherFailures, ['POST /api/analytics/beacon → 500'])
  assert.equal(cls(good(ev)).outcome, 'PASS', 'a flaky beacon must not become a false FAIL')
})

test('duplicate request failures are de-duplicated', () => {
  const ev = evaluateRequests(
    Array(20).fill({ path: '/api/admin/ai-overview', method: 'GET', status: 403 }),
    ['/api/admin/ai-overview'],
  )
  assert.equal(ev.requiredFailures.length, 1)
})

// ── Empty vs unresolved vs denial ────────────────────────────────────────────

test('a valid explicit EMPTY state can PASS and is recorded as empty', () => {
  const r = cls(good({
    dataLoadedText: 'Total requests', dataLoadedFound: false,
    dataEmptyText: 'No activity yet', dataEmptyFound: true,
  }))
  assert.equal(r.outcome, 'PASS')
  assert.equal(r.state, 'empty')
})

test('neither populated nor empty is a data failure, not a pass', () => {
  const r = cls(good({
    dataLoadedText: 'Total requests', dataLoadedFound: false,
    dataEmptyText: 'No activity yet', dataEmptyFound: false,
  }))
  assert.equal(r.outcome, 'FAIL')
  assert.equal(r.state, 'data')
  assert.match(r.detail, /data never resolved/)
})

test('an unresolved skeleton still fails', () => {
  assert.equal(cls(good({ skeletonStillVisible: true })).outcome, 'FAIL')
})

test('an expected denial is exempt from the data contract but not from runtime errors', () => {
  const denial = (over: Partial<RouteInput> = {}) => cls(good({
    requestedPath: '/admin/operations/pay-statements', finalPath: '/admin/operations/pay-statements',
    activeRole: 'manager', bodyTextLength: 200,
    readinessSelector: null, readinessFound: null,
    expectedDenial: true,
    denialText: 'Pay statements are restricted to administrators', denialTextFound: true,
    requiredFailures: ['GET /api/admin/pay-statements → 403'],
    ...over,
  }))
  // Being refused IS the contract — the 403 that produced the card cannot fail it.
  assert.equal(denial().outcome, 'PASS')
  assert.equal(denial().state, 'denial')
  // But a denial page that throws is still broken.
  assert.equal(denial({ pageErrors: ['Boom'] }).outcome, 'FAIL')
})

test('a denial API response without the rendered denial UI cannot PASS', () => {
  const r = cls(good({
    activeRole: 'manager', expectedDenial: true,
    denialText: 'Pay statements are restricted to administrators', denialTextFound: false,
  }))
  assert.equal(r.outcome, 'FAIL')
})

// ── The six known false-PASS cases ───────────────────────────────────────────

const KNOWN = [
  { path: '/admin/operations/ai', role: 'admin', endpoint: '/api/admin/ai-overview' },
  { path: '/admin/operations/ai/performance', role: 'admin', endpoint: '/api/admin/shadow-learning' },
  { path: '/admin/operations/ai/learning', role: 'admin', endpoint: '/api/admin/shadow-learning' },
  { path: '/admin/operations/ai/alerts', role: 'admin', endpoint: '/api/admin/ai-alerts' },
  { path: '/admin/operations/businesses', role: 'manager', endpoint: '/api/admin/route-invoices' },
  { path: '/admin/operations/release', role: 'manager', endpoint: '/api/admin/release' },
] as const

for (const c of KNOWN) {
  test(`${c.role} ${c.path} no longer PASSes on a silent ${c.endpoint} 403`, () => {
    const ev = evaluateRequests([{ path: c.endpoint, method: 'GET', status: 403 }], [c.endpoint])
    const r = cls(good({
      requestedPath: c.path, finalPath: c.path, activeRole: c.role,
      ...ev,
    }))
    assert.notEqual(r.outcome, 'PASS', 'this is the exact false PASS Wave 3 exists to remove')
    assert.equal(r.outcome, 'FAIL')
    assert.equal(r.state, 'data')
    assert.match(r.detail, new RegExp(c.endpoint.replace(/\//g, '\\/')))
  })
}

// ── The route table actually declares those contracts ────────────────────────

const AUDIT_SRC = readFileSync(new URL('./mobile-overflow-audit.mjs', import.meta.url), 'utf8')

test('every known false-PASS route declares its required endpoint', () => {
  for (const c of KNOWN) {
    const block = AUDIT_SRC.slice(AUDIT_SRC.indexOf(`path: '${c.path}'`))
    const entry = block.slice(0, block.indexOf('},') + 2)
    assert.match(entry, /data: \{ required:/, `${c.path} must declare a data contract`)
    assert.ok(entry.includes(c.endpoint), `${c.path} must declare ${c.endpoint}`)
  }
})

test('listeners are attached before navigation, not after', () => {
  const listenIdx = AUDIT_SRC.indexOf("page.on('pageerror'")
  const gotoIdx = AUDIT_SRC.indexOf('await page.goto(BASE + path')
  assert.ok(listenIdx > 0 && gotoIdx > 0)
  assert.ok(listenIdx < gotoIdx, 'errors thrown during the render under test would otherwise be missed')
})

test('listeners are detached after every check so signals cannot bleed across routes', () => {
  assert.match(AUDIT_SRC, /page\.off\('pageerror', onPageError\)/)
  assert.match(AUDIT_SRC, /page\.off\('response', onResponse\)/)
})

// ── Regression: Waves 1–2 behaviour is unchanged ─────────────────────────────

test('a clean page with no runtime signals still PASSes', () => {
  assert.equal(cls(good()).outcome, 'PASS')
  assert.equal(cls(good({ consoleErrors: [], pageErrors: [], hydrationErrors: [] })).outcome, 'PASS')
})

test('blocked, inconclusive and error results never count as PASS', () => {
  const { counts, passed, exitCode } = summarizeRoutes([
    { outcome: 'BLOCKED_AUTH' }, { outcome: 'BLOCKED_ENV' },
    { outcome: 'INCONCLUSIVE' }, { outcome: 'ROUTE_ERROR' }, { outcome: 'FAIL' },
  ])
  assert.equal(passed, 0)
  assert.equal(counts.PASS, 0)
  assert.equal(exitCode, 2)
})

test('the auth contract still outranks the data contract', () => {
  // A crew principal on an admin route is blocked, not reported as a data failure.
  const r = cls(good({ activeRole: 'crew', requiredFailures: ['GET /api/admin/ai-overview → 403'] }))
  assert.equal(r.outcome, 'BLOCKED_AUTH')
})

test('an HTTP error on the document still outranks runtime signals', () => {
  const r = cls(good({ httpStatus: 500, pageErrors: ['Boom'] }))
  assert.equal(r.outcome, 'ROUTE_ERROR')
  assert.match(r.detail, /HTTP 500/)
})
