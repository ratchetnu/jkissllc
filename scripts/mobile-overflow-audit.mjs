// Mobile viewport overflow audit (Playwright, headless-shell). Permanent regression
// tool — run with:  npm run audit:mobile
//
//   PW_EXE=<chrome-headless-shell path> BASE=http://localhost:3111 \
//     [SHOT_DIR=shots] [LABEL=run] [ONLY=/,/quote] [ADMIN_PASSWORD=…] [AUDIT_IDENTITY=…]
//     [CLICK_TEXT="Activation Readiness"] \
//     node scripts/mobile-overflow-audit.mjs
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
import { classifyRoute, summarizeRoutes, ROUTE_BLOCKED_OUTCOMES } from './mobile-audit-classify.mjs'


// Base URL resolution, in precedence order: --base flag, BASE env, default.
// The app must already be running — this tool measures a live server and cannot
// start one. See README-local-audit.md for how to bring up an isolated instance.
const DEFAULT_BASE = 'http://localhost:3111'
function resolveBase(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--base')
  if (i >= 0 && argv[i + 1]) return argv[i + 1].replace(/\/$/, '')
  return (process.env.BASE || DEFAULT_BASE).replace(/\/$/, '')
}
const BASE = resolveBase()
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
//   auth:  'none' | 'admin'  — an 'admin' route is BLOCKED_AUTH unless we are signed in
//   ready: a CSS selector (or {text}) that only exists once the real content mounted.
//          Deliberately per-route: one universal title check would pass on the shell.
//   requireAction: a selector for a primary action that must be visibly reachable.
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
  { path: '/opspilot', auth: 'none', ready: 'h1' },
  { path: '/operion', auth: 'none', ready: 'h1' },
  { path: '/coi', auth: 'none', ready: 'h1' },

  // Admin surfaces — every one of these previously passed while showing the
  // sign-in screen whenever ADMIN_PASSWORD was unset.
  { path: '/admin/operations', auth: 'admin', ready: 'nav, header' },
  { path: '/admin/operations/schedule', auth: 'admin', ready: 'h1, table, [role="tablist"]' },
  { path: '/admin/operations/book-now', auth: 'admin', ready: 'h1, table' },
  { path: '/admin/operations/list', auth: 'admin', ready: 'h1, table' },
  { path: '/admin/operations/employees', auth: 'admin', ready: 'h1' },
  { path: '/admin/operations/businesses', auth: 'admin', ready: 'h1' },
  { path: '/admin/operations/equipment', auth: 'admin', ready: 'h1' },
  { path: '/admin/operations/claims', auth: 'admin', ready: 'h1' },
  { path: '/admin/operations/messages', auth: 'admin', ready: 'h1' },
  { path: '/admin/operations/communications', auth: 'admin', ready: 'h1' },
  { path: '/admin/operations/finance', auth: 'admin', ready: 'h1' },
  { path: '/admin/operations/pay-statements', auth: 'admin', ready: 'h1' },
  // The Timesheets table is a deliberate horizontal scroll RAIL with a pinned
  // action column — internal scrolling is legitimate, a hidden action is not.
  { path: '/admin/operations/timesheets', auth: 'admin', ready: 'h1', requireAction: 'select' },
  { path: '/admin/operations/settings', auth: 'admin', ready: 'h1' },
  { path: '/admin/operations/release', auth: 'admin', ready: 'h1' },
  // AI Command Center sections — the data-dense pages most prone to mobile overflow.
  { path: '/admin/operations/ai', auth: 'admin', ready: 'h1' },
  { path: '/admin/operations/ai/controls', auth: 'admin', ready: 'h1' },
  { path: '/admin/operations/ai/performance', auth: 'admin', ready: 'h1' },
  { path: '/admin/operations/ai/learning', auth: 'admin', ready: 'h1' },
  { path: '/admin/operations/ai/shadow', auth: 'admin', ready: 'h1' },
  { path: '/admin/operations/ai/alerts', auth: 'admin', ready: 'h1' },
  { path: '/admin/disposal', auth: 'admin', ready: 'h1' },
  { path: '/portal', auth: 'none', ready: 'h1, form, input' },
]

async function maybeAuth(ctx) {
  const pw = process.env.ADMIN_PASSWORD
  if (!pw) return false
  try {
    const res = await ctx.request.post(`${BASE}/api/admin/auth`, { data: { password: pw } })
    if (!res.ok()) return false
    // Production correctly marks the session Secure. Local HTTP audits cannot send that
    // cookie automatically, so install the returned token into this isolated localhost
    // browser context with secure=false. Never logs or persists the token.
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(BASE)) {
      const setCookie = res.headers()['set-cookie'] || ''
      const match = setCookie.match(/(?:^|[,;]\s*)jk_admin_session=([^;]+)/)
      if (match) await ctx.addCookies([{ name: 'jk_admin_session', value: match[1], url: BASE, httpOnly: true, secure: false, sameSite: 'Lax' }])
    }
    const check = await ctx.request.get(`${BASE}/api/admin/platform/whoami`)
    return check.ok() && (await check.json().catch(() => null))?.owner === true
  } catch { return false }
}

// ── Preflight ────────────────────────────────────────────────────────────────
// Fail fast and unambiguously when the app is not up. Without this, every route
// records a connection error and the summary reports them as UI failures — the
// exact misreporting this tool used to produce.
async function preflight(base) {
  try {
    const res = await fetch(base, { method: 'GET', signal: AbortSignal.timeout(10000) })
    return { ok: true, status: res.status }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? (e.cause?.code || e.message) : String(e) }
  }
}

const pre = await preflight(BASE)
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
const ctx = await browser.newContext({ deviceScaleFactor: 1 })
const authed = await maybeAuth(ctx)
// Recorded on every result so a report can never be read as "some admin somewhere".
const IDENTITY = authed ? (process.env.AUDIT_IDENTITY || 'owner/admin') : 'anonymous'
const page = await ctx.newPage()
if (SHOT_DIR) fs.mkdirSync(SHOT_DIR, { recursive: true })

const results = []
let aborted = false
const authState = authed ? 'ok' : (process.env.ADMIN_PASSWORD ? 'failed' : 'absent')
for (const route of ROUTES) {
  const path = route.path
  if (ONLY && !ONLY.includes(path)) continue
  const requiresAuth = route.auth === 'admin'

  // An admin route with no session was never really visited. Record it as blocked
  // for every viewport instead of measuring the sign-in screen and calling it a pass.
  if (requiresAuth && authState !== 'ok') {
    for (const { w } of VIEWPORTS) {
      const { outcome, detail } = classifyRoute({ requiresAuth, authState, requestedPath: path })
      results.push({ path, width: w, outcome, detail, finalPath: null, identity: IDENTITY, assertion: route.ready ?? null, evidence: null })
    }
    continue
  }

  for (const { w, h } of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h })
    let checkInput = {}
    try {
      const resp = await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 20000 })
      // Measure AFTER hydration, not the server shell. `networkidle` is best-effort:
      // a page that keeps a socket open must not fail the audit for that alone.
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})

      // The readiness proof: wait for the route's own content to mount. Its ABSENCE
      // is the finding — this is what a blank client shell can never satisfy.
      let readinessFound = null
      if (route.ready) {
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
      } else {
        await page.waitForTimeout(500)
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
        requiresAuth, authState,
        httpStatus: resp ? resp.status() : null,
        bodyTextLength: m.bodyTextLength, hasLoginForm: m.hasLoginForm,
        hasErrorBoundary: m.hasErrorBoundary, skeletonStillVisible: m.skeletonStillVisible,
        readinessSelector: route.ready ?? null, readinessFound,
        requireActionSelector: route.requireAction ?? null, actionVisible,
        scrollWidth: m.sw, clientWidth: m.cw, offenders: m.offenders, clipped: m.clipped,
      }
    } catch (e) {
      checkInput = { requestedPath: path, requiresAuth, authState, error: String(e?.message || e) }
    }
    const { outcome, detail } = classifyRoute(checkInput)

    // Evidence for EVERY non-pass, not just the four screenshot widths — a failure
    // you cannot look at is a failure you cannot act on.
    let evidence = null
    if (SHOT_DIR && (outcome !== 'PASS' || SHOT_WIDTHS.has(w))) {
      const slug = path === '/' ? 'root' : path.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '')
      evidence = `${SHOT_DIR}/${LABEL}__${slug}__${w}__${outcome}.png`
      await page.screenshot({ path: evidence }).catch(() => { evidence = null })
    }
    results.push({
      path, width: w, outcome, detail,
      finalPath: checkInput.finalPath ?? null, identity: IDENTITY,
      assertion: route.ready ?? null, evidence,
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
console.log(`  BLOCKED_AUTH   ${counts.BLOCKED_AUTH}      <- NOT measured: no session for an admin route`)
console.log(`  BLOCKED_ENV    ${counts.BLOCKED_ENV}      <- NOT measured: app unreachable`)
console.log(`  INCONCLUSIVE   ${counts.INCONCLUSIVE}      <- NOT measured: navigation/timeout`)

if (!fullyMeasured) {
  console.log(`\n!! ${blocked} check(s) were NOT measured. They are not passes and are not UI findings.`)
  if (counts.BLOCKED_AUTH > 0) {
    console.log(`   Set ADMIN_PASSWORD (and BASE) to measure admin routes; without a session they are skipped, never passed.`)
  }
}

const uiFindings = results.filter(r => r.outcome === 'FAIL' || r.outcome === 'ROUTE_ERROR')
if (uiFindings.length) {
  console.log(`\n---- findings ----`)
  for (const r of uiFindings) {
    console.log(`${r.outcome} ${r.path} @${r.width} [as ${r.identity}] rendered=${r.finalPath ?? 'n/a'} assert=${r.assertion ?? 'none'}`)
    console.log(`       ${r.detail}${r.evidence ? `  → ${r.evidence}` : ''}`)
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
    : `${rs.length}/${rs.length} measured and passed`
  console.log(`${verdict} ${p} (${note})`)
}
if (SHOT_DIR) console.log(`\nscreenshots → ${SHOT_DIR}/`)
console.log(`\nexit ${exitCode}  (0 = clean, 1 = real UI findings, 2 = could not measure)`)
process.exit(exitCode)
