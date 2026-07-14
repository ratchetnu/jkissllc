import { NextRequest, NextResponse } from 'next/server'
import { rateLimit } from '../../../lib/rate-limit'
import { escapeHtml, isValidEmail, str } from '../../../lib/validators'
import { isBlockedBot } from '../../../lib/botcheck'
import { addToWaitlist } from '../../../lib/opspilot-waitlist'
import { emailRaw } from '../../../lib/booking-emails'
import { COMPANY } from '../../../lib/company'

const OWNER = process.env.OWNER_EMAIL ?? COMPANY.ownerEmail

export async function POST(request: NextRequest) {
  // Public form — same baseline defenses as /api/contact.
  if (await rateLimit(request, 'opspilot-waitlist', 5, 10 * 60_000)) {
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

  const { email, company, fleetSize, source } = (body ?? {}) as Record<string, unknown>

  if (!isValidEmail(email)) {
    return NextResponse.json({ error: 'Please enter a valid email address.' }, { status: 400 })
  }

  const entry = {
    email,
    company: str(company, 200),
    fleetSize: str(fleetSize, 60),
    source: str(source, 80) ?? 'unknown',
    createdAt: Date.now(),
  }

  // Redis is the durable record — if it fails, the request failed. The owner
  // notification below is best-effort (emailRaw swallows its own errors), so a
  // Resend outage must never cost us a captured lead.
  try {
    await addToWaitlist(entry)
  } catch (err) {
    console.error('[opspilot-waitlist]', err)
    return NextResponse.json({ error: 'Could not save your request. Please try again.' }, { status: 500 })
  }

  await emailRaw({
    to: [OWNER],
    replyTo: entry.email,
    subject: `OpsPilot early access — ${entry.company ?? entry.email}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h2 style="margin-bottom:4px">New Operion early-access request</h2>
        <p style="color:#666;margin-top:0">Captured on ${escapeHtml(entry.source)}</p>
        <hr style="border:1px solid #eee;margin:20px 0"/>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px 0;color:#999;width:120px">Email</td><td style="padding:8px 0"><a href="mailto:${escapeHtml(entry.email)}">${escapeHtml(entry.email)}</a></td></tr>
          <tr><td style="padding:8px 0;color:#999">Company</td><td style="padding:8px 0">${escapeHtml(entry.company) || '—'}</td></tr>
          <tr><td style="padding:8px 0;color:#999">Fleet size</td><td style="padding:8px 0">${escapeHtml(entry.fleetSize) || '—'}</td></tr>
        </table>
      </div>
    `,
  })

  return NextResponse.json({ ok: true })
}
