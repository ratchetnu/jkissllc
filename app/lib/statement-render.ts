import { COMPANY, CREDENTIALS_SLASH } from './company'
import type { PayStatement } from './pay-statements'

// Branded HTML render of a pay statement for email delivery. The on-screen /
// print-to-PDF view is a React component (see the statement pages); this is the
// email-safe inline-styled version. Pure — no React, no Redis.

const money = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const day = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

export function renderStatementEmail(s: PayStatement): string {
  const lines = s.lines.map(l => `
    <tr>
      <td style="padding:8px 0;border-top:1px solid #eee;font-size:13px;color:#333">${day(l.routeDate)}</td>
      <td style="padding:8px 0;border-top:1px solid #eee;font-size:13px;color:#333">${escapeHtml(l.businessName)} · ${escapeHtml(l.routeNumber)}</td>
      <td style="padding:8px 0;border-top:1px solid #eee;font-size:13px;color:#333;text-align:right">${money(l.amountCents)}</td>
    </tr>`).join('')

  const deductions = s.deductions.length ? s.deductions.map(d => `
    <tr>
      <td colspan="2" style="padding:6px 0;font-size:13px;color:#a00">${escapeHtml(d.label)}</td>
      <td style="padding:6px 0;font-size:13px;color:#a00;text-align:right">-${money(Math.abs(d.amountCents))}</td>
    </tr>`).join('') : ''

  return `
  <div style="max-width:600px;margin:0 auto;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111">
    <h1 style="font-size:20px;margin:0 0 2px">${escapeHtml(COMPANY.legalName)}</h1>
    <p style="margin:0 0 16px;font-size:12px;color:#666">${CREDENTIALS_SLASH} · ${escapeHtml(COMPANY.phoneDisplay)}</p>
    <div style="background:#f7f7f8;border-radius:10px;padding:16px 18px;margin-bottom:16px">
      <p style="margin:0;font-size:15px;font-weight:600">Pay Statement ${escapeHtml(s.statementNumber)}</p>
      <p style="margin:4px 0 0;font-size:13px;color:#555">${escapeHtml(s.staffName)} · ${day(s.periodStart)} – ${day(s.periodEnd)}</p>
    </div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:8px">
      <tbody>${lines}</tbody>
    </table>
    <table style="width:100%;border-collapse:collapse;border-top:2px solid #111;margin-top:6px">
      <tbody>
        <tr><td colspan="2" style="padding:8px 0;font-size:13px;color:#333">Gross (${s.routeCount} route${s.routeCount === 1 ? '' : 's'})</td><td style="padding:8px 0;font-size:13px;color:#333;text-align:right">${money(s.grossCents)}</td></tr>
        ${deductions}
        <tr><td colspan="2" style="padding:10px 0;font-size:15px;font-weight:700;border-top:1px solid #eee">Net pay</td><td style="padding:10px 0;font-size:15px;font-weight:700;border-top:1px solid #eee;text-align:right">${money(s.netCents)}</td></tr>
      </tbody>
    </table>
    <p style="margin:18px 0 0;font-size:11px;color:#999">Independent contractor pay statement. Questions? Reply to this email or use the Pay Correction request in your crew portal.</p>
  </div>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
