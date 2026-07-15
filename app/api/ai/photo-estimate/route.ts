import { NextRequest, NextResponse } from 'next/server'
import { rateLimit } from '../../../lib/rate-limit'
import { isBlockedBot } from '../../../lib/botcheck'
import { runAiTask } from '../../../lib/ai/service'
import { ESTIMATE_SCHEMA } from '../../../lib/ai/schema'
import { toModelReadableDataUrl } from '../../../lib/image-convert'

export const maxDuration = 30

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
  // iPhone HEIC/HEIF → JPEG data URL so the vision model can read it (else it sees nothing).
  let readable: string
  try {
    readable = await toModelReadableDataUrl(image)
  } catch {
    return NextResponse.json({ error: "We couldn't read that photo. Please re-take it or upload a JPG or PNG." }, { status: 400 })
  }

  // Validation happens INSIDE runAiTask now (ESTIMATE_SCHEMA) — a malformed model
  // response is recorded as invalid_response, not silently logged as success (AUDIT-F1).
  const result = await runAiTask<{ loadSize: string; low: number; high: number; summary: string }>({
    taskId: 'ops.photoEstimate', feature: 'ops.photoEstimate',
    vars: {}, schema: ESTIMATE_SCHEMA,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Estimate the junk-removal load size and price for the items in this photo.' },
        { type: 'image', image: readable },
      ],
    }],
    maxOutputTokens: 300, temperature: 0.3, requestChars: readable.length,
  })
  if (!result.ok) {
    // A schema failure (invalid_response, 502) reads to the customer as "couldn't read it".
    const status = result.outcome === 'invalid_response' ? 422 : result.status
    const error = result.outcome === 'invalid_response'
      ? 'Could not read that photo clearly — try another angle, or request a custom quote below.'
      : result.error
    return NextResponse.json({ error }, { status })
  }

  const d = result.data
  const low = Math.max(0, Math.round(Number(d.low) || 0))
  const high = Math.max(low, Math.round(Number(d.high) || 0))
  const loadSize = String(d.loadSize || '').slice(0, 60)
  const summary = String(d.summary || '').slice(0, 200)
  if (high <= 0 && !summary) {
    return NextResponse.json({ error: 'Could not read that photo clearly — try another angle, or request a custom quote below.' }, { status: 422 })
  }
  return NextResponse.json({ ok: true, loadSize, low, high, summary, callId: result.callId })
}
