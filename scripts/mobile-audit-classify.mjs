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

// A redirect loop is a defect in the PAGE, not in the environment — the server is
// answering, it is just answering with a cycle. Treating it as a navigation timeout
// would file it under "could not measure" and hide a real bug.
const REDIRECT_LOOP_PATTERN = /ERR_TOO_MANY_REDIRECTS|redirect(?:ed)?\s+too\s+many\s+times/i

/** True when navigation failed because the route redirects in a cycle. */
export function isRedirectLoopError(message) {
  return REDIRECT_LOOP_PATTERN.test(String(message ?? ''))
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

// ── Roles ────────────────────────────────────────────────────────────────────
//
// A route declares the role it NEEDS, not merely "is a login required". The old
// boolean could not express the difference between "/portal wants a crew member" and
// "/admin/* wants staff", so /portal was declared public and its login gate was
// reported as a layout FAIL on every anonymous, admin and manager run — 27 of the 90
// false failures in the 2026-07-27 audit.
//
// `manager` is included for admin surfaces on purpose: a manager legitimately browses
// them and simply sees less. Being shown a denial card is authorization working, not
// authentication missing.
export const ROUTE_ROLE_MATRIX = {
  none: ['anonymous', 'crew', 'manager', 'admin', 'owner'],
  crew: ['crew'],
  admin: ['manager', 'admin', 'owner'],
  // Platform-owner routes are a tier ABOVE admin (requirePlatformOwner in
  // app/api/admin/_lib/session.ts). A named admin is genuinely refused there, so
  // listing anyone else here would measure a denial screen and call it the page.
  owner: ['owner'],
}

/** True when the signed-in principal may reach a route with this requirement. */
export function roleSatisfiesRoute(requiredRole, activeRole) {
  const allowed = ROUTE_ROLE_MATRIX[requiredRole ?? 'none']
  if (!allowed) return false
  return allowed.includes(activeRole ?? 'anonymous')
}

/**
 * The endpoints a route genuinely cannot work without FOR THIS PRINCIPAL.
 *
 * A single global `required` list assumes every role needs the same data, and that is
 * not true: a manager holds `businesses:manage` but not `invoices:manage`, so
 * /admin/operations/businesses is legitimately theirs while /api/admin/route-invoices
 * legitimately refuses them. Requiring it of everyone reported a working page as a data
 * failure; dropping it for everyone would stop proving that an ADMIN can load invoices.
 *
 * `byRole` therefore narrows (or widens) the list for one role, and the global list
 * remains the default. Naming the exception per role is the point — it keeps the
 * contract explicit rather than quietly weakening it for all.
 *
 * @param {{ required?: string[], byRole?: Record<string, { required?: string[] }> }|null|undefined} data
 * @param {string|null|undefined} activeRole
 * @returns {string[]}
 */
export function requiredEndpointsFor(data, activeRole) {
  if (!data) return []
  const override = activeRole ? data.byRole?.[activeRole] : undefined
  return (override?.required ?? data.required) ?? []
}

/**
 * Classify one route × viewport check with readiness taken into account.
 *
 * @param {{
 *   requestedPath?: string, finalPath?: string,
 *   requiredRole?: 'none'|'crew'|'admin'|null,
 *   activeRole?: 'anonymous'|'crew'|'manager'|'admin'|'owner',
 *   requiresAuth?: boolean, authState?: 'ok'|'failed'|'absent'|'not_required',
 *   canonicalRedirect?: string|null,
 *   error?: string|null, httpStatus?: number|null,
 *   bodyTextLength?: number, hasLoginForm?: boolean, hasErrorBoundary?: boolean,
 *   skeletonStillVisible?: boolean,
 *   readinessSelector?: string|null, readinessFound?: boolean|null,
 *   readinessText?: string|null, readinessTextFound?: boolean|null,
 *   expectedDenial?: boolean, denialText?: string|null, denialTextFound?: boolean|null,
 *   dataLoadedText?: string|null, dataLoadedFound?: boolean|null,
 *   dataEmptyText?: string|null, dataEmptyFound?: boolean|null,
 *   requiredFailures?: string[], missingRequired?: string[], otherFailures?: string[],
 *   consoleErrors?: string[], pageErrors?: string[], hydrationErrors?: string[],
 *   requireActionSelector?: string|null, actionVisible?: boolean|null,
 *   scrollWidth?: number, clientWidth?: number, offenders?: string[], clipped?: string[],
 * }} input
 * @returns {{ outcome: RouteOutcome, detail: string, state: 'content'|'denial'|'empty'|'data'|'runtime'|null }}
 */
export function classifyRoute(input = {}) {
  const {
    requestedPath, finalPath,
    requiredRole = null, activeRole = 'anonymous',
    requiresAuth = false, authState = 'not_required',
    canonicalRedirect = null,
    error, httpStatus,
    bodyTextLength = 0, hasLoginForm = false, hasErrorBoundary = false,
    skeletonStillVisible = false,
    readinessSelector = null, readinessFound = null,
    readinessText = null, readinessTextFound = null,
    expectedDenial = false, denialText = null, denialTextFound = null,
    dataLoadedText = null, dataLoadedFound = null,
    dataEmptyText = null, dataEmptyFound = null,
    // `otherFailures` is deliberately NOT read here: an unrelated background request
    // failing is reported by the caller but must not fail the route on its own, or a
    // flaky analytics beacon becomes exactly the kind of false FAIL Wave 2 removed.
    requiredFailures = [], missingRequired = [],
    consoleErrors = [], pageErrors = [], hydrationErrors = [],
    requireActionSelector = null, actionVisible = null,
    scrollWidth, clientWidth, offenders = [], clipped = [],
  } = input

  // `requiredRole` is the modern form; `requiresAuth` is the legacy boolean. When only
  // the boolean is given, "needs a session" means the admin surface.
  const needsRole = requiredRole ?? (requiresAuth ? 'admin' : 'none')
  const gated = needsRole !== 'none'
  const authed = authState === 'ok'
  // A caller that names no role is using the legacy contract, where `authState === 'ok'`
  // by itself meant "we hold a session good for this route". Only a NAMED role is
  // checked against the matrix, so adding role awareness cannot retroactively block
  // callers that never claimed one.
  const roleKnown = input.activeRole !== undefined
  // Whether THIS principal may reach the route at all. A signed-in admin visiting a
  // crew-only route is authenticated but not eligible — that is BLOCKED_AUTH for the
  // route's purposes, and it must never be silently relabelled as the crew run.
  const eligible = !gated || (authed && (!roleKnown || roleSatisfiesRoute(needsRole, activeRole)))

  // 1. Nothing was observed at all. A redirect LOOP is separated out: the server
  //    answered, so it is a page defect, not an environment one.
  if (error) {
    if (isRedirectLoopError(error)) {
      return done('FAIL', `redirect loop on ${requestedPath ?? 'route'}: ${trim(error)}`)
    }
    return isInfrastructureError(error)
      ? done('BLOCKED_ENV', `app unreachable: ${trim(error)}`)
      : done('INCONCLUSIVE', `navigation failed: ${trim(error)}`)
  }

  // 2. We could not establish the role this route requires, so it was never really
  //    visited. This is the defect that made ~20 admin routes pass against a sign-in
  //    screen. It is about AUTHENTICATION — never about a redirect existing.
  if (!eligible) {
    const why = !authed
      ? `not authenticated (${authState})`
      : `signed in as ${activeRole}, which cannot reach a ${needsRole} route`
    return done('BLOCKED_AUTH', `${why} — route not measured`)
  }

  // 3. The server said no.
  if (typeof httpStatus === 'number' && httpStatus >= 400) {
    return done('ROUTE_ERROR', `HTTP ${httpStatus}`)
  }

  // 4. We landed on a sign-in screen. A 200 does not make that the page under test.
  //    With a session in hand this is a real defect — the app rejected a valid
  //    principal — so it must not be filed under "no session".
  if (hasLoginForm) {
    if (authed) return done('FAIL', `signed in as ${activeRole} but the route rendered the sign-in screen`)
    return gated
      ? done('BLOCKED_AUTH', 'rendered the sign-in screen, not the route')
      : done('FAIL', 'unexpected sign-in screen on a public route')
  }

  // 5. We were sent somewhere else.
  //
  //    The defect this replaces: ANY redirect on an authenticated route returned
  //    BLOCKED_AUTH, even with authState === 'ok'. `/admin/operations/ai/shadow`
  //    redirects to `/ai/performance` by design, and the audit reported it as "no
  //    session" 18 times — a redirect is evidence about ROUTING, never about auth.
  if (requestedPath && finalPath && finalPath !== requestedPath) {
    // A declared canonical destination is the route working as designed. Fall through
    // and judge the page we actually landed on.
    if (canonicalRedirect && finalPath === canonicalRedirect) {
      // continue — readiness below is asserted against the destination
    } else if (!authed && gated) {
      // Without a session we genuinely cannot tell an auth bounce from a real redirect.
      return done('BLOCKED_AUTH', `redirected ${requestedPath} → ${finalPath} with no session`)
    } else {
      // Authenticated, or a public route: an undeclared redirect is a routing finding.
      // It must never silently pass just because the destination happens to render.
      return done('FAIL', `unexpected redirect ${requestedPath} → ${finalPath}`)
    }
  }

  // 6. An error boundary renders with HTTP 200 and perfect layout.
  if (hasErrorBoundary) return done('FAIL', 'error boundary rendered')

  // 7. A blank client shell fits every viewport, and satisfies no assertion below.
  if (bodyTextLength < MIN_BODY_TEXT) {
    return done('FAIL', `blank/near-empty body (${bodyTextLength} chars < ${MIN_BODY_TEXT})`)
  }

  // 8. A skeleton that never resolved is not the feature.
  if (skeletonStillVisible) return done('FAIL', 'loading skeleton never resolved')

  // 9. The route-specific proof that THIS page rendered.
  //
  //    Two shapes, because a lower-privilege principal is SUPPOSED to see a different
  //    page. A manager on /pay-statements gets "Pay statements are restricted to
  //    administrators" — the app working correctly — and asserting the admin content
  //    against it produced 9 false failures. The denial is proven on its own terms and
  //    reported as its own state, so it can never be read as the admin workflow passing.
  if (expectedDenial) {
    if (denialText && denialTextFound === false) {
      return done('FAIL', `expected denial state not rendered: "${denialText}"`, 'denial')
    }
    if (!denialText) {
      return done('FAIL', 'route declares an expected denial state but no denial assertion', 'denial')
    }
  } else {
    if (readinessSelector && readinessFound === false) {
      return done('FAIL', `readiness assertion not met: ${readinessSelector}`)
    }
    if (readinessText && readinessTextFound === false) {
      return done('FAIL', `expected content not rendered: "${readinessText}"`)
    }
  }

  // 9b. The DATA contract. Chrome and layout tell you the page mounted; they cannot
  //     tell you it works. Six route×role combinations rendered a correct heading, a
  //     correct URL and a perfect layout while their required request returned 403 —
  //     and passed. A page that could not load its data does not pass.
  //
  //     An expected denial is exempt: being refused IS the contract for that role.
  if (!expectedDenial) {
    if (requiredFailures.length) {
      return done('FAIL', `required data request failed: ${requiredFailures.join(', ')}`, 'data')
    }
    if (missingRequired.length) {
      return done('FAIL', `required data request was never made: ${missingRequired.join(', ')}`, 'data')
    }
    // An empty dataset is a legitimate outcome, so a route may name BOTH the populated
    // proof and the explicit empty state. Requiring records would fail a correct page
    // that simply has none.
    if (dataLoadedText || dataEmptyText) {
      const loaded = dataLoadedText ? dataLoadedFound === true : false
      const empty = dataEmptyText ? dataEmptyFound === true : false
      if (!loaded && !empty) {
        const want = [dataLoadedText && `"${dataLoadedText}"`, dataEmptyText && `empty state "${dataEmptyText}"`]
          .filter(Boolean).join(' or ')
        return done('FAIL', `data never resolved — expected ${want}`, 'data')
      }
    }
  }

  // 9c. Runtime signals. A page that threw, or failed to hydrate, or logged an error
  //     nobody has explained, is not a passing page — however well it measured. These
  //     come AFTER the route/data contracts so the more actionable finding is reported
  //     first, and they apply to a denial state too: being refused is fine, throwing
  //     while being refused is not.
  //
  //     A browser/process failure is the one case that is not a statement about the
  //     page's content, so it keeps ROUTE_ERROR.
  if (pageErrors.some(isBrowserProcessFailure)) {
    return done('ROUTE_ERROR', `browser/process failure: ${pageErrors.find(isBrowserProcessFailure)}`, 'runtime')
  }
  if (pageErrors.length) {
    return done('FAIL', `uncaught page error: ${pageErrors.join(' | ')}`, 'runtime')
  }
  if (hydrationErrors.length) {
    return done('FAIL', `hydration failure: ${hydrationErrors.join(' | ')}`, 'runtime')
  }
  if (consoleErrors.length) {
    return done('FAIL', `console error: ${consoleErrors.join(' | ')}`, 'runtime')
  }

  const state = expectedDenial ? 'denial' : (dataEmptyFound === true ? 'empty' : 'content')

  // 10. Only now is a layout measurement meaningful.
  const parts = []
  if (typeof scrollWidth === 'number' && typeof clientWidth === 'number' && scrollWidth > clientWidth + 1) {
    parts.push(`scrollW=${scrollWidth} clientW=${clientWidth} :: ${offenders.join(' | ')}`)
  }
  if (clipped.length) parts.push(`CLIPPED:[${clipped.join(',')}]`)
  // A denial card has no workflow, so a missing primary action is not a finding there.
  if (!expectedDenial && requireActionSelector && actionVisible === false) {
    parts.push(`primary action not visible: ${requireActionSelector}`)
  }
  if (parts.length) return done('FAIL', parts.join(' '), state)

  return done('PASS', expectedDenial ? `expected denial state for ${activeRole}` : '', state)
}

/** Uniform result shape. `state` records WHICH contract was proven, never just "ok". */
function done(outcome, detail, state = null) {
  return { outcome, detail, state }
}

// The browser itself died, rather than the page misbehaving. Not a content finding.
const BROWSER_FAILURE_PATTERN = /Target (?:page|browser|closed|crashed)|Page crashed|browser has been closed|Protocol error/i
function isBrowserProcessFailure(message) {
  return BROWSER_FAILURE_PATTERN.test(String(message ?? ''))
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
