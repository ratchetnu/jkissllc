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
