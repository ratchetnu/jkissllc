// SMS via Twilio REST API (no SDK — direct fetch). Gated on Twilio env vars so
// the app runs fine without SMS configured; functions no-op and report false.
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and either
//   TWILIO_FROM (a Twilio phone number) or TWILIO_MESSAGING_SERVICE_SID

export function smsConfigured(): boolean {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    (process.env.TWILIO_FROM || process.env.TWILIO_MESSAGING_SERVICE_SID)
  )
}

// Best-effort E.164 for US numbers. Returns null if it can't form a plausible
// number, so we never hand Twilio garbage.
export function toE164(raw: string | undefined | null): string | null {
  if (!raw) return null
  const digits = raw.replace(/[^\d]/g, '')
  if (raw.trim().startsWith('+') && digits.length >= 11) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return null
}

export async function sendSms(to: string | undefined | null, body: string): Promise<boolean> {
  if (!smsConfigured()) return false
  const dest = toE164(to)
  if (!dest) return false

  const sid = process.env.TWILIO_ACCOUNT_SID!
  const token = process.env.TWILIO_AUTH_TOKEN!
  const params = new URLSearchParams()
  params.set('To', dest)
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) {
    params.set('MessagingServiceSid', process.env.TWILIO_MESSAGING_SERVICE_SID)
  } else {
    params.set('From', process.env.TWILIO_FROM!)
  }
  params.set('Body', body)

  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      cache: 'no-store',
    })
    if (!res.ok) {
      console.error('[sms] twilio error', res.status, await res.text().catch(() => ''))
      return false
    }
    return true
  } catch (err) {
    console.error('[sms] send failed', err)
    return false
  }
}
