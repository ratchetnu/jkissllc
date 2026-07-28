// Runtime signals for the mobile audit (PURE): console output, uncaught page errors,
// hydration failures, and same-origin request outcomes.
//
// The gap this closes: the audit proved authentication, the final route, route-specific
// shell content and responsive layout — and still reported PASS for six route×role
// combinations whose required data request returned 403. The chrome rendered, the
// heading was present, the layout held, and the page was empty. A page that cannot load
// its data is not a page that passes.
//
// Kept pure and dependency-free so redaction, de-duplication, the noise allowlist and
// the required-endpoint policy are unit tested without a browser.

// ── Redaction ────────────────────────────────────────────────────────────────
//
// Console text is captured verbatim from the page and then written to a report, so it
// is an exfiltration path. Redact before storing, never at print time — a value that
// reaches the results array has already escaped.

// ORDER MATTERS. `Authorization: Bearer <token>` must hit the Bearer rule first: the
// generic key=value rule stops at the first whitespace, so running it first redacts the
// word "Bearer" and leaves the token sitting in the report. That is not hypothetical —
// it is what the first version of this function did, and a test caught it.
const SECRET_PATTERNS = [
  // Bearer / Basic credentials
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  // JWTs anywhere
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED_JWT]'],
  // userinfo in a URL
  [/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@'],
  // key=value / "key": "value" forms for anything credential-shaped
  [/((?:authorization|auth|cookie|set-cookie|token|access[_-]?token|id[_-]?token|refresh[_-]?token|secret|api[_-]?key|apikey|password|passwd|pwd|session|bypass|signature|sig)["']?\s*[:=]\s*["']?)([^\s"',;&)}\]]+)/gi, '$1[REDACTED]'],
  // Upstash/Vercel-style long opaque tokens — the catch-all for shapes not named above
  [/\b[A-Za-z0-9_-]{40,}\b/g, '[REDACTED_LONG]'],
]

/** Longer than this and it is a response body, not a message. */
export const MAX_MESSAGE_LENGTH = 300

/**
 * Strip credential-shaped values and truncate. Always applied before storing.
 *
 * Truncation runs FIRST so an oversized payload is cut down before pattern matching,
 * and the result still carries the marker saying something was dropped.
 */
export function redactMessage(text) {
  let s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (s.length > MAX_MESSAGE_LENGTH) s = `${s.slice(0, MAX_MESSAGE_LENGTH)}… [truncated]`
  for (const [re, to] of SECRET_PATTERNS) s = s.replace(re, to)
  return s
}

// ── Known-harmless noise ─────────────────────────────────────────────────────
//
// Deliberately NARROW. Every entry needs a reason, because anything matched here can
// never fail a route again. An unknown console error is a finding, not noise — the
// default must be "this matters".

export const CONSOLE_NOISE_ALLOWLIST = [
  // Chrome emits this for any favicon 404; it says nothing about the app.
  { pattern: /Failed to load resource.*favicon\.ico/i, why: 'missing favicon, cosmetic' },
  // React DevTools nag on every dev-mode page load.
  { pattern: /Download the React DevTools/i, why: 'React DevTools advertisement' },
  // next/font fetches Google fonts at build; a CDN hiccup is not an app defect.
  { pattern: /fonts\.(googleapis|gstatic)\.com/i, why: 'third-party font CDN' },
]

/** True when a message is known-harmless. Everything else counts. */
export function isAllowlistedNoise(message) {
  return CONSOLE_NOISE_ALLOWLIST.some((e) => e.pattern.test(String(message ?? '')))
}

// Chrome logs this for EVERY non-2xx subresource, with no way to tell from the text
// which request it was. It is an echo of something the network layer already saw and
// already judged: `evaluateRequests` decides whether that endpoint was required.
// Counting the echo as an independent console error means the same failure is judged
// twice, and the second judgement has no idea whether the endpoint mattered — which
// turned a shared rate-limiter tripping under the audit's own parallel load into 88
// false failures on static public pages.
//
// This is NOT an allowlist entry: the failure is still reported, and if it was a
// required endpoint the network contract fails the route on its own terms.
const NETWORK_ECHO_PATTERN = /^Failed to load resource(?::|\b)/i

/** True for Chrome's generic subresource-failure echo, which the network layer owns. */
export function isNetworkEcho(message) {
  return NETWORK_ECHO_PATTERN.test(String(message ?? ''))
}

// A console/pageerror message that means the framework failed to hydrate, as opposed to
// an ordinary application error. Kept separate because the remedy is different and the
// audit must not report every slow fetch as a hydration failure.
const HYDRATION_PATTERNS = [
  /hydrat/i,
  /did not match/i,
  /text content does not match/i,
  /server[- ]rendered HTML/i,
  /server\/client (?:markup )?mismatch/i,
  /client render(?:ed tree)? (?:instead|replac)/i,
]

/** True when the message describes a hydration/SSR-mismatch failure. */
export function isHydrationMessage(message) {
  return HYDRATION_PATTERNS.some((re) => re.test(String(message ?? '')))
}

/**
 * Normalize, redact, de-duplicate and split raw browser events.
 *
 * De-duplication matters: one failing fetch in a render loop can emit the same line
 * hundreds of times, and a report that repeats it hundreds of times is unreadable
 * without being any more true.
 *
 * @param {{consoleErrors?: string[], pageErrors?: string[]}} raw
 */
export function summarizeRuntimeSignals(raw = {}) {
  const seen = new Set()
  const keep = (list) => {
    const out = []
    for (const m of list ?? []) {
      const msg = redactMessage(m)
      if (!msg || seen.has(msg)) continue
      seen.add(msg)
      out.push(msg)
    }
    return out
  }
  // Page errors first: an uncaught exception is the strongest signal, and de-dup should
  // not let a console echo of the same text claim it.
  const pageErrors = keep(raw.pageErrors)
  const consoleAll = keep(raw.consoleErrors)

  const hydration = [...pageErrors, ...consoleAll].filter(isHydrationMessage)
  const hydrationSet = new Set(hydration)
  const remaining = consoleAll.filter((m) => !hydrationSet.has(m))

  const ignored = remaining.filter(isAllowlistedNoise)
  const networkEchoes = remaining.filter((m) => !isAllowlistedNoise(m) && isNetworkEcho(m))
  const consoleErrors = remaining.filter((m) => !isAllowlistedNoise(m) && !isNetworkEcho(m))

  return {
    consoleErrors,
    pageErrors: pageErrors.filter((m) => !hydrationSet.has(m)),
    hydrationErrors: hydration,
    networkEchoes,
    ignored,
  }
}

// ── Network ──────────────────────────────────────────────────────────────────

/** Same-origin application request, not an asset or a third party. */
export function isApplicationRequest(url, base) {
  try {
    const u = new URL(url, base)
    const b = new URL(base)
    if (u.host !== b.host) return false
    return !/\.(?:js|mjs|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|txt|xml)$/i.test(u.pathname)
  } catch { return false }
}

/**
 * Decide which observed requests break the route's data contract.
 *
 * A failure on a DECLARED required endpoint disqualifies a pass. An unrelated
 * background failure is reported but does not fail the route on its own — otherwise a
 * flaky analytics beacon would produce exactly the kind of false FAIL Wave 2 removed.
 *
 * @param {Array<{path:string,method:string,status:number}>} observed
 * @param {string[]} required  path prefixes the route declares it needs
 */
export function evaluateRequests(observed = [], required = []) {
  const isRequired = (p) => required.some((r) => p === r || p.startsWith(`${r}?`) || p.startsWith(`${r}/`))
  const requiredSeen = []
  const requiredFailures = []
  const otherFailures = []
  for (const r of observed) {
    const failed = typeof r.status === 'number' && (r.status === 0 || r.status >= 400)
    if (isRequired(r.path)) {
      requiredSeen.push(r)
      if (failed) requiredFailures.push(`${r.method} ${r.path} → ${r.status}`)
    } else if (failed) {
      otherFailures.push(`${r.method} ${r.path} → ${r.status}`)
    }
  }
  // A declared endpoint that was never called is as broken as one that failed: the page
  // did not even try to load its data.
  const missing = required.filter((r) => !requiredSeen.some((s) => s.path === r || s.path.startsWith(`${r}?`) || s.path.startsWith(`${r}/`)))
  return {
    requiredFailures: [...new Set(requiredFailures)],
    missingRequired: missing,
    otherFailures: [...new Set(otherFailures)],
  }
}
