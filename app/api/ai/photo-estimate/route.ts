import { NextRequest, NextResponse } from 'next/server'
import { rateLimit } from '../../../lib/rate-limit'
import { isBlockedBot } from '../../../lib/botcheck'
import { aiText } from '../../../lib/ai'

export const maxDuration = 30

// Rough price guide so the model returns sane junk-removal numbers (USD per load).
const GUIDE = `Pricing guide (USD): a few items $75–150; quarter truck $150–275; half truck $275–425; three-quarter truck $425–575; full truck $575–775; more than one truck $800+. Heavy/hazardous items, stairs, or long carries push toward the high end.`

// POST /api/ai/photo-estimate — customer uploads a photo of their junk/load and
// gets an AI-suggested load size + ballpark price range. Public, so it's rate-limited
// and bot-protected, and fails soft.
export async function POST(req: NextRequest) {
  if (await rateLimit(req, 'photoestimate', 6, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many estimates. Please wait a few minutes.' }, { status: 429 })
  }
  if (await isBlockedBot()) return NextResponse.json({ error: 'Request blocked. Please try again.' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const image = typeof body.image === 'string' ? body.image : ''
  if (!/^data:image\/(jpeg|png|webp|heic|heif);base64,/.test(image) || image.length > 8_000_000) {
    return NextResponse.json({ error: 'Please attach a clear photo (JPG/PNG, under ~6MB).' }, { status: 400 })
  }

  const r = await aiText({
    system: `You are an estimator for J Kiss LLC, a DFW junk-removal company. From a photo, estimate how much truck space the items take and a ballpark price. ${GUIDE} Be encouraging but honest, and note that the final quote is confirmed on site. Respond with ONLY minified JSON: {"loadSize": string, "low": number, "high": number, "summary": string}. loadSize is one of: "A few items","About a quarter truck","About a half truck","About three-quarter truck","Full truck load","More than one truck". low/high are whole-dollar numbers. summary is one friendly sentence (max 20 words).`,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Estimate the junk-removal load size and price for the items in this photo.' },
        { type: 'image', image },
      ],
    }],
    maxOutputTokens: 300,
    temperature: 0.3,
  })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 503 })

  try {
    const json = JSON.parse(r.text.replace(/```json|```/g, '').trim())
    const low = Math.max(0, Math.round(Number(json.low) || 0))
    const high = Math.max(low, Math.round(Number(json.high) || 0))
    const loadSize = String(json.loadSize || '').slice(0, 60)
    const summary = String(json.summary || '').slice(0, 200)
    if (!loadSize || high <= 0) throw new Error('bad shape')
    return NextResponse.json({ ok: true, loadSize, low, high, summary })
  } catch {
    return NextResponse.json({ error: 'Could not read that photo clearly — try another angle, or request a custom quote below.' }, { status: 422 })
  }
}
