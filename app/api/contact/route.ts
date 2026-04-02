import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'

export async function POST(request: NextRequest) {
  const { name, company, email, phone, service, message } = await request.json()

  if (!name || !email) {
    return NextResponse.json({ error: 'Name and email are required.' }, { status: 400 })
  }

  const resend = new Resend(process.env.RESEND_API_KEY)

  try {
    await resend.emails.send({
      from: 'J Kiss LLC Website <onboarding@resend.dev>',
      to: ['info@jkissllc.com', 'timmothy@jkissllc.com'],
      replyTo: email,
      subject: `New Quote Request — ${service || 'General Inquiry'}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
          <h2 style="color:#E0002A;margin-bottom:4px">New Quote Request</h2>
          <p style="color:#666;margin-top:0">Submitted via jkissllc.com</p>
          <hr style="border:1px solid #eee;margin:20px 0"/>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:8px 0;color:#999;width:120px">Name</td><td style="padding:8px 0;font-weight:600">${name}</td></tr>
            <tr><td style="padding:8px 0;color:#999">Company</td><td style="padding:8px 0">${company || '—'}</td></tr>
            <tr><td style="padding:8px 0;color:#999">Email</td><td style="padding:8px 0"><a href="mailto:${email}">${email}</a></td></tr>
            <tr><td style="padding:8px 0;color:#999">Phone</td><td style="padding:8px 0">${phone || '—'}</td></tr>
            <tr><td style="padding:8px 0;color:#999">Service</td><td style="padding:8px 0">${service || '—'}</td></tr>
          </table>
          <hr style="border:1px solid #eee;margin:20px 0"/>
          <p style="color:#999;margin-bottom:6px">Message</p>
          <p style="background:#f9f9f9;padding:16px;border-radius:8px;margin:0">${message || '—'}</p>
        </div>
      `,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[contact]', err)
    return NextResponse.json({ error: 'Failed to send.' }, { status: 500 })
  }
}
