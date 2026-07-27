// Pure outcome policy for the mobile audit. PASS is deliberately the last branch:
// it is reachable only after environment, authentication, navigation, hydration,
// route-specific readiness, and layout evidence have all been proven.

/** @typedef {'PASS'|'FAIL'|'BLOCKED_AUTH'|'BLOCKED_ENV'|'ROUTE_ERROR'|'INCONCLUSIVE'} AuditOutcome */

export const AUDIT_OUTCOMES = [
  'PASS', 'FAIL', 'BLOCKED_AUTH', 'BLOCKED_ENV', 'ROUTE_ERROR', 'INCONCLUSIVE',
]
export const FINDING_OUTCOMES = ['FAIL', 'ROUTE_ERROR']
export const BLOCKED_OUTCOMES = ['BLOCKED_AUTH', 'BLOCKED_ENV', 'INCONCLUSIVE']
// Backward-compatible name used by the entry point.
export const INFRA_OUTCOMES = BLOCKED_OUTCOMES

const INFRA_PATTERNS = [
  /ERR_CONNECTION_REFUSED/i, /ERR_CONNECTION_RESET/i, /ERR_NAME_NOT_RESOLVED/i,
  /ERR_ADDRESS_UNREACHABLE/i, /ERR_INTERNET_DISCONNECTED/i, /ERR_SSL/i,
  /ECONNREFUSED/i, /ENOTFOUND/i, /EHOSTUNREACH/i, /ECONNRESET/i,
]

export function isInfrastructureError(message) {
  const value = String(message ?? '')
  return INFRA_PATTERNS.some((pattern) => pattern.test(value))
}

export function validateAuditTarget(base, environment = '') {
  let url
  try { url = new URL(base) } catch { return { ok: false, reason: 'invalid audit target URL' } }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (loopback) return { ok: true, environment: 'local' }
  if (environment === 'preview' && url.protocol === 'https:' && url.hostname.endsWith('.vercel.app')) {
    return { ok: true, environment: 'preview' }
  }
  return { ok: false, reason: 'audit target must be loopback or an explicitly labelled Vercel Preview' }
}

/**
 * @param {{
 *   environmentAllowed?: boolean, authRequired?: boolean, authReady?: boolean,
 *   error?: string|null, httpStatus?: number|null, finalUrlMatches?: boolean,
 *   redirectLoop?: boolean, loginDetected?: boolean, errorBoundary?: boolean,
 *   clientError?: string|null, hydrated?: boolean, blank?: boolean,
 *   loading?: boolean, readinessConfigured?: boolean, readinessMet?: boolean,
 *   primaryActionRequired?: boolean, primaryActionVisible?: boolean,
 *   scrollWidth?: number, clientWidth?: number, offenders?: string[], clipped?: string[],
 *   evidencePath?: string|null
 * }} input
 * @returns {{ outcome: AuditOutcome, detail: string, evidencePath?: string }}
 */
export function classifyCheck(input = {}) {
  const evidence = input.evidencePath ? { evidencePath: input.evidencePath } : {}
  const result = (outcome, detail) => ({ outcome, detail, ...evidence })

  if (input.environmentAllowed === false) return result('BLOCKED_ENV', 'target environment is not permitted')
  if (input.error && isInfrastructureError(input.error)) {
    return result('BLOCKED_ENV', `app unreachable: ${trim(input.error)}`)
  }
  if (input.authRequired && !input.authReady) return result('BLOCKED_AUTH', 'authenticated session was not proven ready')
  if (input.redirectLoop) return result('ROUTE_ERROR', 'redirect loop detected')
  if (input.error) return result('ROUTE_ERROR', `navigation failed: ${trim(input.error)}`)
  if (input.httpStatus === 401 || input.httpStatus === 403) {
    return result(input.authRequired ? 'BLOCKED_AUTH' : 'ROUTE_ERROR', `HTTP ${input.httpStatus}`)
  }
  if (typeof input.httpStatus === 'number' && input.httpStatus >= 400) {
    return result('ROUTE_ERROR', `HTTP ${input.httpStatus}`)
  }
  if (input.loginDetected) return result('BLOCKED_AUTH', 'login page rendered instead of requested content')
  if (input.finalUrlMatches === false) return result('ROUTE_ERROR', 'final URL does not match the requested route')
  if (input.errorBoundary) return result('ROUTE_ERROR', 'application error boundary rendered')
  if (input.clientError) return result('ROUTE_ERROR', `client error: ${trim(input.clientError)}`)
  if (input.loading) return result('INCONCLUSIVE', 'route remained in a loading state')
  if (input.hydrated === false) return result('INCONCLUSIVE', 'client hydration was not proven')
  if (input.blank) return result('FAIL', 'blank or empty client shell rendered')
  if (input.readinessConfigured === false) return result('INCONCLUSIVE', 'no route-specific readiness assertion is configured')
  if (input.readinessMet === false) return result('FAIL', 'route-specific authenticated content was not found')
  if (input.primaryActionRequired && !input.primaryActionVisible) {
    return result('FAIL', 'configured primary action is hidden or unreachable')
  }

  const parts = []
  const offenders = input.offenders ?? []
  const clipped = input.clipped ?? []
  if (
    typeof input.scrollWidth === 'number' &&
    typeof input.clientWidth === 'number' &&
    input.scrollWidth > input.clientWidth + 1
  ) {
    parts.push(`scrollW=${input.scrollWidth} clientW=${input.clientWidth} :: ${offenders.join(' | ')}`)
  }
  if (clipped.length) parts.push(`CLIPPED:[${clipped.join(',')}]`)
  return parts.length ? result('FAIL', parts.join(' ')) : result('PASS', '')
}

export function summarize(results) {
  const counts = Object.fromEntries(AUDIT_OUTCOMES.map((outcome) => [outcome, 0]))
  for (const row of results) counts[row.outcome] = (counts[row.outcome] ?? 0) + 1
  const passed = counts.PASS
  const findings = counts.FAIL + counts.ROUTE_ERROR
  const blocked = counts.BLOCKED_AUTH + counts.BLOCKED_ENV
  const inconclusive = counts.INCONCLUSIVE
  const exitCode = findings > 0 ? 1 : (blocked > 0 || inconclusive > 0) ? 2 : 0
  return {
    counts,
    passed,
    findings,
    blocked,
    inconclusive,
    exitCode,
    measured: blocked === 0 && inconclusive === 0,
  }
}

function trim(value) {
  return String(value).replace(/\s+/g, ' ').slice(0, 160)
}
