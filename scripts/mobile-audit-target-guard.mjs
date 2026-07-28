// Target safety for the mobile overflow audit (PURE).
//
// The defect this exists to close: `preflight()` only ever asked "can I reach this
// host?". Nothing asked "am I ALLOWED to point a browser at this host?". So
//
//   BASE=https://jkissllc.com ADMIN_PASSWORD=<production credential> npm run audit:mobile
//
// authenticated against Production via /api/admin/auth and navigated every configured
// route as the owner — and with CLICK_TEXT set it would have clicked there too. A tool
// whose entire purpose is auditing safely had a latent Production-interaction path.
//
// The policy is an ALLOWLIST, deliberately. A denylist of Production hostnames can
// always be walked around by an alias nobody remembered to add (`jkissllc.com.` with a
// trailing dot, an uppercase spelling, a new custom domain, a lookalike registered
// tomorrow). Anything not positively recognised as loopback, a Vercel *Preview*
// deployment, or an explicitly approved test host is refused. The Production list below
// is kept only so the refusal can say WHY in a way a human immediately understands.
//
// Kept pure and dependency-free so every branch is unit tested without a browser, and
// so the guard can run before authentication, before chromium.launch(), before route
// discovery, before screenshots and before any configured click.

// Known Production web hostnames. Mirrors app/lib/platform/sandbox/guards.ts
// PRODUCTION_DOMAINS — that module is the source of truth, but it is TypeScript under
// app/ and this script runs as plain node, so the list is restated here.
// `scripts/mobile-audit-target-guard.test.ts` pins the two in sync and fails if a host
// is ever added there and not here.
export const PRODUCTION_HOSTS = [
  'jkissllc.com',
  'www.jkissllc.com',
  'jkissllc.vercel.app',
  'superchargedenterprise.com',
  'www.superchargedenterprise.com',
]

/** Local default when no target is specified at all. */
export const DEFAULT_BASE = 'http://localhost:3111'

/**
 * Resolve the audit target, in precedence order: `--base` flag, `BASE` env, default.
 *
 * An UNSET `BASE` means "use the local default". A `BASE` that is set but blank means
 * something upstream failed to interpolate it — resolving that to localhost would
 * silently audit the wrong thing, so it is returned empty and refused by classifyTarget.
 *
 * @param {string[]} [argv]
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function resolveBase(argv = process.argv.slice(2), env = process.env) {
  const i = argv.indexOf('--base')
  if (i >= 0 && argv[i + 1] !== undefined) return String(argv[i + 1]).trim().replace(/\/+$/, '')
  if (env.BASE === undefined) return DEFAULT_BASE
  return String(env.BASE).trim().replace(/\/+$/, '')
}

/** Refusal codes. Never carry a credential or an environment value — only a hostname. */
export const TARGET_REFUSAL_CODES = [
  'missing_base',
  'malformed_base',
  'unsupported_scheme',
  'production_host',
  'not_an_approved_target',
  'vercel_env_production',
  'redirect_to_production',
  'redirect_off_target',
]

/**
 * Normalize a host for comparison: lowercase, strip the port, strip a trailing dot.
 * `JKISSLLC.COM`, `jkissllc.com.` and `jkissllc.com:443` are all the same host, and a
 * guard that misses any of those spellings is not a guard.
 */
export function normalizeHost(host) {
  if (typeof host !== 'string') return ''
  let h = host.trim().toLowerCase()
  if (h.startsWith('[')) {
    // IPv6 literal: [::1]:3111 → ::1
    const close = h.indexOf(']')
    if (close > 0) return h.slice(1, close)
  }
  // Only strip a port from a NAME or IPv4. A bare IPv6 literal is all colons, and
  // `:\d+$` would happily eat the last group of `::1` and turn it into `::`.
  if (!h.includes(':') || /^[^:]+:\d+$/.test(h)) h = h.replace(/:\d+$/, '')
  while (h.endsWith('.')) h = h.slice(0, -1)
  return h
}

/** Loopback only. Not 0.0.0.0 and not a LAN address — those can be forwarded anywhere. */
export function isLoopbackHost(host) {
  const h = normalizeHost(host)
  if (h === 'localhost') return true
  if (h === '::1') return true                      // IPv6 loopback, matching the local policy
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) // the whole 127/8 loopback block
}

// A Vercel *generated* deployment URL. Two shapes exist, and neither can be produced by
// a Production alias:
//   <project>-<9-char deployment hash>-<scope>.vercel.app
//   <project>-git-<branch>-<scope>.vercel.app
// The Production alias for a project is the bare `<project>.vercel.app`, which has no
// hash and no `-git-` segment, so it can never satisfy either pattern.
const PREVIEW_HASH = /^[a-z0-9][a-z0-9-]*-[a-z0-9]{9}-[a-z0-9][a-z0-9-]*\.vercel\.app$/
const PREVIEW_GIT = /^[a-z0-9][a-z0-9-]*-git-[a-z0-9][a-z0-9-]*-[a-z0-9][a-z0-9-]*\.vercel\.app$/

/**
 * True only for a Vercel Preview deployment hostname. Structural, never a substring
 * test — `hostname.includes('preview')` would happily accept
 * `preview.jkissllc.com` or `jkissllc.com/preview`, which are Production.
 */
export function isVercelPreviewHost(host) {
  const h = normalizeHost(host)
  if (!h.endsWith('.vercel.app')) return false
  if (PRODUCTION_HOSTS.includes(h)) return false
  return PREVIEW_HASH.test(h) || PREVIEW_GIT.test(h)
}

/** True for a known Production hostname. Used for the refusal REASON, not the decision. */
export function isProductionHost(host) {
  return PRODUCTION_HOSTS.includes(normalizeHost(host))
}

/**
 * Decide whether the audit may point a browser at `base`.
 *
 * Fail-closed: every path that is not positively recognised returns a refusal.
 *
 * @param {string|null|undefined} base   the resolved BASE url
 * @param {{ vercelEnv?: string, approvedHost?: string }} [opts]
 *   approvedHost — an explicitly approved extra target (AUDIT_ALLOWED_HOST), for an
 *   existing local test host that is not loopback. It is still refused if it names a
 *   Production host, so it cannot be used as a bypass.
 * @returns {{ok: true, host: string, kind: 'loopback'|'preview'|'approved'}
 *          |{ok: false, outcome: 'BLOCKED_ENV', code: string, host: string, reason: string}}
 */
export function classifyTarget(base, opts = {}) {
  const { vercelEnv, approvedHost } = opts

  // Refuse to audit anything at all from inside a Production runtime.
  if (String(vercelEnv ?? '').toLowerCase() === 'production') {
    return refuse('vercel_env_production', '', 'running inside a Production environment (VERCEL_ENV=production)')
  }

  if (base === null || base === undefined || String(base).trim() === '') {
    return refuse('missing_base', '', 'no target URL was provided')
  }

  const raw = String(base).trim()
  let url
  try {
    url = new URL(raw)
  } catch {
    return refuse('malformed_base', '', `not a valid absolute URL: ${redactToOrigin(raw)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return refuse('unsupported_scheme', '', `unsupported scheme: ${url.protocol.replace(':', '')}`)
  }

  const host = normalizeHost(url.host)
  if (!host) return refuse('malformed_base', '', 'target URL has no hostname')

  // Named first so the operator gets the unambiguous reason, even though the
  // allowlist below would refuse it anyway.
  if (isProductionHost(host)) {
    return refuse('production_host', host, `${host} is a known Production hostname`)
  }
  if (isLoopbackHost(host)) return { ok: true, host, kind: 'loopback' }
  if (isVercelPreviewHost(host)) return { ok: true, host, kind: 'preview' }
  if (approvedHost && normalizeHost(approvedHost) === host) {
    return { ok: true, host, kind: 'approved' }
  }

  return refuse(
    'not_an_approved_target', host,
    `${host} is not loopback, not a Vercel Preview deployment, and not an approved test host`,
  )
}

/**
 * Re-check after the network answered. An allowed origin that 30x's onto Production
 * is a Production session — the redirect is exactly how a bare alias or a stale
 * hostname turns into the thing we refused up front.
 */
export function classifyFinalUrl(finalUrl, opts = {}) {
  const verdict = classifyTarget(finalUrl, opts)
  if (verdict.ok) return verdict
  const host = verdict.host
  // Landing on Production is the case this guard exists for, and it gets its own code
  // so the refusal cannot be mistaken for an ordinary misconfiguration.
  if (isProductionHost(host)) {
    return refuse('redirect_to_production', host, `target redirected to ${host}, a known Production hostname`)
  }
  return refuse(
    'redirect_off_target', host,
    host
      ? `target redirected to ${host}, which is not an approved audit target`
      : 'target redirected to a URL that could not be verified as an approved audit target',
  )
}

function refuse(code, host, reason) {
  return { ok: false, outcome: 'BLOCKED_ENV', code, host, reason }
}

/** Show only the origin of a bad URL — never a path, query or embedded credential. */
function redactToOrigin(raw) {
  const scheme = raw.slice(0, 40).split(/[/?#]/)[0]
  return scheme.replace(/\/\/[^@]*@/, '//')
}
