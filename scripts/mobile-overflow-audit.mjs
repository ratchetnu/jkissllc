// Mobile viewport overflow audit (Playwright, headless-shell). Permanent regression
// tool — run with:  npm run audit:mobile
//
//   PW_EXE=<chrome-headless-shell path> BASE=http://localhost:3111 \
//     [SHOT_DIR=shots] [LABEL=run] [ONLY=/,/quote] [ADMIN_PASSWORD=…] \
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

const BASE = process.env.BASE || 'http://localhost:3111'
const PW_EXE = process.env.PW_EXE || undefined
const SHOT_DIR = process.env.SHOT_DIR || null
const LABEL = process.env.LABEL || 'run'
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null
const SHOT_WIDTHS = new Set([320, 390, 768, 1280])

const VIEWPORTS = [
  { w: 320, h: 568 }, { w: 360, h: 800 }, { w: 375, h: 667 }, { w: 390, h: 844 },
  { w: 393, h: 852 }, { w: 414, h: 896 }, { w: 430, h: 932 }, { w: 768, h: 1024 }, { w: 1280, h: 900 },
]
const PATHS = [
  '/', '/quote', '/track', '/about', '/careers', '/reviews', '/safety',
  '/privacy', '/terms', '/booking', '/box-truck-delivery', '/start-your-carrier',
  '/opspilot', '/operion', '/coi',
  '/admin/operations', '/admin/operations/schedule', '/admin/operations/book-now', '/admin/operations/list',
  '/admin/operations/employees', '/admin/operations/businesses', '/admin/operations/equipment',
  '/admin/operations/claims', '/admin/operations/messages', '/admin/operations/communications',
  '/admin/operations/finance', '/admin/operations/pay-statements', '/admin/operations/settings',
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
    return res.ok()
  } catch { return false }
}

const browser = await chromium.launch({ executablePath: PW_EXE })
const ctx = await browser.newContext({ deviceScaleFactor: 1 })
const authed = await maybeAuth(ctx)
const page = await ctx.newPage()
if (SHOT_DIR) fs.mkdirSync(SHOT_DIR, { recursive: true })

const results = []
for (const path of PATHS) {
  if (ONLY && !ONLY.includes(path)) continue
  for (const { w, h } of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h })
    let ok = true, info = ''
    try {
      const resp = await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForTimeout(500)
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
      if (m.sw > m.cw + 1) { ok = false; info = `scrollW=${m.sw} clientW=${m.cw} :: ${m.offenders.join(' | ')}` }
      if (m.clipped.length) { ok = false; info += ` CLIPPED:[${m.clipped.join(',')}]` }
      if (resp && resp.status() >= 400) info += ` [HTTP ${resp.status()}]`
      if (SHOT_DIR && SHOT_WIDTHS.has(w)) {
        const name = `${LABEL}__${(path === '/' ? 'root' : path.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, ''))}__${w}.png`
        await page.screenshot({ path: `${SHOT_DIR}/${name}` })
      }
    } catch (e) { ok = false; info = 'ERR ' + String(e.message || e).slice(0, 90) }
    results.push({ path, width: w, ok, info })
  }
}
await browser.close()

const bad = results.filter(r => !r.ok)
console.log(`\n==== MOBILE OVERFLOW AUDIT (auth=${authed}) : ${results.length} checks, ${bad.length} failures ====`)
for (const r of bad) console.log(`FAIL ${r.path} @${r.width}  ${r.info}`)
console.log('\n---- per-route ----')
const byPath = {}
for (const r of results) (byPath[r.path] ??= []).push(r)
for (const [p, rs] of Object.entries(byPath)) {
  const f = rs.filter(x => !x.ok)
  console.log(`${f.length === 0 ? 'PASS' : 'FAIL'} ${p} (${f.length}/${rs.length} bad${f.length ? ' @ ' + f.map(x => x.width).join(',') : ''})`)
}
if (SHOT_DIR) console.log(`\nscreenshots → ${SHOT_DIR}/`)
process.exit(bad.length ? 1 : 0)
