import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright-core'
import PayStatementDoc from '../app/components/PayStatementDoc'
import type { PayStatement, StatementDeduction, StatementLine } from '../app/lib/pay-statements'

const chromeCandidates = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
].filter((candidate): candidate is string => !!candidate)
const chromePath = chromeCandidates.find(existsSync)

const issuedAt = Date.UTC(2026, 7, 19, 22, 19)
const ytd = { grossCents: 2_835_000, deductionCents: 0, netCents: 2_835_000 }

function statement(lines: StatementLine[], deductions: StatementDeduction[] = []): PayStatement {
  const grossCents = lines.reduce((sum, line) => sum + line.amountCents, 0)
  const deductionCents = deductions.reduce((sum, deduction) => sum + Math.abs(deduction.amountCents), 0)
  return {
    id: 'ps_print_layout_check', statementNumber: 'JK-PS-1004', staffId: 'kimberly-kissie', staffName: 'Kimberly Kissie',
    periodStart: '2026-01-01', periodEnd: '2026-08-14', paymentDate: '2026-08-14',
    grossCents, deductionCents, netCents: grossCents - deductionCents, routeCount: lines.length,
    lines, deductions, status: 'issued', issuedBy: 'owner', issuedAt, updatedAt: issuedAt,
  }
}

const historical = statement([{
  source: 'historical', routeNumber: '', routeDate: '2026-08-14', businessName: 'Historical compensation',
  description: 'Weekday compensation (Monday–Friday)', earningKind: 'daily', quantity: 162,
  rateCents: 17_500, amountCents: 2_835_000,
}])
historical.statementSource = 'historical_manual'
historical.periodUnit = 'custom'
historical.historicalNote = 'Admin-only reconstruction note that must never print.'

const routes: StatementLine[] = [
  { source: 'route', routeNumber: 'R-1001', routeDate: '2026-08-10', businessName: 'J Kiss LLC', amountCents: 17_500, workedMinutes: 480 },
  { source: 'route', routeNumber: 'R-1002', routeDate: '2026-08-12', businessName: 'J Kiss LLC', amountCents: 17_500, workedMinutes: 480 },
  { source: 'route', routeNumber: 'R-1003', routeDate: '2026-08-14', businessName: 'J Kiss LLC', amountCents: 17_500, workedMinutes: 480 },
]

const busyRoutes: StatementLine[] = Array.from({ length: 14 }, (_, index) => ({
  source: 'route',
  routeNumber: `R-${1100 + index}`,
  routeDate: `2026-08-${String(index + 1).padStart(2, '0')}`,
  businessName: index < 7 ? 'J Kiss LLC' : 'North Texas Moving Partner',
  amountCents: 17_500,
  workedMinutes: 480,
}))

const cases = [
  { name: 'Kimberly historical verification statement', statement: historical, ytd },
  { name: 'three-route verification statement with YTD', statement: statement(routes), ytd: { grossCents: 52_500, deductionCents: 0, netCents: 52_500 } },
  {
    name: 'three-route verification statement with deductions and YTD',
    statement: statement(routes, [
      { label: 'Advance repayment', amountCents: 2_500 },
      { label: 'Equipment charge', amountCents: 1_500 },
    ]),
    ytd: { grossCents: 52_500, deductionCents: 4_000, netCents: 48_500 },
  },
  {
    name: 'busy fourteen-route two-business statement with a deduction',
    statement: statement(busyRoutes, [{ label: 'Advance repayment', amountCents: 2_500 }]),
    ytd: { grossCents: 245_000, deductionCents: 2_500, netCents: 242_500 },
  },
]

function shellHtml(s: PayStatement, statementYtd: typeof ytd): string {
  const document = renderToStaticMarkup(createElement(PayStatementDoc, {
    s,
    variant: 'verification',
    verifyUrl: 'https://www.jkissllc.com/verify/ps_print_layout_check',
    showInternalNote: true,
    businessAddress: '8055 Windrose Ave #4119, Plano, TX 75024',
    meta: {
      contractorAddress: '2901 E Mayfield Rd, #2103, Grand Prairie, TX 75052',
      businessName: 'J Kiss LLC',
      ytd: statementYtd,
    },
  }))
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    html, body { margin: 0; }
    .jkos { min-height: 100vh; background: #f5f5f7; }
    .jkos > main { max-width: 980px; margin: 0 auto; padding: 28px; }
    .jkos > main > div { display: grid; gap: 16px; }
    [data-topbar] { height: 72px; }
  </style></head><body><div class="jkos">
    <header data-topbar><nav>Operion navigation</nav></header>
    <main><div><div class="no-print">Print controls</div>${document}</div></main>
    <div data-dock>Mobile dock</div>
  </div></body></html>`
}

test('verification statements print as one undistorted Letter page', async () => {
  assert.ok(chromePath, 'Chrome is required: the one-page PDF guarantee must not be silently skipped')
  const browser = await chromium.launch({ executablePath: chromePath, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 816, height: 1056 } })
    for (const scenario of cases) {
      await page.setContent(shellHtml(scenario.statement, scenario.ytd), { waitUntil: 'load' })
      await page.emulateMedia({ media: 'print' })
      const layout = await page.evaluate(() => {
        const doc = document.querySelector('.pay-doc') as HTMLElement
        const topbar = document.querySelector('[data-topbar]') as HTMLElement
        const note = document.querySelector('[aria-label="Internal pay record note"]') as HTMLElement | null
        const style = getComputedStyle(doc)
        return {
          width: doc.getBoundingClientRect().width,
          viewportWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          zoom: style.zoom,
          transform: style.transform,
          topbar: getComputedStyle(topbar).display,
          note: note ? getComputedStyle(note).display : 'absent',
        }
      })
      assert.equal(layout.width, layout.viewportWidth, `${scenario.name}: document must paint full width`)
      assert.equal(layout.scrollWidth, layout.viewportWidth, `${scenario.name}: no horizontal overflow`)
      assert.ok(layout.zoom === '1' || layout.zoom === 'normal', `${scenario.name}: no print zoom distortion`)
      assert.equal(layout.transform, 'none', `${scenario.name}: no transform scaling`)
      assert.equal(layout.topbar, 'none', `${scenario.name}: Operion shell must not print`)
      assert.ok(layout.note === 'none' || layout.note === 'absent', `${scenario.name}: internal note must not print`)

      const pdf = await page.pdf({ format: 'Letter', preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false })
      const info = spawnSync('pdfinfo', ['-'], { input: pdf, encoding: 'utf8' })
      // A missing binary comes back as status null with an ENOENT error, not a
      // non-zero exit. Say so, rather than letting the page-count assertion fail
      // as `null !== 0` and read like a layout regression.
      assert.ok(!info.error, `pdfinfo is required to count PDF pages (poppler-utils): ${info.error?.message}`)
      assert.equal(info.status, 0, info.stderr)
      const pages = Number(info.stdout.match(/^Pages:\s+(\d+)$/m)?.[1])
      assert.equal(pages, 1, `${scenario.name}: expected one Letter page`)
    }
  } finally {
    await browser.close()
  }
})
