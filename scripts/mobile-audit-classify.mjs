// Outcome classification for the mobile overflow audit.
//
// Extracted as a pure module for one reason: the audit used to collapse EVERY
// failure — including "the dev server isn't running" — into a single `FAIL`
// line and a blended failure count. A completely broken run rendered as
// "333 checks, 333 failures", which reads as a catastrophic UI regression when
// in fact nothing was measured at all.
//
// Classifying the outcome is now separable from producing it, so the mapping is
// unit-tested against real error shapes instead of being inferred from a report.

/** @typedef {'ok'|'overflow'|'page_error'|'navigation_error'|'infrastructure_unavailable'} Outcome */

/** Outcomes that describe the PAGE (a real finding) vs. the harness/environment. */
export const FINDING_OUTCOMES = ['overflow', 'page_error']
export const INFRA_OUTCOMES = ['navigation_error', 'infrastructure_unavailable']

// Connection-level failures mean the target never answered — nothing about the UI
// was observed. Playwright surfaces these as net::ERR_* / Node as ECONNREFUSED.
const INFRA_PATTERNS = [
  /ERR_CONNECTION_REFUSED/i, /ERR_CONNECTION_RESET/i, /ERR_NAME_NOT_RESOLVED/i,
  /ERR_ADDRESS_UNREACHABLE/i, /ERR_INTERNET_DISCONNECTED/i, /ERR_SSL/i,
  /ECONNREFUSED/i, /ENOTFOUND/i, /EHOSTUNREACH/i, /ECONNRESET/i,
]

/** True when the error means "the app was not reachable", not "the page is broken". */
export function isInfrastructureError(message) {
  const s = String(message ?? '')
  return INFRA_PATTERNS.some((re) => re.test(s))
}

/**
 * Classify one route × viewport check.
 *
 * @param {{ error?: string|null, httpStatus?: number|null,
 *           scrollWidth?: number, clientWidth?: number,
 *           offenders?: string[], clipped?: string[] }} input
 * @returns {{ outcome: Outcome, detail: string }}
 */
export function classifyCheck(input = {}) {
  const { error, httpStatus, scrollWidth, clientWidth, offenders = [], clipped = [] } = input

  if (error) {
    return isInfrastructureError(error)
      ? { outcome: 'infrastructure_unavailable', detail: `app unreachable: ${trim(error)}` }
      : { outcome: 'navigation_error', detail: `navigation failed: ${trim(error)}` }
  }

  // A 4xx/5xx is a real defect about the page, but it is NOT an overflow — and
  // measuring layout on an error page produces meaningless offender lists.
  if (typeof httpStatus === 'number' && httpStatus >= 400) {
    return { outcome: 'page_error', detail: `HTTP ${httpStatus}` }
  }

  const parts = []
  // +1px tolerance absorbs sub-pixel rounding at fractional device scales.
  if (typeof scrollWidth === 'number' && typeof clientWidth === 'number' && scrollWidth > clientWidth + 1) {
    parts.push(`scrollW=${scrollWidth} clientW=${clientWidth} :: ${offenders.join(' | ')}`)
  }
  if (clipped.length) parts.push(`CLIPPED:[${clipped.join(',')}]`)

  return parts.length ? { outcome: 'overflow', detail: parts.join(' ') } : { outcome: 'ok', detail: '' }
}

/** Tally outcomes and decide the process exit code. */
export function summarize(results) {
  const counts = { ok: 0, overflow: 0, page_error: 0, navigation_error: 0, infrastructure_unavailable: 0 }
  for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1

  const findings = counts.overflow + counts.page_error
  const infra = counts.infrastructure_unavailable + counts.navigation_error

  // 2 = we could not measure (env problem). 1 = we measured and found real issues.
  // Distinguishing them means CI can tell "the app was down" from "the UI broke".
  const exitCode = counts.infrastructure_unavailable > 0 ? 2 : findings > 0 ? 1 : 0
  return { counts, findings, infra, exitCode, measured: counts.infrastructure_unavailable === 0 }
}

function trim(s) { return String(s).replace(/\s+/g, ' ').slice(0, 120) }

// ─────────────────────────────────────────────────────────────────────────────
// Route-level truthfulness (the layer above layout)
//
// classifyCheck above answers "did the LAYOUT hold?" — and it answers it honestly.
// The problem it cannot see is that a blank page, a sign-in screen, a redirect and
// a permanent loading skeleton ALL have perfect layout. The audit therefore reported
// PASS for authenticated admin routes it had never rendered: with ADMIN_PASSWORD
// unset, `maybeAuth` returned false, the run continued anyway, and ~20 /admin/*
// routes × 9 viewports were measured against the sign-in screen and counted `ok`.
//
// A route now passes only when the intended content is PROVEN present. Anything we
// could not measure is reported as blocked — never rounded up to a pass.
// ─────────────────────────────────────────────────────────────────────────────

/** @typedef {'PASS'|'FAIL'|'BLOCKED_AUTH'|'BLOCKED_ENV'|'ROUTE_ERROR'|'INCONCLUSIVE'} RouteOutcome */

/** Outcomes that assert something about the PAGE. */
export const ROUTE_FINDING_OUTCOMES = ['FAIL', 'ROUTE_ERROR']
/** Outcomes that mean "we did not measure this route". Never a pass, never a finding. */
export const ROUTE_BLOCKED_OUTCOMES = ['BLOCKED_AUTH', 'BLOCKED_ENV', 'INCONCLUSIVE']

/** Below this much visible text, the page rendered nothing worth measuring. */
export const MIN_BODY_TEXT = 40

/**
 * Classify one route × viewport check with readiness taken into account.
 *
 * @param {{
 *   requestedPath?: string, finalPath?: string,
 *   requiresAuth?: boolean, authState?: 'ok'|'failed'|'absent'|'not_required',
 *   error?: string|null, httpStatus?: number|null,
 *   bodyTextLength?: number, hasLoginForm?: boolean, hasErrorBoundary?: boolean,
 *   skeletonStillVisible?: boolean,
 *   readinessSelector?: string|null, readinessFound?: boolean|null,
 *   requireActionSelector?: string|null, actionVisible?: boolean|null,
 *   scrollWidth?: number, clientWidth?: number, offenders?: string[], clipped?: string[],
 * }} input
 * @returns {{ outcome: RouteOutcome, detail: string }}
 */
export function classifyRoute(input = {}) {
  const {
    requestedPath, finalPath,
    requiresAuth = false, authState = 'not_required',
    error, httpStatus,
    bodyTextLength = 0, hasLoginForm = false, hasErrorBoundary = false,
    skeletonStillVisible = false,
    readinessSelector = null, readinessFound = null,
    requireActionSelector = null, actionVisible = null,
    scrollWidth, clientWidth, offenders = [], clipped = [],
  } = input

  // 1. Nothing was observed at all.
  if (error) {
    return isInfrastructureError(error)
      ? { outcome: 'BLOCKED_ENV', detail: `app unreachable: ${trim(error)}` }
      : { outcome: 'INCONCLUSIVE', detail: `navigation failed: ${trim(error)}` }
  }

  // 2. An authenticated route we are not authenticated for was never really visited.
  //    This is the defect that made ~20 admin routes pass against a sign-in screen.
  if (requiresAuth && authState !== 'ok') {
    return { outcome: 'BLOCKED_AUTH', detail: `not authenticated (${authState}) — route not measured` }
  }

  // 3. The server said no.
  if (typeof httpStatus === 'number' && httpStatus >= 400) {
    return { outcome: 'ROUTE_ERROR', detail: `HTTP ${httpStatus}` }
  }

  // 4. We landed on a sign-in screen. A 200 does not make that the page under test.
  if (hasLoginForm) {
    return requiresAuth
      ? { outcome: 'BLOCKED_AUTH', detail: 'rendered the sign-in screen, not the route' }
      : { outcome: 'FAIL', detail: 'unexpected sign-in screen on a public route' }
  }

  // 5. We were sent somewhere else.
  if (requestedPath && finalPath && finalPath !== requestedPath) {
    return requiresAuth
      ? { outcome: 'BLOCKED_AUTH', detail: `redirected ${requestedPath} → ${finalPath}` }
      : { outcome: 'FAIL', detail: `redirected ${requestedPath} → ${finalPath}` }
  }

  // 6. An error boundary renders with HTTP 200 and perfect layout.
  if (hasErrorBoundary) return { outcome: 'FAIL', detail: 'error boundary rendered' }

  // 7. A blank client shell fits every viewport.
  if (bodyTextLength < MIN_BODY_TEXT) {
    return { outcome: 'FAIL', detail: `blank/near-empty body (${bodyTextLength} chars < ${MIN_BODY_TEXT})` }
  }

  // 8. A skeleton that never resolved is not the feature.
  if (skeletonStillVisible) return { outcome: 'FAIL', detail: 'loading skeleton never resolved' }

  // 9. The route-specific proof that THIS page rendered.
  if (readinessSelector && readinessFound === false) {
    return { outcome: 'FAIL', detail: `readiness assertion not met: ${readinessSelector}` }
  }

  // 10. Only now is a layout measurement meaningful.
  const parts = []
  if (typeof scrollWidth === 'number' && typeof clientWidth === 'number' && scrollWidth > clientWidth + 1) {
    parts.push(`scrollW=${scrollWidth} clientW=${clientWidth} :: ${offenders.join(' | ')}`)
  }
  if (clipped.length) parts.push(`CLIPPED:[${clipped.join(',')}]`)
  if (requireActionSelector && actionVisible === false) {
    parts.push(`primary action not visible: ${requireActionSelector}`)
  }
  if (parts.length) return { outcome: 'FAIL', detail: parts.join(' ') }

  return { outcome: 'PASS', detail: '' }
}

/**
 * Tally route outcomes. Blocked and inconclusive checks are reported on their own
 * and are NEVER counted as passed — that conversion is the whole defect this
 * function exists to prevent.
 */
export function summarizeRoutes(results) {
  const counts = { PASS: 0, FAIL: 0, ROUTE_ERROR: 0, BLOCKED_AUTH: 0, BLOCKED_ENV: 0, INCONCLUSIVE: 0 }
  for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1

  const findings = counts.FAIL + counts.ROUTE_ERROR
  const blocked = counts.BLOCKED_AUTH + counts.BLOCKED_ENV + counts.INCONCLUSIVE
  // 2 = we could not measure some routes (env/auth). 1 = we measured and found real
  // issues. Blocked outranks findings: an unmeasured run must never look clean.
  const exitCode = blocked > 0 ? 2 : findings > 0 ? 1 : 0
  return { counts, passed: counts.PASS, findings, blocked, exitCode, fullyMeasured: blocked === 0 }
}
