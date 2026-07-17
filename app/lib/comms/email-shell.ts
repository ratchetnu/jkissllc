// Minimal branded email shell for comms templates. Mirrors the visual language of
// booking-emails.ts (dark header, red accent wordmark, boxed body, credential
// footer) using COMPANY as the single source of brand truth — kept local so
// templates.ts stays free of booking-schema imports.

import { COMPANY, CREDENTIALS_SLASH } from '../company'

const RED = COMPANY.brand.red

export function esc(v: unknown): string {
  if (v === null || v === undefined) return ''
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// A single call-to-action button (safe no-op when href is empty).
export function button(label: string, href?: string): string {
  if (!href) return ''
  return `<p style="margin:20px 0"><a href="${esc(href)}" style="background:${RED};color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700;display:inline-block">${esc(label)}</a></p>`
}

export function emailShell(heading: string, innerHtml: string): string {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;color:#111">
    <div style="background:#0b0b0c;padding:22px 24px;border-radius:14px 14px 0 0">
      <p style="margin:0;font-size:20px;font-weight:800;color:#fff">${COMPANY.nameLead} <span style="color:${RED}">${COMPANY.nameAccent}</span></p>
    </div>
    <div style="border:1px solid #eee;border-top:none;border-radius:0 0 14px 14px;padding:24px">
      <h2 style="color:${RED};margin:0 0 14px;font-size:20px">${esc(heading)}</h2>
      ${innerHtml}
      <hr style="border:none;border-top:1px solid #eee;margin:22px 0"/>
      <p style="color:#999;font-size:12px;margin:0">${COMPANY.legalName} · ${COMPANY.phoneDisplay} · ${COMPANY.email} · ${CREDENTIALS_SLASH}</p>
    </div>
  </div>`
}

// A "you can opt out" footer line for reminder-class emails (compliance parity
// with the SMS "Reply STOP" line).
export function unsubLine(): string {
  return `<p style="color:#aaa;font-size:11px;margin:14px 0 0">You're receiving this because you have an active job with ${esc(COMPANY.legalName)}. Reply STOP to any text to opt out of reminders.</p>`
}
