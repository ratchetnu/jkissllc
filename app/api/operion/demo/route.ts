import { NextRequest, NextResponse } from 'next/server'
import { rateLimit } from '../../../lib/rate-limit'
import { escapeHtml, isValidEmail, str, strList } from '../../../lib/validators'
import { isBlockedBot } from '../../../lib/botcheck'
import { addDemoRequest } from '../../../lib/operion-demo'
import { emailRaw } from '../../../lib/booking-emails'
import { COMPANY } from '../../../lib/company'

const OWNER = process.env.OWNER_EMAIL ?? COMPANY.ownerEmail

/**
 * Operion demo / access request.
 *
 * Public form on /operion. Same baseline defenses as /api/opspilot/waitlist and
 * /api/contact: per-IP rate limit, bot check, strict server-side validation. The
 * durable Redis record is the source of truth; the owner email is best-effort
 * (emailRaw swallows its own errors) so a Resend outage never costs us a lead.
 */
export async function POST(request: NextRequest) {
  if (await rateLimit(request, 'operion-demo', 5, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many requests. Please wait a few minutes and try again.' }, { status: 429 })
  }
  if (await isBlockedBot()) {
    return NextResponse.json({ error: 'Submission blocked. Please try again.' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const b = (body ?? {}) as Record<string, unknown>

  // Required: a business name, a contact name, and a valid email. Everything else
  // is qualification — nice to have, never a blocker to reaching out.
  const businessName = str(b.businessName, 200)
  const contactName = str(b.contactName, 200)
  if (!businessName || !contactName) {
    return NextResponse.json({ error: 'Business name and contact name are required.' }, { status: 400 })
  }
  if (!isValidEmail(b.email)) {
    return NextResponse.json({ error: 'Please enter a valid email address.' }, { status: 400 })
  }
  const email = b.email

  const entry = {
    businessName,
    contactName,
    email,
    phone: str(b.phone, 40),
    industry: str(b.industry, 80),
    teamSize: str(b.teamSize, 60),
    currentTools: str(b.currentTools, 400),
    challenge: str(b.challenge, 2000),
    interests: strList(b.interests, 60).slice(0, 20),
    message: str(b.message, 2000),
    source: str(b.source, 80) ?? '/operion',
    createdAt: Date.now(),
  }

  try {
    await addDemoRequest(entry)
  } catch (err) {
    console.error('[operion-demo]', err)
    return NextResponse.json({ error: 'Could not save your request. Please try again.' }, { status: 500 })
  }

  const row = (label: string, value?: string) =>
    `<tr><td style="padding:8px 0;color:#999;width:140px;vertical-align:top">${label}</td><td style="padding:8px 0">${escapeHtml(value) || '—'}</td></tr>`

  await emailRaw({
    to: [OWNER],
    replyTo: entry.email,
    subject: `Operion demo request — ${entry.businessName}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h2 style="margin-bottom:4px">New Operion demo request</h2>
        <p style="color:#666;margin-top:0">Captured on ${escapeHtml(entry.source)}</p>
        <hr style="border:1px solid #eee;margin:20px 0"/>
        <table style="width:100%;border-collapse:collapse">
          ${row('Business', entry.businessName)}
          ${row('Contact', entry.contactName)}
          <tr><td style="padding:8px 0;color:#999">Email</td><td style="padding:8px 0"><a href="mailto:${escapeHtml(entry.email)}">${escapeHtml(entry.email)}</a></td></tr>
          ${row('Phone', entry.phone)}
          ${row('Industry', entry.industry)}
          ${row('Team size', entry.teamSize)}
          ${row('Current tools', entry.currentTools)}
          ${row('Interested in', entry.interests.join(', '))}
        </table>
        <hr style="border:1px solid #eee;margin:20px 0"/>
        <p style="color:#999;margin-bottom:6px">Biggest operational challenge</p>
        <p style="background:#f9f9f9;padding:16px;border-radius:8px;margin:0 0 16px;white-space:pre-wrap">${escapeHtml(entry.challenge) || '—'}</p>
        <p style="color:#999;margin-bottom:6px">Message</p>
        <p style="background:#f9f9f9;padding:16px;border-radius:8px;margin:0;white-space:pre-wrap">${escapeHtml(entry.message) || '—'}</p>
      </div>
    `,
  })

  return NextResponse.json({ ok: true })
}
