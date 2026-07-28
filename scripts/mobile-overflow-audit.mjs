// Mobile viewport overflow audit (Playwright, headless-shell). Permanent regression
// tool — run with:  npm run audit:mobile
//
//   PW_EXE=<chrome-headless-shell path> BASE=http://localhost:3111 \
//     [SHOT_DIR=shots] [LABEL=run] [ONLY=/,/quote] [AUDIT_IDENTITY=…]
//     [ADMIN_PASSWORD=…  |  AUDIT_EMAIL=… AUDIT_PASSWORD=…]   [VERCEL_BYPASS=…]
//     [CLICK_TEXT="Activation Readiness"] [AUDIT_ALLOWED_HOST=…] \
//     node scripts/mobile-overflow-audit.mjs
//
// The target must be loopback, a Vercel PREVIEW deployment, or AUDIT_ALLOWED_HOST.
// Anything else — Production above all — is refused as BLOCKED_ENV before a browser
// is launched. See mobile-audit-target-guard.mjs and README-local-audit.md §7.
//
// For every route × viewport it FIRST proves the intended page actually rendered
// (authenticated, not redirected, not a sign-in screen, not blank, not a stuck
// skeleton, and matching the route's own readiness assertion) and only THEN verifies
// documentElement.scrollWidth == clientWidth, pinpoints overflowing elements by
// bounding rect, and flags genuinely-unreachable controls (fully off-screen AND not
// inside a real horizontal scroll-rail).
//
// Anything it could not measure is reported as BLOCKED_*/INCONCLUSIVE and is never
// counted as a pass. With SHOT_DIR it captures evidence for every failure.
// With ADMIN_PASSWORD it authenticates so /admin/* and /portal render the real
// authenticated UI instead of the sign-in screen.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import { classifyRoute, summarizeRoutes, ROUTE_BLOCKED_OUTCOMES, roleSatisfiesRoute, requiredEndpointsFor } from './mobile-audit-classify.mjs'
import { classifyTarget, classifyFinalUrl, resolveBase } from './mobile-audit-target-guard.mjs'
import { summarizeRuntimeSignals, evaluateRequests, isApplicationRequest, redactMessage } from './mobile-audit-runtime-signals.mjs'


// Base URL resolution lives in the guard module with the rest of target policy, so it
// can be unit tested without importing this file (which would start an audit).
// The app must already be running — this tool measures a live server and cannot
// start one. See README-local-audit.md for how to bring up an isolated instance.
const BASE = resolveBase()

// ── Target guard ─────────────────────────────────────────────────────────────
// FIRST, before anything else in this file does work: refuse a Production target.
// This runs ahead of authentication, chromium.launch(), route iteration, screenshots
// and any CLICK_TEXT, because every one of those is a Production interaction if the
// target is wrong. Refusal is BLOCKED_ENV — never a pass, never a UI finding.
function refuseTarget(verdict, phase) {
  const { counts } = summarizeRoutes([{ outcome: 'BLOCKED_ENV' }])
  console.error(`\n==== MOBILE AUDIT — TARGET REFUSED (${phase}) ====`)
  console.error(`BLOCKED_ENV [${verdict.code}] ${verdict.reason}`)
  if (verdict.host) console.error(`Rejected hostname: ${verdict.host}`)
  console.error(`\nNo browser was launched, no session was created, and NOTHING was measured.`)
  console.error(`This is NOT a UI finding and NOT a pass.`)
  console.error(`  PASS ${counts.PASS}   BLOCKED_ENV ${counts.BLOCKED_ENV}`)
  console.error(`\nThe audit runs against loopback or a Vercel Preview deployment only.`)
  console.error(`See docs/operations/README-local-audit.md.\n`)
  process.exit(2)
}

const targetVerdict = classifyTarget(BASE, {
  vercelEnv: process.env.VERCEL_ENV,
  approvedHost: process.env.AUDIT_ALLOWED_HOST,
})
if (!targetVerdict.ok) refuseTarget(targetVerdict, 'pre-launch')

const PW_EXE = process.env.PW_EXE || undefined
const SHOT_DIR = process.env.SHOT_DIR || null
const LABEL = process.env.LABEL || 'run'
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null
const CLICK_TEXT = process.env.CLICK_TEXT || null
const SHOT_WIDTHS = new Set([320, 390, 768, 1280])

const VIEWPORTS = [
  { w: 320, h: 568 }, { w: 360, h: 800 }, { w: 375, h: 667 }, { w: 390, h: 844 },
  { w: 393, h: 852 }, { w: 414, h: 896 }, { w: 430, h: 932 }, { w: 768, h: 1024 }, { w: 1280, h: 900 },
]
// ── Route table ──────────────────────────────────────────────────────────────
// A path alone is not enough: the audit used to measure whatever came back, so a
// sign-in screen or a blank client shell passed every viewport. Each route now
// declares how to PROVE the intended page actually rendered.
//
//   auth:  'none' | 'crew' | 'admin' — the ROLE the route needs. A route is
//          BLOCKED_AUTH unless the active principal can actually reach it.
//   ready: a CSS selector that only exists once the real content mounted.
//          Deliberately per-route: one universal title check would pass on the shell.
//   readyText: exact visible text proving THIS page rendered. Used where the page has
//          no distinctive element — a generic `h1` check passes on any admin page, and
//          on a page with no h1 at all it can never pass (the /admin/disposal defect).
//   requireAction: a selector for a primary action that must be visibly reachable.
//   expectDenial: { roles, text } — a role that is SUPPOSED to be refused. Proving the
//          denial card rendered is a truthful pass for that role, recorded as state
//          'denial' so it can never be read as the admin workflow passing.
//   data:  { required, byRole, loadedText, emptyText } — proof the page's DATA resolved,
//          not just its chrome. `required` names same-origin endpoints the page cannot
//          work without: a 4xx/5xx on one of them (or never calling it) disqualifies a
//          pass, which is what six route×role combinations needed — correct heading,
//          correct URL, perfect layout, 403 payload, reported PASS. `loadedText`/
//          `emptyText` let a route accept EITHER a populated result or an explicit empty
//          state, so a correct page with no records is not failed for having none.
//          `byRole: { <role>: { required } }` narrows the list for ONE role, because
//          "what this page needs" is not role-invariant: a manager owns
//          /admin/operations/businesses but may not read /api/admin/route-invoices.
//          The exception is named per role so the admin proof is never silently dropped.
//
// Routes that only redirect are NOT listed. `/opspilot` (→ /operion, next.config.ts)
// and `/admin/operations/ai/shadow` (→ /ai/performance, that page's own redirect) can
// never satisfy a rendered-content assertion, and their destinations are already
// audited below — listing them added zero coverage and 54 false results.
const ROUTES = [
  { path: '/', auth: 'none', ready: 'h1, [data-hero]' },
  { path: '/quote', auth: 'none', ready: 'form, input, button' },
  { path: '/track', auth: 'none', ready: 'input, form' },
  { path: '/about', auth: 'none', ready: 'h1' },
  { path: '/careers', auth: 'none', ready: 'h1' },
  { path: '/reviews', auth: 'none', ready: 'h1' },
  { path: '/safety', auth: 'none', ready: 'h1' },
  { path: '/privacy', auth: 'none', ready: 'h1' },
  { path: '/terms', auth: 'none', ready: 'h1' },
  { path: '/start-your-carrier', auth: 'none', ready: 'h1' },
  // NOTE: '/booking' and '/box-truck-delivery' are NOT listed. Both are parents of
  // dynamic segments (`/booking/[token]`, `/box-truck-delivery/[city]`) with no index
  // page, so they 404 by design. Cover the templates with a concrete instance.
  { path: '/box-truck-delivery/dallas', auth: 'none', ready: 'h1' },
  { path: '/operion', auth: 'none', ready: 'h1' },
  { path: '/coi', auth: 'none', ready: 'h1' },

  // Admin surfaces — every one of these previously passed while showing the
  // sign-in screen whenever ADMIN_PASSWORD was unset.
  { path: '/admin/operations', auth: 'admin', ready: 'nav, header' },
  { path: '/admin/operations/schedule', auth: 'admin', ready: 'h1, table, [role="tablist"]' },
  { path: '/admin/operations/book-now', auth: 'admin', ready: 'h1, table' },
  { path: '/admin/operations/list', auth: 'admin', ready: 'h1, table' },
  { path: '/admin/operations/employees', auth: 'admin', ready: 'h1' },
  // A manager holds `businesses:manage` and this page IS theirs — only the invoice feed
  // (`invoices:manage`) refuses them, so route-invoices is required of admins and not of
  // managers. Narrowing it per role keeps the admin proof intact instead of deleting it.
  { path: '/admin/operations/businesses', auth: 'admin', ready: 'h1',
    data: {
      required: ['/api/admin/route-invoices', '/api/admin/businesses'],
      byRole: { manager: { required: ['/api/admin/businesses'] } },
    } },
  { path: '/admin/operations/equipment', auth: 'admin', ready: 'h1' },
  { path: '/admin/operations/claims', auth: 'admin', ready: 'h1' },
  { path: '/admin/operations/messages', auth: 'admin', ready: 'h1' },
  { path: '/admin/operations/communications', auth: 'admin', ready: 'h1' },
  // `profitability:view` is admin-only (app/lib/rbac.ts), so a manager is refused here by
  // design and must be SHOWN that — the page used to sit in a permanent skeleton instead.
  { path: '/admin/operations/finance', auth: 'admin', ready: 'h1',
    expectDenial: { roles: ['manager'], text: 'Money is restricted to administrators' } },
  // A manager is correctly refused here. That refusal is the app working, so it is
  // asserted on its own terms rather than measured against the admin content.
  { path: '/admin/operations/pay-statements', auth: 'admin', ready: 'h1', readyText: 'Pay Statements',
    expectDenial: { roles: ['manager'], text: 'Pay statements are restricted to administrators' } },
  // The Timesheets table is a deliberate horizontal scroll RAIL with a pinned
  // action column — internal scrolling is legitimate, a hidden action is not.
  { path: '/admin/operations/timesheets', auth: 'admin', ready: 'h1', requireAction: 'select',
    data: { required: ['/api/admin/timesheets'] } },
  // `settings:manage` is admin-only, and every write on this page is admin-only too, so a
  // manager is denied as a whole page rather than shown switches that roll back.
  { path: '/admin/operations/settings', auth: 'admin', ready: 'h1',
    expectDenial: { roles: ['manager'], text: 'Settings is restricted to administrators' } },
  // /api/admin/release is `requireAdmin`.
  { path: '/admin/operations/release', auth: 'admin', ready: 'h1',
    data: { required: ['/api/admin/release'] },
    expectDenial: { roles: ['manager'], text: 'The Release Center is restricted to administrators' } },
  // AI Command Center sections — the data-dense pages most prone to mobile overflow.
  //
  // Every endpoint behind these four is `requirePlatformOwner` — a tier ABOVE admin (see
  // app/api/admin/_lib/session.ts). A named admin and a manager are BOTH refused unless
  // the admin is listed in PLATFORM_OWNER_SUBS, so both must see the Platform Owner state.
  // Only the `owner` identity is measured against the real content.
  { path: '/admin/operations/ai', auth: 'admin', ready: 'h1',
    data: { required: ['/api/admin/ai-overview'] },
    expectDenial: { roles: ['admin', 'manager'], text: 'Platform Owner only' } },
  { path: '/admin/operations/ai/controls', auth: 'admin', ready: 'h1' },
  { path: '/admin/operations/ai/performance', auth: 'admin', ready: 'h1',
    data: { required: ['/api/admin/shadow-learning'] },
    expectDenial: { roles: ['admin', 'manager'], text: 'Platform Owner only' } },
  { path: '/admin/operations/ai/learning', auth: 'admin', ready: 'h1',
    data: { required: ['/api/admin/shadow-learning'] },
    expectDenial: { roles: ['admin', 'manager'], text: 'Platform Owner only' } },
  { path: '/admin/operations/ai/alerts', auth: 'admin', ready: 'h1',
    data: { required: ['/api/admin/ai-alerts'] },
    expectDenial: { roles: ['admin', 'manager'], text: 'Platform Owner only' } },
  // No <h1> on this page at all — its title is a styled <p>. `ready: 'h1'` could
  // therefore never be satisfied, which produced 18 false failures.
  { path: '/admin/disposal', auth: 'admin', ready: 'input, label', readyText: 'Disposal & Pricing' },
  // A crew-authenticated surface, not a public page. Declaring it public made its
  // login gate a layout FAIL on every anonymous, admin and manager run (27 of them).
  { path: '/portal', auth: 'crew', ready: 'h1', readyText: 'Sign out' },
]

// Session probes, one per role family. NOT a universal gate: `/api/admin/timesheets`
// used to be the single proof of authentication, and a crew member legitimately gets
// 403 from it — so a fully valid crew session was recorded as `identity=anonymous`
// while the browser went on rendering authenticated crew pages. Authentication and
// authorization are different questions; a 403 from an endpoint OUTSIDE your role
// answers the second one, never the first.
const ROLE_PROBES = {
  crew: '/api/portal/me',                    // requireCrew — the crew's own session
  manager: '/api/admin/platform/whoami',     // requireStaffSession — any staff principal
  admin: '/api/admin/platform/whoami',
  owner: '/api/admin/platform/whoami',
}

/**
 * Establish WHO we are, using evidence appropriate to that identity.
 * @returns {{ authState: 'ok'|'failed'|'absent', role: string }}
 */
async function resolveIdentity(ctx) {
  // Two ways in, because the owner password is not available everywhere:
  //  • ADMIN_PASSWORD            → the shared owner login (/api/admin/auth)
  //  • AUDIT_EMAIL + AUDIT_PASSWORD → a named user (/api/auth/login), which is how
  //    a Preview run authenticates as a specific admin, MANAGER or CREW without the
  //    owner credential. Role coverage matters: each sees a different surface.
  const pw = process.env.ADMIN_PASSWORD
  const email = process.env.AUDIT_EMAIL
  const userPw = process.env.AUDIT_PASSWORD
  if (!pw && !(email && userPw)) return { authState: 'absent', role: 'anonymous' }
  try {
    const res = pw
      ? await ctx.request.post(`${BASE}/api/admin/auth`, { data: { password: pw } })
      : await ctx.request.post(`${BASE}/api/auth/login`, { data: { email, password: userPw } })
    if (!res.ok()) return { authState: 'failed', role: 'anonymous' }

    // The server tells us the role it just authenticated. That is the authoritative
    // answer — never inferred from what a page happened to render, which would let
    // route content silently elevate an identity.
    const body = await res.json().catch(() => null)
    const role = pw ? 'owner' : (body?.role ?? null)
    if (!role) return { authState: 'failed', role: 'anonymous' }

    // Production correctly marks the session Secure. Local HTTP audits cannot send that
    // cookie automatically, so install the returned token into this isolated localhost
    // browser context with secure=false. Never logs or persists the token.
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(BASE)) {
      const setCookie = res.headers()['set-cookie'] || ''
      const match = setCookie.match(/(?:^|[,;]\s*)jk_admin_session=([^;]+)/)
      if (match) await ctx.addCookies([{ name: 'jk_admin_session', value: match[1], url: BASE, httpOnly: true, secure: false, sameSite: 'Lax' }])
    }

    // Confirm the cookie actually works, against an endpoint THIS role may read.
    const probe = ROLE_PROBES[role]
    if (!probe) return { authState: 'failed', role: 'anonymous' }
    const check = await ctx.request.get(`${BASE}${probe}`)
    return check.ok() ? { authState: 'ok', role } : { authState: 'failed', role: 'anonymous' }
  } catch { return { authState: 'failed', role: 'anonymous' } }
}

// ── Preflight ────────────────────────────────────────────────────────────────
// Fail fast and unambiguously when the app is not up. Without this, every route
// records a connection error and the summary reports them as UI failures — the
// exact misreporting this tool used to produce.
async function preflight(base) {
  try {
    // Carries the same bypass header the browser context uses, so a protected Preview
    // answers directly instead of 30x-ing to SSO and looking like an off-target redirect.
    const res = await fetch(base, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
      ...(process.env.VERCEL_BYPASS ? { headers: { 'x-vercel-protection-bypass': process.env.VERCEL_BYPASS } } : {}),
    })
    return { ok: true, status: res.status, finalUrl: res.url || base }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? (e.cause?.code || e.message) : String(e) }
  }
}

const pre = await preflight(BASE)

// Where we ENDED UP, not where we aimed. An approved origin that redirects onto
// Production is a Production session; stop here rather than launch a browser into it.
if (pre.ok && pre.finalUrl) {
  const finalVerdict = classifyFinalUrl(pre.finalUrl, {
    vercelEnv: process.env.VERCEL_ENV,
    approvedHost: process.env.AUDIT_ALLOWED_HOST,
  })
  if (!finalVerdict.ok) refuseTarget(finalVerdict, 'post-redirect, pre-launch')
}
if (!pre.ok) {
  console.error(`\n==== MOBILE OVERFLOW AUDIT — INFRASTRUCTURE ERROR ====`)
  console.error(`Cannot reach the app at ${BASE}`)
  console.error(`Reason: ${pre.error}`)
  console.error(`\nNo checks were run, and NOTHING is known about the UI.`)
  console.error(`This is NOT a UI finding.\n`)
  console.error(`Start the app first, then re-run. For an isolated local instance see`)
  console.error(`docs/operations/README-local-audit.md. Override the target with:`)
  console.error(`  npm run audit:mobile -- --base http://localhost:3111`)
  console.error(`  BASE=http://localhost:3000 npm run audit:mobile\n`)
  process.exit(2)
}

const browser = await chromium.launch({ executablePath: PW_EXE })
// A protected Vercel Preview 302s every request to SSO. VERCEL_BYPASS carries the
// project's automation bypass secret so the audit can reach it. Never logged.
const ctx = await browser.newContext({
  deviceScaleFactor: 1,
  ...(process.env.VERCEL_BYPASS ? { extraHTTPHeaders: { 'x-vercel-protection-bypass': process.env.VERCEL_BYPASS } } : {}),
})
const { authState, role: ACTIVE_ROLE } = await resolveIdentity(ctx)
// Recorded on every result so a report can never be read as "some admin somewhere".
// The role comes from the server's own answer, not from AUDIT_IDENTITY — a label
// cannot be allowed to disagree with the principal that actually signed in.
const IDENTITY = authState === 'ok' ? ACTIVE_ROLE : 'anonymous'
const page = await ctx.newPage()
if (SHOT_DIR) fs.mkdirSync(SHOT_DIR, { recursive: true })

const results = []
let aborted = false
for (const route of ROUTES) {
  const path = route.path
  if (ONLY && !ONLY.includes(path)) continue
  const requiredRole = route.auth ?? 'none'
  const requiresAuth = requiredRole !== 'none'
  // This principal is SUPPOSED to be refused here — assert the denial, not the content.
  const expectedDenial = !!route.expectDenial?.roles?.includes(IDENTITY)
  const denialText = expectedDenial ? route.expectDenial.text : null

  // A route whose required role we do not hold was never really visited. Record it as
  // blocked for every viewport instead of measuring the sign-in screen and calling it
  // a pass — and never quietly relabel a different identity as the one it needs.
  if (!roleSatisfiesRoute(requiredRole, IDENTITY)) {
    for (const { w } of VIEWPORTS) {
      const { outcome, detail, state } = classifyRoute({ requiredRole, activeRole: IDENTITY, authState, requestedPath: path })
      results.push({ path, width: w, outcome, detail, state, finalPath: null, identity: IDENTITY, assertion: route.readyText ?? route.ready ?? null, evidence: null })
    }
    continue
  }

  for (const { w, h } of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h })
    let checkInput = {}

    // Listeners are attached BEFORE navigation, or the errors thrown during the very
    // render we care about are the ones we miss. Everything is redacted on the way in:
    // console text is captured from the page and written to a report, so it is an
    // exfiltration path, and a value that reaches the results array has already escaped.
    const rawConsole = []
    const rawPageErrors = []
    const observedRequests = []
    const onConsole = (m) => {
      const type = m.type()
      const text = m.text()
      // Warnings only count when they describe a runtime/data failure — React logs
      // plenty of advice nobody needs the audit to fail on.
      if (type === 'error' || (type === 'warning' && /hydrat|did not match|failed|error/i.test(text))) {
        rawConsole.push(redactMessage(text))
      }
    }
    const onPageError = (e) => rawPageErrors.push(redactMessage(e?.message ?? e))
    const onCrash = () => rawPageErrors.push('Page crashed')
    const onResponse = (r) => {
      const url = r.url()
      if (!isApplicationRequest(url, BASE)) return
      try { observedRequests.push({ path: new URL(url).pathname, method: r.request().method(), status: r.status() }) } catch { /* ignore */ }
    }
    const onRequestFailed = (r) => {
      const url = r.url()
      if (!isApplicationRequest(url, BASE)) return
      try { observedRequests.push({ path: new URL(url).pathname, method: r.method(), status: 0 }) } catch { /* ignore */ }
    }
    page.on('console', onConsole)
    page.on('pageerror', onPageError)
    page.on('crash', onCrash)
    page.on('response', onResponse)
    page.on('requestfailed', onRequestFailed)
    // Summarized lazily so the catch path reports the same signals as the happy path.
    const signals = () => summarizeRuntimeSignals({ consoleErrors: rawConsole, pageErrors: rawPageErrors })
    // Required endpoints are resolved for THIS principal: a role that is not supposed to
    // read one of them must not be failed for being refused it.
    const requiredEndpoints = requiredEndpointsFor(route.data, IDENTITY)
    const requests = () => evaluateRequests(observedRequests, requiredEndpoints)

    try {
      const resp = await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 20000 })
      // Measure AFTER hydration, not the server shell. `networkidle` is best-effort:
      // a page that keeps a socket open must not fail the audit for that alone.
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})

      // A role that is supposed to be refused proves the DENIAL card instead. Text,
      // not a selector: the card is deliberately plain, and matching structure would
      // let any styled paragraph on any page satisfy it.
      let denialTextFound = null
      if (expectedDenial) {
        denialTextFound = await page.waitForFunction(
          (t) => (document.body?.innerText || '').includes(t),
          denialText, { timeout: 10000 },
        ).then(() => true).catch(() => false)
      }

      // The readiness proof: wait for the route's own content to mount. Its ABSENCE
      // is the finding — this is what a blank client shell can never satisfy.
      let readinessFound = null
      if (route.ready && !expectedDenial) {
        // ANY visible match, not `.first()`. A page can legitimately carry hidden
        // instances of the selector (a collapsed menu, an off-canvas control), and
        // waiting on the first DOM match made a fully-rendered page look unready —
        // /quote failed at 320-430 for exactly that reason during verification.
        readinessFound = await page.waitForFunction(
          (sel) => [...document.querySelectorAll(sel)].some((el) => {
            const r = el.getBoundingClientRect()
            return r.width > 0 && r.height > 0
          }),
          route.ready, { timeout: 10000 },
        ).then(() => true).catch(() => false)
      } else if (!expectedDenial) {
        await page.waitForTimeout(500)
      }

      // Route-specific TEXT proof, where a selector cannot distinguish this page from
      // any other admin page — or where the page has no matching element at all.
      let readinessTextFound = null
      if (route.readyText && !expectedDenial) {
        readinessTextFound = await page.waitForFunction(
          (t) => (document.body?.innerText || '').includes(t),
          route.readyText, { timeout: 10000 },
        ).then(() => true).catch(() => false)
      }

      // The DATA proof. A route may accept EITHER a populated result or an explicit
      // empty state — requiring records would fail a correct page that simply has none.
      let dataLoadedFound = null
      let dataEmptyFound = null
      if (!expectedDenial && (route.data?.loadedText || route.data?.emptyText)) {
        const wanted = [route.data.loadedText, route.data.emptyText].filter(Boolean)
        await page.waitForFunction(
          (texts) => texts.some((t) => (document.body?.innerText || '').includes(t)),
          wanted, { timeout: 10000 },
        ).catch(() => {})
        const body = await page.evaluate(() => document.body?.innerText || '')
        if (route.data.loadedText) dataLoadedFound = body.includes(route.data.loadedText)
        if (route.data.emptyText) dataEmptyFound = body.includes(route.data.emptyText)
      }
      if (CLICK_TEXT) {
        const target = page.getByRole('tab', { name: CLICK_TEXT, exact: true })
        await target.waitFor({ state: 'visible', timeout: 5000 })
        const targetCount = await target.count()
        if (targetCount !== 1) throw new Error(`CLICK_TEXT target count ${targetCount}: ${CLICK_TEXT}`)
        await target.click()
        const loadingPanel = page.locator('.skeleton')
        if (await loadingPanel.count() === 1) await loadingPanel.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {})
      }
      const m = await page.evaluate(() => {
        const de = document.documentElement
        const sw = de.scrollWidth, cw = de.clientWidth
        const offenders = []
        if (sw > cw + 1) {
          for (const el of document.querySelectorAll('body *')) {
            const r = el.getBoundingClientRect()
            if (r.right > cw + 1 && r.width > 1 && r.left < cw + 40) {
              const cls = (typeof el.className === 'string' && el.className) ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
              offenders.push(`${el.tagName.toLowerCase()}${cls} L=${Math.round(r.left)} R=${Math.round(r.right)} w=${Math.round(r.width)}`)
            }
          }
        }
        // Controls fully off-screen AND not reachable by scrolling a real rail.
        const reachableViaRail = (el) => {
          let p = el.parentElement
          while (p) {
            const cs = getComputedStyle(p)
            if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && p.scrollWidth > p.clientWidth + 1) return true
            p = p.parentElement
          }
          return false
        }
        const clipped = []
        for (const el of document.querySelectorAll('button,a,input,select,textarea,[data-fab]')) {
          const cs = getComputedStyle(el)
          if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0' || el.closest('[aria-hidden="true"]')) continue
          const r = el.getBoundingClientRect()
          if (r.width > 0 && r.height > 0 && (r.right <= 1 || r.left >= cw - 1)) {
            if (reachableViaRail(el)) continue
            const label = el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 22) || el.tagName.toLowerCase()
            const cls = (typeof el.className === 'string' && el.className) ? '.' + el.className.trim().split(/\s+/)[0] : ''
            clipped.push(`"${label}"${cls} L=${Math.round(r.left)} R=${Math.round(r.right)}`)
          }
        }
        // Facts about WHAT rendered — the classifier decides what they mean.
        const bodyText = (document.body?.innerText || '').trim()
        const loginish = !!document.querySelector('input[type="password"]')
        const errorish = /application error|something went wrong|unhandled runtime error|500 - internal/i.test(bodyText.slice(0, 400))
        const skeleton = !!document.querySelector('.skeleton:not([hidden]), [data-loading="true"], [aria-busy="true"]')
        return {
          sw, cw, offenders: offenders.slice(0, 8), clipped: [...new Set(clipped)].slice(0, 6),
          bodyTextLength: bodyText.length, hasLoginForm: loginish, hasErrorBoundary: errorish,
          skeletonStillVisible: skeleton,
          finalPath: location.pathname,
        }
      })
      let actionVisible = null
      if (route.requireAction) {
        actionVisible = await page.locator(route.requireAction).first().isVisible().catch(() => false)
      }
      checkInput = {
        requestedPath: path, finalPath: m.finalPath,
        requiredRole, activeRole: IDENTITY, requiresAuth, authState,
        canonicalRedirect: route.canonicalRedirect ?? null,
        httpStatus: resp ? resp.status() : null,
        bodyTextLength: m.bodyTextLength, hasLoginForm: m.hasLoginForm,
        hasErrorBoundary: m.hasErrorBoundary, skeletonStillVisible: m.skeletonStillVisible,
        readinessSelector: route.ready ?? null, readinessFound,
        readinessText: route.readyText ?? null, readinessTextFound,
        expectedDenial, denialText, denialTextFound,
        dataLoadedText: route.data?.loadedText ?? null, dataLoadedFound,
        dataEmptyText: route.data?.emptyText ?? null, dataEmptyFound,
        ...signals(), ...requests(),
        requireActionSelector: route.requireAction ?? null, actionVisible,
        scrollWidth: m.sw, clientWidth: m.cw, offenders: m.offenders, clipped: m.clipped,
      }
    } catch (e) {
      checkInput = {
        requestedPath: path, requiredRole, activeRole: IDENTITY, requiresAuth, authState,
        error: String(e?.message || e), ...signals(), ...requests(),
      }
    } finally {
      page.off('console', onConsole)
      page.off('pageerror', onPageError)
      page.off('crash', onCrash)
      page.off('response', onResponse)
      page.off('requestfailed', onRequestFailed)
    }
    const { outcome, detail, state } = classifyRoute(checkInput)

    // Evidence for EVERY non-pass, not just the four screenshot widths — a failure
    // you cannot look at is a failure you cannot act on.
    let evidence = null
    if (SHOT_DIR && (outcome !== 'PASS' || SHOT_WIDTHS.has(w))) {
      const slug = path === '/' ? 'root' : path.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '')
      evidence = `${SHOT_DIR}/${LABEL}__${slug}__${w}__${outcome}.png`
      await page.screenshot({ path: evidence }).catch(() => { evidence = null })
    }
    results.push({
      path, width: w, outcome, detail, state,
      finalPath: checkInput.finalPath ?? null, identity: IDENTITY,
      requestedUrl: BASE + path,
      assertion: expectedDenial ? denialText : (route.readyText ?? route.ready ?? null),
      dataAssertion: route.data ? (route.data.loadedText ?? (requiredEndpointsFor(route.data, IDENTITY).join(', ') || null)) : null,
      requiredFailures: checkInput.requiredFailures ?? [],
      missingRequired: checkInput.missingRequired ?? [],
      otherFailures: checkInput.otherFailures ?? [],
      consoleErrors: checkInput.consoleErrors ?? [],
      networkEchoes: checkInput.networkEchoes ?? [],
      pageErrors: checkInput.pageErrors ?? [],
      hydrationErrors: checkInput.hydrationErrors ?? [],
      evidence,
    })

    // A connection failure mid-run means the server went away; every remaining
    // check would record the same thing. Stop rather than manufacture hundreds of
    // identical "failures" that say nothing about the UI.
    if (outcome === 'BLOCKED_ENV') {
      console.error(`\n!! app became unreachable at ${path} @${w} — aborting run (${detail})`)
      aborted = true
      break
    }
  }
  if (aborted) break
}
await browser.close()

const { counts, exitCode, fullyMeasured, blocked } = summarizeRoutes(results)

console.log(`\n==== MOBILE AUDIT (identity=${IDENTITY}, base=${BASE}) ====`)
console.log(`${results.length} checks run${aborted ? ' (ABORTED EARLY)' : ''}`)
console.log(`  PASS           ${counts.PASS}      <- content PROVEN rendered, layout held`)
console.log(`  FAIL           ${counts.FAIL}      <- real finding (blank/login/error/skeleton/overflow/hidden action)`)
console.log(`  ROUTE_ERROR    ${counts.ROUTE_ERROR}      <- real finding (HTTP >= 400)`)
console.log(`  BLOCKED_AUTH   ${counts.BLOCKED_AUTH}      <- NOT measured: the required role was not established`)
console.log(`  BLOCKED_ENV    ${counts.BLOCKED_ENV}      <- NOT measured: app unreachable`)
console.log(`  INCONCLUSIVE   ${counts.INCONCLUSIVE}      <- NOT measured: navigation/timeout`)

if (!fullyMeasured) {
  console.log(`\n!! ${blocked} check(s) were NOT measured. They are not passes and are not UI findings.`)
  if (counts.BLOCKED_AUTH > 0) {
    console.log(`   Supply a credential for the role each route needs (ADMIN_PASSWORD, or AUDIT_EMAIL/AUDIT_PASSWORD`)
    console.log(`   for a named admin, manager or crew account). Without it those routes are skipped, never passed.`)
  }
}

const uiFindings = results.filter(r => r.outcome === 'FAIL' || r.outcome === 'ROUTE_ERROR')
if (uiFindings.length) {
  console.log(`\n---- findings ----`)
  for (const r of uiFindings) {
    console.log(`${r.outcome} ${r.path} @${r.width} [as ${r.identity}${r.state ? `/${r.state}` : ''}] rendered=${r.finalPath ?? 'n/a'} assert=${r.assertion ?? 'none'}`)
    console.log(`       ${r.detail}${r.evidence ? `  → ${r.evidence}` : ''}`)
    if (r.requiredFailures?.length) console.log(`       required endpoints: ${r.requiredFailures.join(', ')}`)
    if (r.missingRequired?.length) console.log(`       required endpoints never called: ${r.missingRequired.join(', ')}`)
    if (r.pageErrors?.length) console.log(`       page errors: ${r.pageErrors.join(' | ')}`)
    if (r.hydrationErrors?.length) console.log(`       hydration: ${r.hydrationErrors.join(' | ')}`)
    if (r.consoleErrors?.length) console.log(`       console: ${r.consoleErrors.join(' | ')}`)
    if (r.networkEchoes?.length) console.log(`       (console echoes of subresource failures — judged by the network contract, not here): ${r.networkEchoes.join(' | ')}`)
    if (r.otherFailures?.length) console.log(`       other (non-disqualifying) request failures: ${r.otherFailures.join(', ')}`)
  }
}

// Reported, never auto-failed: a flaky background request must not become the kind of
// false FAIL Wave 2 spent a whole PR removing. It is still visible.
const noisyPasses = results.filter(r => r.outcome === 'PASS' && r.otherFailures?.length)
if (noisyPasses.length) {
  console.log(`\n---- non-disqualifying request failures on passing routes ----`)
  const seen = new Set()
  for (const r of noisyPasses) {
    for (const f of r.otherFailures) {
      const k = `${r.path} ${f}`
      if (seen.has(k)) continue
      seen.add(k)
      console.log(`${r.path} [as ${r.identity}]  ${f}`)
    }
  }
}

const notMeasured = results.filter(r => ROUTE_BLOCKED_OUTCOMES.includes(r.outcome))
if (notMeasured.length) {
  console.log(`\n---- NOT MEASURED (not passes, not findings) ----`)
  for (const r of notMeasured) console.log(`${r.outcome} ${r.path} @${r.width}  ${r.detail}`)
}

// Per-route verdict. A route is only PASS when every viewport was MEASURED and
// passed — "no findings" is not the same as "passed", which is precisely how
// blocked admin routes used to be reported clean.
console.log('\n---- per-route ----')
const byPath = {}
for (const r of results) (byPath[r.path] ??= []).push(r)
for (const [p, rs] of Object.entries(byPath)) {
  const f = rs.filter(x => x.outcome === 'FAIL' || x.outcome === 'ROUTE_ERROR')
  const b = rs.filter(x => ROUTE_BLOCKED_OUTCOMES.includes(x.outcome))
  const verdict = f.length ? 'FAIL' : b.length ? b[0].outcome : 'PASS'
  const note = f.length ? `${f.length}/${rs.length} with findings @ ${f.map(x => x.width).join(',')}`
    : b.length ? `${b.length}/${rs.length} not measured — ${b[0].detail}`
    : rs.every(x => x.state === 'denial') ? `${rs.length}/${rs.length} proved the EXPECTED DENIAL state (not the admin workflow)`
    : `${rs.length}/${rs.length} measured and passed`
  console.log(`${verdict} ${p} (${note})`)
}
if (SHOT_DIR) console.log(`\nscreenshots → ${SHOT_DIR}/`)
console.log(`\nexit ${exitCode}  (0 = clean, 1 = real UI findings, 2 = could not measure)`)
process.exit(exitCode)
