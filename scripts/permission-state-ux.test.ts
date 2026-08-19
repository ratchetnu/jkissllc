// Wave 4 — permission-state UX.
//
// The defect class these pin: an admin surface fetched its data, the server answered
// 403, and the page had nowhere to put that answer. The symptoms differed per page but
// the lie was the same — the user was never told they had been refused:
//
//   finance, settings          → permanent loading skeleton
//   ai, ai/performance,
//   ai/learning, ai/alerts     → a red "error" card with a Try again button that
//                                re-issues a permanently refused request (learning
//                                rendered no body at all)
//   businesses → invoices      → an empty section, indistinguishable from "no invoices"
//   release                    → "Sign in with an admin account" to a signed-in manager
//
// Two layers are asserted. The MAPPING (403 → denied, 500 → error, 200 → ready) is a
// pure function and is tested as one. The WIRING (each page consumes it, renders a
// denial, and stops loading) is asserted against the page source, which is how this
// repo pins UI contracts.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  accessStateForStatus,
  isDenied,
  isRetryable,
  isResolved,
} from '../app/lib/access-state'
import { can, type Permission } from '../app/lib/rbac'
import { classifyRoute, requiredEndpointsFor } from './mobile-audit-classify.mjs'

const read = (p: string) => readFileSync(p, 'utf8')

// "This pattern is GONE" assertions must look at code, not prose. Every fix here is
// accompanied by a comment explaining the defect — and those comments quote the old
// code — so a naive doesNotMatch over the raw file always finds its own explanation.
// Strips /* … */ (including JSX {/* … */}) and // line comments, leaving `https://`
// and other in-string double slashes alone.
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1')
}

const FINANCE = read('app/admin/operations/finance/page.tsx')
const SETTINGS = read('app/admin/operations/settings/page.tsx')
const BUSINESSES = read('app/admin/operations/businesses/page.tsx')
const RELEASE = read('app/admin/operations/release/page.tsx')
const AI_SHELL = read('app/admin/operations/ai/AICommandShell.tsx')
const AI_OVERVIEW = read('app/admin/operations/ai/page.tsx')
const AI_PERFORMANCE = read('app/admin/operations/ai/performance/page.tsx')
const AI_LEARNING = read('app/admin/operations/ai/learning/page.tsx')
const AI_ALERTS = read('app/admin/operations/ai/alerts/page.tsx')
const UI = read('app/admin/operations/ui.tsx')
const AUDIT = read('scripts/mobile-overflow-audit.mjs')

const AI_PAGES: [string, string][] = [
  ['ai/page.tsx', AI_OVERVIEW],
  ['ai/performance', AI_PERFORMANCE],
  ['ai/learning', AI_LEARNING],
  ['ai/alerts', AI_ALERTS],
]

// ── 1. The mapping ───────────────────────────────────────────────────────────

test('403 and 401 are DENIED — the two statuses that mean "you were refused"', () => {
  assert.equal(accessStateForStatus(403), 'denied')
  assert.equal(accessStateForStatus(401), 'denied')
  assert.equal(isDenied(403), true)
  assert.equal(isDenied(401), true)
})

test('a server error is an ERROR, never a denial and never empty', () => {
  for (const s of [500, 502, 503, 400, 404, 429]) {
    assert.equal(accessStateForStatus(s), 'error', `HTTP ${s}`)
    assert.equal(isDenied(s), false, `HTTP ${s} must not read as a denial`)
  }
})

test('a success is READY — whether the RESULT is empty is a separate question', () => {
  for (const s of [200, 201, 204, 304]) assert.equal(accessStateForStatus(s), 'ready', `HTTP ${s}`)
})

test('a denial is terminal: it is never retryable, so no page may offer a retry for it', () => {
  assert.equal(isRetryable('denied'), false)
  assert.equal(isRetryable('error'), true)
  assert.equal(isRetryable('ready'), false)
})

test('every terminal state resolves — a page must stop loading once refused', () => {
  assert.equal(isResolved('loading'), false)
  for (const s of ['denied', 'error', 'ready'] as const) {
    assert.equal(isResolved(s), true, `${s} must end the loading state`)
  }
})

// ── 2. The authorization decisions this wave preserved ───────────────────────
//
// Each fix below rests on a claim about the role contract. If someone widens the
// matrix, these fail rather than the denial silently becoming dead code.

test('the role contract still says a manager may NOT see Money or Settings', () => {
  // /api/admin/finance is requirePermission('profitability:view')
  assert.equal(can('manager', 'profitability:view'), false)
  assert.equal(can('admin', 'profitability:view'), true)
  // /api/admin/alerts is requirePermission('settings:manage')
  assert.equal(can('manager', 'settings:manage'), false)
  assert.equal(can('admin', 'settings:manage'), true)
})

test('a manager IS intended to run Businesses — only the invoice feed is admin-only', () => {
  // The page itself is theirs…
  assert.equal(can('manager', 'businesses:manage'), true)
  // …but /api/admin/route-invoices is requirePermission('invoices:manage').
  assert.equal(can('manager', 'invoices:manage'), false)
  assert.equal(can('admin', 'invoices:manage'), true)
})

test('the AI Command Center is guarded ABOVE the RBAC matrix, so the matrix was not widened', () => {
  // Both roles hold ai:analytics, yet every AI endpoint is requirePlatformOwner. The fix
  // must NOT have "corrected" this by granting the matrix permission — the platform-owner
  // tier is the control.
  for (const role of ['admin', 'manager'] as const) {
    assert.equal(can(role, 'ai:analytics' as Permission), true)
  }
  for (const f of ['ai-overview', 'shadow-learning', 'ai-alerts']) {
    assert.match(
      read(`app/api/admin/${f}/route.ts`),
      /requirePlatformOwner\(req\)/,
      `${f} must still be platform-owner-only`,
    )
  }
})

test('no page fix weakened a server guard', () => {
  assert.match(read('app/api/admin/finance/route.ts'), /requirePermission\(req, 'profitability:view'\)/)
  assert.match(read('app/api/admin/alerts/route.ts'), /requirePermission\(req, 'settings:manage'\)/)
  assert.match(read('app/api/admin/route-invoices/route.ts'), /requirePermission\(req, 'invoices:manage'\)/)
  assert.match(read('app/api/admin/release/route.ts'), /requireAdmin\(req\)/)
})

// ── 3. Wiring: every affected page classifies 403 through the shared mapping ──

test('every affected page routes its refusal through the shared classifier', () => {
  const pages: [string, string][] = [
    ['finance', FINANCE], ['settings', SETTINGS], ['businesses', BUSINESSES],
    ...AI_PAGES,
  ]
  for (const [name, src] of pages) {
    assert.match(src, /accessStateForStatus\(/, `${name} must use the shared mapping`)
    assert.match(src, /from '.*lib\/access-state'/, `${name} must import it, not re-implement it`)
  }
})

test('no affected page still hand-rolls the status comparison it replaced', () => {
  for (const [name, src] of AI_PAGES) {
    assert.doesNotMatch(
      code(src),
      /r\.status === 401 \|\| r\.status === 403/,
      `${name} must not re-inline the check`,
    )
  }
})

// ── 4. Wiring: a denial renders, and it is NOT an error and NOT a spinner ────

test('finance renders a Manager denial naming the required role, and stops loading', () => {
  assert.match(FINANCE, /state === 'denied'/)
  assert.match(FINANCE, /Money is restricted to administrators/)
  assert.match(FINANCE, /requirement="the Admin role"/)
  // The skeleton is now reachable ONLY from the loading state. The old condition
  // (`loading || !summary`) was true forever after a 403.
  assert.match(FINANCE, /state === 'loading' \? \(/)
  assert.doesNotMatch(code(FINANCE), /loading \|\| !summary/)
})

test('finance separates a failed request from an empty ledger', () => {
  assert.match(FINANCE, /state === 'error' \?/)
  assert.match(FINANCE, /<DataError/)
})

test('settings renders a Manager denial and never leaves its four skeletons running', () => {
  assert.match(SETTINGS, /state === 'denied'/)
  assert.match(SETTINGS, /Settings is restricted to administrators/)
  // All four section skeletons are reachable only while the page is loading.
  assert.doesNotMatch(code(SETTINGS), /\{loading \|\| !(cfg|auto|fin)/)
  assert.equal((SETTINGS.match(/state === 'loading' \|\| !/g) ?? []).length, 4)
})

test('settings tells a denied manager how to sign out, since its own button is gone', () => {
  assert.match(SETTINGS, /sign out from the account menu/i)
})

test('the AI shell offers a Platform Owner denial that is terminal — no retry', () => {
  assert.match(AI_SHELL, /export function AIDenied/)
  assert.match(AI_SHELL, /Platform Owner only/)
  assert.match(AI_SHELL, /Requires <b[^>]*>Platform Owner<\/b>/)
  // AIError is the retryable one; AIDenied must not accept or render a retry.
  const denied = AI_SHELL.slice(AI_SHELL.indexOf('export function AIDenied'), AI_SHELL.indexOf('export function AIError'))
  assert.doesNotMatch(code(denied), /onRetry/)
  assert.doesNotMatch(code(denied), /Try again/)
})

test('all four AI pages render the denial instead of the old "Owner access required." error', () => {
  for (const [name, src] of AI_PAGES) {
    assert.match(src, /<AIDenied/, `${name} must render the denial`)
    assert.doesNotMatch(code(src), /Owner access required/, `${name} must not present a refusal as an error`)
  }
})

test('a denied AI page checks denial BEFORE the skeleton, so the skeleton cannot outlive it', () => {
  const deniedAt = AI_PERFORMANCE.indexOf('res?.denied')
  const skeletonAt = AI_PERFORMANCE.indexOf('if (!res || loading) return <AISkeleton')
  assert.ok(deniedAt > -1 && skeletonAt > -1)
  assert.ok(deniedAt < skeletonAt, 'the denial branch must come first')
})

test('no AI page falls back to an endless skeleton on an unusable 200', () => {
  // Each of these was `return <AISkeleton …>` on a malformed payload, which pulses
  // forever and reads as "still loading".
  assert.match(AI_OVERVIEW, /AI overview response was incomplete/)
  assert.match(AI_PERFORMANCE, /performance response was incomplete/)
  assert.match(AI_ALERTS, /alerts response was incomplete/)
  assert.match(AI_LEARNING, /AI Learning response was incomplete/)
})

test('AI learning shows SOMETHING while loading — it used to render header-only chrome', () => {
  assert.match(AI_LEARNING, /\(!res \|\| loading\) && <AISkeleton/)
})

test('AI learning does not hand a refused principal an export link to the same 403', () => {
  assert.match(AI_LEARNING, /!res\?\.denied && <a href=\{`\/api\/admin\/shadow-learning/)
})

test('businesses reports a refused invoice feed as refused, never as an empty list', () => {
  assert.match(BUSINESSES, /invoicesDenied/)
  assert.match(BUSINESSES, /Invoices are restricted to administrators/)
  assert.match(BUSINESSES, /This is not an empty list/)
  // and it must not offer the admin-only invoices destination to someone refused it
  assert.match(BUSINESSES, /\{!invoicesDenied && <Link href="\/admin\/routes\/invoices"/)
})

test('businesses still renders for a manager — the page was never the restricted thing', () => {
  // The whole point of the Businesses decision: do NOT deny the page, only the feed.
  assert.doesNotMatch(code(BUSINESSES), /Businesses is restricted to administrators/)
})

test('release addresses a signed-in manager, not a signed-out visitor', () => {
  assert.match(RELEASE, /The Release Center is restricted to administrators/)
  assert.match(RELEASE, /Requires <b[^>]*>the Admin role<\/b>/)
  // The old copy told a correctly-signed-in manager to sign in. Assert against the
  // RENDERED block only — the string survives in a comment explaining the change.
  const forbidden = RELEASE.slice(RELEASE.indexOf("{state === 'forbidden' && ("))
  const block = forbidden.slice(0, forbidden.indexOf('</Section>'))
  assert.doesNotMatch(code(block), /Sign in with an admin account/)
  assert.match(block, /Admins only/)
})

test('release hides the action that would only produce another refusal', () => {
  assert.match(RELEASE, /state !== 'forbidden' && <button onClick=\{checkCurrentState\}/)
})

// ── 5. The shared components encode the three-state rule ─────────────────────

test('the shared states are distinct, and only the error state may retry', () => {
  assert.match(UI, /export function AccessDenied/)
  assert.match(UI, /export function DataEmpty/)
  assert.match(UI, /export function DataError/)
  const denied = UI.slice(UI.indexOf('export function AccessDenied'), UI.indexOf('export function DataEmpty'))
  const empty = UI.slice(UI.indexOf('export function DataEmpty'), UI.indexOf('export function DataError'))
  assert.doesNotMatch(code(denied), /onRetry/, 'a 403 does not change on retry')
  assert.doesNotMatch(code(empty), /onRetry/, 'an empty result is not a failure')
  assert.match(UI.slice(UI.indexOf('export function DataError')), /onRetry/)
})

test('a denial offers a way back to an allowed area', () => {
  assert.match(UI, /backHref = '\/admin\/operations'/)
  assert.match(AI_SHELL, /Back to Operations/)
})

test('denial and error states are announced to assistive technology', () => {
  assert.match(UI, /export function AccessDenied[\s\S]{0,400}?role="status"/)
  assert.match(UI, /export function DataError[\s\S]{0,400}?role="alert"/)
  assert.match(AI_SHELL, /export function AIDenied[\s\S]{0,400}?role="status"/)
})

// ── 6. The audit contract now states these truths ────────────────────────────

test('the audit declares the manager denial for finance, settings and release', () => {
  for (const text of [
    'Money is restricted to administrators',
    'Settings is restricted to administrators',
    'The Release Center is restricted to administrators',
  ]) {
    assert.ok(AUDIT.includes(text), `route table must declare: ${text}`)
  }
})

test('the audit expects BOTH admin and manager to be refused by the AI Command Center', () => {
  const declarations = AUDIT.match(/expectDenial: \{ roles: \['admin', 'manager'\], text: 'Platform Owner only' \}/g) ?? []
  assert.equal(declarations.length, 4, 'ai, ai/performance, ai/learning, ai/alerts')
})

test('the audit declares the denial text the page actually renders', () => {
  // A denial assertion that does not match the page is worse than none: it fails a
  // correct page. Pin the two together.
  assert.ok(FINANCE.includes('Money is restricted to administrators'))
  assert.ok(SETTINGS.includes('Settings is restricted to administrators'))
  assert.ok(RELEASE.includes('The Release Center is restricted to administrators'))
  assert.ok(AI_SHELL.includes('Platform Owner only'))
})

// ── 7. Per-role required data ────────────────────────────────────────────────

test('required endpoints default to the global list when a role has no override', () => {
  const data = { required: ['/api/a', '/api/b'] }
  assert.deepEqual(requiredEndpointsFor(data, 'admin'), ['/api/a', '/api/b'])
  assert.deepEqual(requiredEndpointsFor(data, 'owner'), ['/api/a', '/api/b'])
  assert.deepEqual(requiredEndpointsFor(data, undefined), ['/api/a', '/api/b'])
  assert.deepEqual(requiredEndpointsFor(null, 'admin'), [])
})

test('a role override narrows the requirement for that role ONLY', () => {
  const data = { required: ['/api/a', '/api/b'], byRole: { manager: { required: ['/api/b'] } } }
  assert.deepEqual(requiredEndpointsFor(data, 'manager'), ['/api/b'])
  assert.deepEqual(requiredEndpointsFor(data, 'admin'), ['/api/a', '/api/b'])
})

test('businesses requires the invoice feed of an admin and not of a manager', () => {
  assert.match(AUDIT, /byRole: \{ manager: \{ required: \['\/api\/admin\/businesses'\] \} \}/)
})

// ── 8. End-to-end through the classifier ─────────────────────────────────────
//
// The rules from the UX contract, asserted as outcomes rather than as source text.

const base = {
  requestedPath: '/admin/operations/finance', finalPath: '/admin/operations/finance',
  requiredRole: 'admin' as const, authState: 'ok' as const,
  bodyTextLength: 500, httpStatus: 200,
  scrollWidth: 390, clientWidth: 390,
}

test('a denied role that RENDERS the denial passes, recorded as a denial — not as content', () => {
  const r = classifyRoute({
    ...base, activeRole: 'manager',
    expectedDenial: true, denialText: 'Money is restricted to administrators', denialTextFound: true,
  })
  assert.equal(r.outcome, 'PASS')
  assert.equal(r.state, 'denial')
})

test('a denied role that does NOT render the denial fails — hiding a 403 is never a pass', () => {
  const r = classifyRoute({
    ...base, activeRole: 'manager',
    expectedDenial: true, denialText: 'Money is restricted to administrators', denialTextFound: false,
  })
  assert.equal(r.outcome, 'FAIL')
  assert.match(r.detail, /expected denial state not rendered/)
})

test('a denied role stuck in a skeleton fails even though the layout is perfect', () => {
  const r = classifyRoute({
    ...base, activeRole: 'manager', skeletonStillVisible: true,
    expectedDenial: true, denialText: 'Money is restricted to administrators', denialTextFound: true,
  })
  assert.equal(r.outcome, 'FAIL')
  assert.match(r.detail, /skeleton never resolved/)
})

test('an AUTHORIZED role is still measured against real content, not the denial', () => {
  const r = classifyRoute({
    ...base, activeRole: 'owner',
    readinessSelector: 'h1', readinessFound: true,
    requiredFailures: [], missingRequired: [],
  })
  assert.equal(r.outcome, 'PASS')
  assert.equal(r.state, 'content')
})

test('an authorized role whose required request 403s still FAILS — the wave did not mute that', () => {
  const r = classifyRoute({
    ...base, activeRole: 'owner',
    readinessSelector: 'h1', readinessFound: true,
    requiredFailures: ['/api/admin/ai-overview 403'],
  })
  assert.equal(r.outcome, 'FAIL')
  assert.equal(r.state, 'data')
})

test('a genuine empty dataset is an EMPTY state, not a denial and not an error', () => {
  const r = classifyRoute({
    ...base, activeRole: 'owner',
    readinessSelector: 'h1', readinessFound: true,
    dataLoadedText: 'Statement', dataLoadedFound: false,
    dataEmptyText: 'No statements yet', dataEmptyFound: true,
  })
  assert.equal(r.outcome, 'PASS')
  assert.equal(r.state, 'empty')
})

test('a failed required request never resolves into the empty state', () => {
  const r = classifyRoute({
    ...base, activeRole: 'owner',
    readinessSelector: 'h1', readinessFound: true,
    requiredFailures: ['/api/admin/finance 500'],
    dataEmptyText: 'No routes match these filters', dataEmptyFound: true,
  })
  assert.equal(r.outcome, 'FAIL')
  assert.equal(r.state, 'data')
})

test('a denial that throws or logs an error is still a failure', () => {
  const denial = {
    ...base, activeRole: 'manager' as const,
    expectedDenial: true, denialText: 'Money is restricted to administrators', denialTextFound: true,
  }
  assert.equal(classifyRoute({ ...denial, consoleErrors: ['403 (Forbidden)'] }).outcome, 'FAIL')
  assert.equal(classifyRoute({ ...denial, pageErrors: ['TypeError: x'] }).outcome, 'FAIL')
})

test('a denial card is not failed for lacking a primary action it has no business having', () => {
  const r = classifyRoute({
    ...base, activeRole: 'manager',
    expectedDenial: true, denialText: 'Money is restricted to administrators', denialTextFound: true,
    requireActionSelector: 'select', actionVisible: false,
  })
  assert.equal(r.outcome, 'PASS')
})

test('the denial must hold at the narrowest mobile width, like any other state', () => {
  const r = classifyRoute({
    ...base, activeRole: 'manager', scrollWidth: 520, clientWidth: 320,
    offenders: ['div.os-card'],
    expectedDenial: true, denialText: 'Money is restricted to administrators', denialTextFound: true,
  })
  assert.equal(r.outcome, 'FAIL')
  assert.match(r.detail, /scrollW=520/)
})
