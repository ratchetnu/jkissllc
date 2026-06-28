import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { rateLimit } from '../../lib/rate-limit'
import { escapeHtml, isValidEmail } from '../../lib/validators'

export async function POST(request: NextRequest) {
  // Public form that sends two emails (one to a requester-supplied address) —
  // rate-limit per IP so it can't be used as an email-spam relay.
  if (await rateLimit(request, 'coi', 5, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many requests. Please wait a few minutes and try again.' }, { status: 429 })
  }

  const body = await request.json()
  const {
    requesterName, requesterEmail, requesterPhone,
    holderName, holderAddress,
    additionalInsured, project, deliveryEmail,
    notes,
  } = body

  if (!requesterName || !isValidEmail(requesterEmail) || !holderName) {
    return NextResponse.json({ error: 'Requester name, valid email, and certificate holder name are required.' }, { status: 400 })
  }

  if (typeof requesterName !== 'string' || requesterName.length > 200) {
    return NextResponse.json({ error: 'Submission too large.' }, { status: 400 })
  }

  const safe = {
    requesterName:   escapeHtml(requesterName),
    requesterEmail:  escapeHtml(requesterEmail),
    requesterPhone:  escapeHtml(requesterPhone)  || '—',
    holderName:      escapeHtml(holderName),
    holderAddress:   escapeHtml(holderAddress)   || '—',
    additionalInsured: additionalInsured === 'yes' ? 'YES — list as Additional Insured' : 'No — Certificate Holder only',
    project:         escapeHtml(project)         || '—',
    deliveryEmail:   escapeHtml(deliveryEmail)   || escapeHtml(requesterEmail),
    notes:           escapeHtml(notes)           || '—',
  }

  const resend = new Resend(process.env.RESEND_API_KEY)
  const brokerEmail = process.env.COI_BROKER_EMAIL || 'info@jkissllc.com'

  // Dedupe: if broker = info@, don't double-send.
  const opsRecipients = Array.from(new Set([brokerEmail, 'info@jkissllc.com', 'timmothy@jkissllc.com']))

  try {
    // Email to broker + JKISS ops
    await resend.emails.send({
      from: 'J Kiss LLC <info@jkissllc.com>',
      to: opsRecipients,
      replyTo: requesterEmail as string,
      subject: `COI Request — ${safe.holderName}`,
      html: `
        <div style="font-family:sans-serif;max-width:640px;margin:0 auto">
          <h2 style="color:#E0002A;margin-bottom:4px">Certificate of Insurance Request</h2>
          <p style="color:#666;margin-top:0">Submitted via jkissllc.com — please issue ACORD 25 to the requester below</p>
          <hr style="border:1px solid #eee;margin:20px 0"/>

          <h3 style="margin-bottom:8px">Certificate Holder Details</h3>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:6px 0;color:#999;width:160px">Holder Name</td><td style="padding:6px 0;font-weight:600">${safe.holderName}</td></tr>
            <tr><td style="padding:6px 0;color:#999">Holder Address</td><td style="padding:6px 0;white-space:pre-wrap">${safe.holderAddress}</td></tr>
            <tr><td style="padding:6px 0;color:#999">Additional Insured?</td><td style="padding:6px 0;font-weight:600">${safe.additionalInsured}</td></tr>
            <tr><td style="padding:6px 0;color:#999">Project / PO #</td><td style="padding:6px 0">${safe.project}</td></tr>
            <tr><td style="padding:6px 0;color:#999">Send COI To</td><td style="padding:6px 0;font-weight:600"><a href="mailto:${safe.deliveryEmail}">${safe.deliveryEmail}</a></td></tr>
          </table>

          <h3 style="margin-top:24px;margin-bottom:8px">Requester</h3>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:6px 0;color:#999;width:160px">Name</td><td style="padding:6px 0">${safe.requesterName}</td></tr>
            <tr><td style="padding:6px 0;color:#999">Email</td><td style="padding:6px 0"><a href="mailto:${safe.requesterEmail}">${safe.requesterEmail}</a></td></tr>
            <tr><td style="padding:6px 0;color:#999">Phone</td><td style="padding:6px 0">${safe.requesterPhone}</td></tr>
          </table>

          <hr style="border:1px solid #eee;margin:20px 0"/>
          <p style="color:#999;margin-bottom:6px">Notes</p>
          <p style="background:#f9f9f9;padding:14px;border-radius:8px;margin:0;white-space:pre-wrap">${safe.notes}</p>
        </div>
      `,
    })

    // Confirmation to requester
    await resend.emails.send({
      from: 'J Kiss LLC <info@jkissllc.com>',
      to: [requesterEmail as string],
      replyTo: 'info@jkissllc.com',
      subject: 'J Kiss LLC — COI request received',
      html: `
        <div style="font-family:sans-serif;max-width:540px;margin:0 auto">
          <h2 style="color:#E0002A;margin-bottom:4px">COI Request Received</h2>
          <p>Thank you, ${safe.requesterName}.</p>
          <p>We've forwarded your Certificate of Insurance request to our insurance broker. You should receive the ACORD 25 directly from them at <strong>${safe.deliveryEmail}</strong> within 1 business day.</p>
          <p style="color:#666;font-size:13px;margin-top:24px">Certificate holder: <strong>${safe.holderName}</strong><br/>${safe.additionalInsured}</p>
          <p style="color:#666;font-size:13px">Questions? Reply to this email or contact info@jkissllc.com</p>
          <p style="color:#999;font-size:11px;margin-top:24px">J Kiss LLC · US DOT 3484556 · MC 01155352</p>
        </div>
      `,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[coi]', err)
    return NextResponse.json({ error: 'Failed to submit. Please email info@jkissllc.com directly.' }, { status: 500 })
  }
}
