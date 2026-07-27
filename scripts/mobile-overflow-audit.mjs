// Mobile viewport overflow audit (Playwright, headless-shell). Permanent regression
// tool — run with:  npm run audit:mobile
//
//   PW_EXE=<chrome-headless-shell path> BASE=http://localhost:3111 \
//     [SHOT_DIR=shots] [LABEL=run] [ONLY=/,/quote] [ADMIN_PASSWORD=…]
//     [CLICK_TEXT="Activation Readiness"] \
//     node scripts/mobile-overflow-audit.mjs
//
// For every route × viewport it verifies documentElement.scrollWidth ==
// clientWidth, pinpoints the exact overflowing elements by bounding rect, flags
// genuinely-unreachable controls (fully off-screen AND not inside a real
// horizontal scroll-rail), and (with SHOT_DIR) captures screenshots at key widths.
// With ADMIN_PASSWORD it authenticates so /admin/* and /portal render the real
// authenticated UI instead of the sign-in screen.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import { classifyCheck, summarize, INFRA_OUTCOMES } from './mobile-audit-classify.mjs'

const INFRA_LIKE = new Set(INFRA_OUTCOMES)

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
const PATHS = [
  '/', '/quote', '/track', '/about', '/careers', '/reviews', '/safety',
  '/privacy', '/terms', '/start-your-carrier',
  // NOTE: '/booking' and '/box-truck-delivery' are NOT listed. Both are parents of
  // dynamic segments (`/booking/[token]`, `/box-truck-delivery/[city]`) with no index
  // page, so they 404 by design. They sat in this list returning HTTP 404 on every
  // run, which the old reporter counted as 18 UI failures. To cover those templates,
  // pass a concrete instance instead, e.g.
  //   ONLY=/box-truck-delivery/dallas npm run audit:mobile
  '/box-truck-delivery/dallas',
  '/opspilot', '/operion', '/coi',
  '/admin/operations', '/admin/operations/schedule', '/admin/operations/book-now', '/admin/operations/list',
  '/admin/operations/employees', '/admin/operations/businesses', '/admin/operations/equipment',
  '/admin/operations/claims', '/admin/operations/messages', '/admin/operations/communications',
  '/admin/operations/finance', '/admin/operations/pay-statements', '/admin/operations/timesheets',
  '/admin/operations/settings',
  '/admin/operations/release',
  // AI Command Center sections — the data-dense pages most prone to mobile overflow.
  '/admin/operations/ai', '/admin/operations/ai/controls', '/admin/operations/ai/performance',
  '/admin/operations/ai/learning', '/admin/operations/ai/shadow', '/admin/operations/ai/alerts',
  '/admin/disposal',
  '/portal',
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
const page = await ctx.newPage()
if (SHOT_DIR) fs.mkdirSync(SHOT_DIR, { recursive: true })

const results = []
let aborted = false
for (const path of PATHS) {
  if (ONLY && !ONLY.includes(path)) continue
  for (const { w, h } of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h })
    let checkInput = {}
    try {
      const resp = await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForTimeout(500)
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
        return { sw, cw, offenders: offenders.slice(0, 8), clipped: [...new Set(clipped)].slice(0, 6) }
      })
      checkInput = {
        httpStatus: resp ? resp.status() : null,
        scrollWidth: m.sw, clientWidth: m.cw, offenders: m.offenders, clipped: m.clipped,
      }
      if (SHOT_DIR && SHOT_WIDTHS.has(w)) {
        const name = `${LABEL}__${(path === '/' ? 'root' : path.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, ''))}__${w}.png`
        await page.screenshot({ path: `${SHOT_DIR}/${name}` })
      }
    } catch (e) {
      checkInput = { error: String(e?.message || e) }
    }
    const { outcome, detail } = classifyCheck(checkInput)
    results.push({ path, width: w, outcome, detail })

    // A connection failure mid-run means the server went away; every remaining
    // check would record the same thing. Stop rather than manufacture hundreds of
    // identical "failures" that say nothing about the UI.
    if (outcome === 'infrastructure_unavailable') {
      console.error(`\n!! app became unreachable at ${path} @${w} — aborting run (${detail})`)
      aborted = true
      break
    }
  }
  if (aborted) break
}
await browser.close()

const { counts, exitCode, measured } = summarize(results)

console.log(`\n==== MOBILE OVERFLOW AUDIT (auth=${authed}, base=${BASE}) ====`)
console.log(`${results.length} checks run${aborted ? ' (ABORTED EARLY)' : ''}`)
console.log(`  ok                        ${counts.ok}`)
console.log(`  overflow                  ${counts.overflow}      <- real UI findings`)
console.log(`  page_error                ${counts.page_error}      <- real page findings (HTTP >= 400)`)
console.log(`  navigation_error          ${counts.navigation_error}      <- harness/timeout, NOT a UI finding`)
console.log(`  infrastructure_unavailable ${counts.infrastructure_unavailable}     <- app unreachable, NOTHING measured`)

if (!measured) {
  console.log(`\n!! The app became unreachable. These are NOT UI findings — nothing was measured.`)
}

const uiFindings = results.filter(r => r.outcome === 'overflow' || r.outcome === 'page_error')
if (uiFindings.length) {
  console.log(`\n---- findings ----`)
  for (const r of uiFindings) console.log(`${r.outcome.toUpperCase()} ${r.path} @${r.width}  ${r.detail}`)
}

const harness = results.filter(r => INFRA_LIKE.has(r.outcome))
if (harness.length) {
  console.log(`\n---- harness / environment (not UI findings) ----`)
  for (const r of harness) console.log(`${r.outcome} ${r.path} @${r.width}  ${r.detail}`)
}

console.log('\n---- per-route ----')
const byPath = {}
for (const r of results) (byPath[r.path] ??= []).push(r)
for (const [p, rs] of Object.entries(byPath)) {
  const f = rs.filter(x => x.outcome === 'overflow' || x.outcome === 'page_error')
  console.log(`${f.length === 0 ? 'PASS' : 'FAIL'} ${p} (${f.length}/${rs.length} with findings${f.length ? ' @ ' + f.map(x => x.width).join(',') : ''})`)
}
if (SHOT_DIR) console.log(`\nscreenshots → ${SHOT_DIR}/`)
console.log(`\nexit ${exitCode}  (0 = clean, 1 = real UI findings, 2 = could not measure)`)
process.exit(exitCode)
