import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'

function escapeHtml(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function isValidEmail(email: unknown): email is string {
  if (typeof email !== 'string') return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length < 255
}

export async function POST(request: NextRequest) {
  const { name, company, email, phone, service, message } = await request.json()

  if (!name || !email || typeof name !== 'string' || !isValidEmail(email)) {
    return NextResponse.json({ error: 'Name and a valid email are required.' }, { status: 400 })
  }

  if (name.length > 200 || (typeof message === 'string' && message.length > 5000)) {
    return NextResponse.json({ error: 'Submission too large.' }, { status: 400 })
  }

  const safe = {
    name: escapeHtml(name),
    company: escapeHtml(company) || '—',
    email: escapeHtml(email),
    phone: escapeHtml(phone) || '—',
    service: escapeHtml(service) || '—',
    message: escapeHtml(message) || '—',
  }

  const resend = new Resend(process.env.RESEND_API_KEY)

  try {
    await resend.emails.send({
      from: 'J Kiss LLC <info@jkissllc.com>',
      to: ['info@jkissllc.com', 'timmothy@jkissllc.com'],
      replyTo: email as string,
      subject: `New Quote Request — ${safe.service === '—' ? 'General Inquiry' : safe.service}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
          <h2 style="color:#E0002A;margin-bottom:4px">New Quote Request</h2>
          <p style="color:#666;margin-top:0">Submitted via jkissllc.com</p>
          <hr style="border:1px solid #eee;margin:20px 0"/>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:8px 0;color:#999;width:120px">Name</td><td style="padding:8px 0;font-weight:600">${safe.name}</td></tr>
            <tr><td style="padding:8px 0;color:#999">Company</td><td style="padding:8px 0">${safe.company}</td></tr>
            <tr><td style="padding:8px 0;color:#999">Email</td><td style="padding:8px 0"><a href="mailto:${safe.email}">${safe.email}</a></td></tr>
            <tr><td style="padding:8px 0;color:#999">Phone</td><td style="padding:8px 0">${safe.phone}</td></tr>
            <tr><td style="padding:8px 0;color:#999">Service</td><td style="padding:8px 0">${safe.service}</td></tr>
          </table>
          <hr style="border:1px solid #eee;margin:20px 0"/>
          <p style="color:#999;margin-bottom:6px">Message</p>
          <p style="background:#f9f9f9;padding:16px;border-radius:8px;margin:0;white-space:pre-wrap">${safe.message}</p>
        </div>
      `,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[contact]', err)
    return NextResponse.json({ error: 'Failed to send.' }, { status: 500 })
  }
}
