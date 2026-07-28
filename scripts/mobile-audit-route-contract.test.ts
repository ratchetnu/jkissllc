// Wave 2 of the mobile-audit remediation: the route table and the redirect classifier.
//
// The 2026-07-27 audit produced 90 FAIL results that were not defects and 18
// BLOCKED_AUTH results that were not missing sessions. Every one traced to the audit
// describing the app incorrectly, not the app misbehaving:
//
//   36  /opspilot                     a next.config.ts permanent redirect to /operion
//   18  /admin/operations/ai/shadow   that page's own redirect to /ai/performance
//   27  /portal                       a crew login gate declared `auth: 'none'`
//   18  /admin/disposal               `ready: 'h1'` on a page with no <h1>
//    9  pay-statements (manager)      the correct "Admins only" card has no <h1>
//
// These tests pin each correction so the noise cannot come back — and, just as
// importantly, pin that none of them turned into a false PASS.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  classifyRoute, summarizeRoutes, roleSatisfiesRoute,
  isRedirectLoopError, ROUTE_ROLE_MATRIX,
} from './mobile-audit-classify.mjs'

type Outcome = 'PASS' | 'FAIL' | 'BLOCKED_AUTH' | 'BLOCKED_ENV' | 'ROUTE_ERROR' | 'INCONCLUSIVE'
type Result = { outcome: Outcome; detail: string; state: 'content' | 'denial' | null }
type RouteInput = Parameters<typeof classifyRoute>[0]

const cls = (i: RouteInput) => classifyRoute(i) as Result

// ── The audit's own route table, read as data ────────────────────────────────
// Parsed rather than imported: importing the audit script would start an audit.

const AUDIT_SRC = readFileSync(new URL('./mobile-overflow-audit.mjs', import.meta.url), 'utf8')
const ROUTE_BLOCK = AUDIT_SRC.slice(AUDIT_SRC.indexOf('const ROUTES = ['), AUDIT_SRC.indexOf('\n]', AUDIT_SRC.indexOf('const ROUTES = [')))
const configuredPaths = [...ROUTE_BLOCK.matchAll(/\{\s*path:\s*'([^']+)'/g)].map((m) => m[1])
/** The FULL entry for a path — entries may wrap across lines. */
const routeEntry = (p: string) => {
  const lines = ROUTE_BLOCK.split('\n')
  const start = lines.findIndex((l) => l.includes(`path: '${p}'`))
  assert.ok(start >= 0, `route ${p} not found in the audit route table`)
  const collected = []
  for (let i = start; i < lines.length; i++) {
    collected.push(lines[i].trim())
    if (lines[i].trimEnd().endsWith('},')) break
  }
  return collected.join(' ')
}

// ── FIX 1 — legacy alias routes are not audited as independent pages ─────────

test('/opspilot is not audited: it is a permanent redirect whose destination is covered', () => {
  assert.ok(!configuredPaths.includes('/opspilot'), '/opspilot must not be in the route table')
  assert.ok(configuredPaths.includes('/operion'), '/operion must remain the canonical audited route')
})

test('/admin/operations/ai/shadow is not audited: it redirects to an already-covered route', () => {
  assert.ok(!configuredPaths.includes('/admin/operations/ai/shadow'))
  assert.ok(configuredPaths.includes('/admin/operations/ai/performance'))
})

test('no configured route is a duplicate of another', () => {
  assert.equal(new Set(configuredPaths).size, configuredPaths.length)
})

test('removing the aliases did not remove real coverage', () => {
  // Every page that previously had UNIQUE coverage still has an entry.
  for (const p of [
    '/', '/quote', '/track', '/operion', '/coi', '/portal',
    '/admin/operations', '/admin/operations/timesheets', '/admin/operations/finance',
    '/admin/operations/pay-statements', '/admin/operations/settings', '/admin/disposal',
    '/admin/operations/ai', '/admin/operations/ai/performance', '/admin/operations/ai/alerts',
  ]) {
    assert.ok(configuredPaths.includes(p), `${p} must still be audited`)
  }
})

// ── FIX 2 — /portal declares its real crew contract ──────────────────────────

test('/portal is configured as a crew route, not a public one', () => {
  assert.match(routeEntry('/portal'), /auth: 'crew'/)
})

test('anonymous at the /portal login gate is BLOCKED_AUTH, not FAIL', () => {
  const r = cls({ requestedPath: '/portal', requiredRole: 'crew', activeRole: 'anonymous', authState: 'absent' })
  assert.equal(r.outcome, 'BLOCKED_AUTH')
  assert.doesNotMatch(r.detail, /public route/)
})

test('a crew-authenticated /portal can PASS', () => {
  const r = cls({
    requestedPath: '/portal', finalPath: '/portal',
    requiredRole: 'crew', activeRole: 'crew', authState: 'ok',
    httpStatus: 200, bodyTextLength: 600,
    readinessSelector: 'h1', readinessFound: true,
    readinessText: 'Sign out', readinessTextFound: true,
    scrollWidth: 390, clientWidth: 390,
  })
  assert.equal(r.outcome, 'PASS')
  assert.equal(r.state, 'content')
})

test('an admin or manager is NOT silently treated as crew on /portal', () => {
  for (const role of ['admin', 'manager', 'owner'] as const) {
    const r = cls({ requestedPath: '/portal', requiredRole: 'crew', activeRole: role, authState: 'ok' })
    assert.equal(r.outcome, 'BLOCKED_AUTH', `${role} must not measure a crew route`)
    assert.match(r.detail, new RegExp(`signed in as ${role}`))
    assert.match(r.detail, /cannot reach a crew route/)
  }
})

test('a missing crew fixture is BLOCKED_AUTH — never PASS and never FAIL', () => {
  const r = cls({ requestedPath: '/portal', requiredRole: 'crew', activeRole: 'anonymous', authState: 'failed' })
  assert.equal(r.outcome, 'BLOCKED_AUTH')
  assert.match(r.detail, /not authenticated \(failed\)/)
})

test('the role matrix keeps crew and admin surfaces separate', () => {
  assert.deepEqual(ROUTE_ROLE_MATRIX.crew, ['crew'])
  assert.ok(!ROUTE_ROLE_MATRIX.admin.includes('crew'))
  assert.ok(ROUTE_ROLE_MATRIX.admin.includes('manager'), 'a manager legitimately browses admin surfaces')
  assert.equal(roleSatisfiesRoute('crew', 'admin'), false)
  assert.equal(roleSatisfiesRoute('admin', 'crew'), false)
  assert.equal(roleSatisfiesRoute('none', 'anonymous'), true)
})

test('HTTP 200 alone is never a success path for a gated route', () => {
  const r = cls({
    requestedPath: '/portal', finalPath: '/portal',
    requiredRole: 'crew', activeRole: 'crew', authState: 'ok',
    httpStatus: 200, bodyTextLength: 600,
    readinessSelector: 'h1', readinessFound: true,
    readinessText: 'Sign out', readinessTextFound: false,   // content never arrived
    scrollWidth: 390, clientWidth: 390,
  })
  assert.equal(r.outcome, 'FAIL')
  assert.match(r.detail, /expected content not rendered/)
})

// ── FIX 3 — /admin/disposal readiness ────────────────────────────────────────

test('/admin/disposal no longer asserts a non-existent h1', () => {
  const line = routeEntry('/admin/disposal')
  assert.doesNotMatch(line, /ready: 'h1'/)
  assert.match(line, /readyText: 'Disposal & Pricing'/)
  assert.match(line, /auth: 'admin'/, 'the route still requires a staff role')
})

const disposal = (over: Partial<RouteInput> = {}): RouteInput => ({
  requestedPath: '/admin/disposal', finalPath: '/admin/disposal',
  requiredRole: 'admin', activeRole: 'admin', authState: 'ok',
  httpStatus: 200, bodyTextLength: 900,
  readinessSelector: 'input, label', readinessFound: true,
  readinessText: 'Disposal & Pricing', readinessTextFound: true,
  scrollWidth: 390, clientWidth: 390,
  ...over,
})

test('a populated disposal page reaches ready state and passes', () => {
  assert.equal(cls(disposal()).outcome, 'PASS')
})

test('missing disposal content fails even though the shell rendered', () => {
  const r = cls(disposal({ readinessTextFound: false }))
  assert.equal(r.outcome, 'FAIL')
  assert.match(r.detail, /Disposal & Pricing/)
})

test('unrelated shell content cannot satisfy disposal readiness', () => {
  // The nav/header chrome is present on every admin page, so the structural selector
  // matches — only the route-specific text can tell the pages apart.
  const r = cls(disposal({ readinessFound: true, readinessTextFound: false, bodyTextLength: 4000 }))
  assert.equal(r.outcome, 'FAIL')
})

test('disposal still requires an authenticated staff role', () => {
  assert.equal(cls(disposal({ activeRole: 'anonymous', authState: 'absent' })).outcome, 'BLOCKED_AUTH')
  assert.equal(cls(disposal({ activeRole: 'crew', authState: 'ok' })).outcome, 'BLOCKED_AUTH')
})

// ── FIX 4 — pay-statements denial state ──────────────────────────────────────

test('pay-statements declares both an admin content assertion and a manager denial', () => {
  const line = routeEntry('/admin/operations/pay-statements')
  assert.match(line, /readyText: 'Pay Statements'/)
  assert.match(line, /expectDenial:/)
  assert.match(line, /roles: \['manager'\]/)
  assert.match(line, /Pay statements are restricted to administrators/)
})

const payAdmin = (over: Partial<RouteInput> = {}): RouteInput => ({
  requestedPath: '/admin/operations/pay-statements', finalPath: '/admin/operations/pay-statements',
  requiredRole: 'admin', activeRole: 'admin', authState: 'ok',
  httpStatus: 200, bodyTextLength: 900,
  readinessSelector: 'h1', readinessFound: true,
  readinessText: 'Pay Statements', readinessTextFound: true,
  scrollWidth: 390, clientWidth: 390,
  ...over,
})
const payManager = (over: Partial<RouteInput> = {}): RouteInput => ({
  requestedPath: '/admin/operations/pay-statements', finalPath: '/admin/operations/pay-statements',
  requiredRole: 'admin', activeRole: 'manager', authState: 'ok',
  httpStatus: 200, bodyTextLength: 200,
  expectedDenial: true,
  denialText: 'Pay statements are restricted to administrators', denialTextFound: true,
  scrollWidth: 390, clientWidth: 390,
  ...over,
})

test('an admin sees the real pay-statements content and passes', () => {
  const r = cls(payAdmin())
  assert.equal(r.outcome, 'PASS')
  assert.equal(r.state, 'content')
})

test('a manager seeing the intended denial card is not a FAIL', () => {
  const r = cls(payManager())
  assert.equal(r.outcome, 'PASS')
  assert.notEqual(r.outcome, 'FAIL')
})

test('the manager result is recorded as a DENIAL, never as the admin workflow', () => {
  const r = cls(payManager())
  assert.equal(r.state, 'denial')
  assert.match(r.detail, /expected denial state for manager/)
  // The admin content assertion is not what was proven.
  assert.doesNotMatch(r.detail, /Pay Statements$/)
})

test('a manager who does NOT get the denial card fails', () => {
  const r = cls(payManager({ denialTextFound: false }))
  assert.equal(r.outcome, 'FAIL')
  assert.equal(r.state, 'denial')
})

test('a blank shell satisfies neither the content state nor the denial state', () => {
  assert.equal(cls(payAdmin({ bodyTextLength: 5 })).outcome, 'FAIL')
  assert.equal(cls(payManager({ bodyTextLength: 5 })).outcome, 'FAIL')
})

test('a 403 from the API without a rendered denial card cannot pass', () => {
  // The page is still loading its refusal, or rendered nothing at all.
  const r = cls(payManager({ skeletonStillVisible: true }))
  assert.equal(r.outcome, 'FAIL')
  assert.match(r.detail, /skeleton never resolved/)
})

test('an admin cannot pass by rendering the denial card', () => {
  // expectedDenial is false for an admin, so the admin content assertion still governs.
  const r = cls(payAdmin({ readinessTextFound: false }))
  assert.equal(r.outcome, 'FAIL')
})

// ── FIX 5 — redirect classification ──────────────────────────────────────────

const shadow = (over: Partial<RouteInput> = {}): RouteInput => ({
  requestedPath: '/admin/operations/ai/shadow', finalPath: '/admin/operations/ai/performance',
  canonicalRedirect: '/admin/operations/ai/performance',
  requiredRole: 'admin', activeRole: 'admin', authState: 'ok',
  httpStatus: 200, bodyTextLength: 900,
  readinessSelector: 'h1', readinessFound: true,
  scrollWidth: 390, clientWidth: 390,
  ...over,
})

test('an authenticated intentional redirect is NOT BLOCKED_AUTH', () => {
  const r = cls(shadow())
  assert.notEqual(r.outcome, 'BLOCKED_AUTH')
  assert.equal(r.outcome, 'PASS')
})

test('a canonical redirect follows the DESTINATION readiness', () => {
  // Destination did not render → FAIL, not a pass and not a blocked result.
  const r = cls(shadow({ readinessFound: false }))
  assert.equal(r.outcome, 'FAIL')
  assert.match(r.detail, /readiness assertion not met/)
})

test('an UNEXPECTED authenticated redirect is a FAIL, never a silent PASS', () => {
  const r = cls(shadow({ finalPath: '/admin/operations', canonicalRedirect: null })) as Result
  assert.equal(r.outcome, 'FAIL')
  assert.match(r.detail, /unexpected redirect/)
})

test('a redirect with NO session on a gated route is still BLOCKED_AUTH', () => {
  const r = cls({
    requestedPath: '/admin/operations/finance', finalPath: '/admin/operations',
    requiredRole: 'admin', activeRole: 'anonymous', authState: 'absent',
  })
  assert.equal(r.outcome, 'BLOCKED_AUTH')
})

test('an AUTHENTICATED bounce to the sign-in screen is FAIL, not BLOCKED_AUTH', () => {
  // Route metadata alone must never produce BLOCKED_AUTH: we had a valid session and
  // the app rejected it, which is a defect, not a missing credential.
  const r = cls({
    requestedPath: '/admin/operations/finance', finalPath: '/admin/operations/finance',
    requiredRole: 'admin', activeRole: 'admin', authState: 'ok',
    httpStatus: 200, bodyTextLength: 300, hasLoginForm: true,
  })
  assert.equal(r.outcome, 'FAIL')
  assert.match(r.detail, /signed in as admin but the route rendered the sign-in screen/)
})

test('an anonymous bounce to the sign-in screen on a gated route is BLOCKED_AUTH', () => {
  const r = cls({
    requestedPath: '/admin/operations/finance',
    requiredRole: 'admin', activeRole: 'anonymous', authState: 'absent',
    httpStatus: 200, bodyTextLength: 300, hasLoginForm: true,
  })
  assert.equal(r.outcome, 'BLOCKED_AUTH')
})

test('a sign-in screen on a genuinely public route is still a FAIL', () => {
  const r = cls({
    requestedPath: '/about', finalPath: '/about',
    requiredRole: 'none', activeRole: 'anonymous', authState: 'not_required',
    httpStatus: 200, bodyTextLength: 300, hasLoginForm: true,
  })
  assert.equal(r.outcome, 'FAIL')
  assert.match(r.detail, /public route/)
})

test('a redirect loop does not pass, and is a page finding rather than an env one', () => {
  assert.equal(isRedirectLoopError('net::ERR_TOO_MANY_REDIRECTS at /x'), true)
  const r = cls({
    requestedPath: '/admin/operations/finance', requiredRole: 'admin', activeRole: 'admin',
    authState: 'ok', error: 'page.goto: net::ERR_TOO_MANY_REDIRECTS at /admin/operations/finance',
  })
  assert.equal(r.outcome, 'FAIL')
  assert.match(r.detail, /redirect loop/)
})

test('a Production redirect is still BLOCKED_ENV, and an off-target one still blocks', () => {
  // Handled by the target guard before launch; classifyRoute only ever sees the
  // connection-level shape, which must remain "not measured".
  const r = cls({
    requestedPath: '/', requiredRole: 'none', activeRole: 'anonymous',
    error: 'net::ERR_CONNECTION_REFUSED',
  })
  assert.equal(r.outcome, 'BLOCKED_ENV')
})

test('the final URL and a redirect reason are recorded in the detail', () => {
  const r = cls(shadow({ finalPath: '/admin/operations/list', canonicalRedirect: null }))
  assert.match(r.detail, /\/admin\/operations\/ai\/shadow → \/admin\/operations\/list/)
})

// ── FIX 6 — identity truthfulness at the classifier boundary ─────────────────

test('a valid session is never downgraded to anonymous by an out-of-role 403', () => {
  // The crew principal is authenticated; a 403 from an admin-only endpoint says
  // nothing about that. Its own route must measure normally.
  const r = cls({
    requestedPath: '/portal', finalPath: '/portal',
    requiredRole: 'crew', activeRole: 'crew', authState: 'ok',
    httpStatus: 200, bodyTextLength: 600,
    readinessSelector: 'h1', readinessFound: true,
    readinessText: 'Sign out', readinessTextFound: true,
    scrollWidth: 390, clientWidth: 390,
  })
  assert.equal(r.outcome, 'PASS')
})

test('identity cannot be elevated by what a page rendered', () => {
  // A crew principal on an admin route stays crew and stays blocked, no matter how
  // much admin-looking content came back.
  const r = cls({
    requestedPath: '/admin/operations/finance', finalPath: '/admin/operations/finance',
    requiredRole: 'admin', activeRole: 'crew', authState: 'ok',
    httpStatus: 200, bodyTextLength: 9000,
    readinessSelector: 'h1', readinessFound: true,
  })
  assert.equal(r.outcome, 'BLOCKED_AUTH')
  assert.match(r.detail, /signed in as crew/)
})

test('the audit resolves identity with role-appropriate probes, not one admin endpoint', () => {
  assert.match(AUDIT_SRC, /const ROLE_PROBES = \{/)
  assert.match(AUDIT_SRC, /crew: '\/api\/portal\/me'/)
  // The universal-gate defect must not come back.
  assert.doesNotMatch(AUDIT_SRC, /const gated = await ctx\.request\.get\(`\$\{BASE\}\/api\/admin\/timesheets`\)/)
})

test('the reported identity comes from the server, not from the AUDIT_IDENTITY label', () => {
  assert.match(AUDIT_SRC, /const IDENTITY = authState === 'ok' \? ACTIVE_ROLE : 'anonymous'/)
})

// ── Totals ───────────────────────────────────────────────────────────────────

test('blocked results never count as passed, and totals stay consistent', () => {
  const results = [
    { outcome: 'PASS' }, { outcome: 'PASS' },
    { outcome: 'FAIL' },
    { outcome: 'BLOCKED_AUTH' }, { outcome: 'BLOCKED_AUTH' },
    { outcome: 'INCONCLUSIVE' },
  ]
  const { counts, passed, findings, blocked, fullyMeasured, exitCode } = summarizeRoutes(results)
  assert.equal(passed, 2)
  assert.equal(findings, 1)
  assert.equal(blocked, 3)
  assert.equal(counts.PASS, 2)
  assert.equal(fullyMeasured, false)
  assert.equal(exitCode, 2, 'blocked outranks findings')
})

test('the corrected cases produce no result at all, rather than a false PASS', () => {
  // /opspilot and /ai/shadow are simply not audited any more — the fix removes the
  // checks, it does not convert 54 false failures into 54 unearned passes.
  assert.ok(!configuredPaths.includes('/opspilot'))
  assert.ok(!configuredPaths.includes('/admin/operations/ai/shadow'))
})

test('a real application failure is still reported', () => {
  // The manager /finance skeleton — one of the 18 genuine defects this wave must NOT
  // hide while it clears the noise.
  const r = cls({
    requestedPath: '/admin/operations/finance', finalPath: '/admin/operations/finance',
    requiredRole: 'admin', activeRole: 'manager', authState: 'ok',
    httpStatus: 200, bodyTextLength: 400, skeletonStillVisible: true,
    readinessSelector: 'h1', readinessFound: true,
  })
  assert.equal(r.outcome, 'FAIL')
  assert.match(r.detail, /skeleton never resolved/)
})
