import { NextRequest, NextResponse } from 'next/server'
import { rateLimit } from '../../../lib/rate-limit'
import { isBlockedBot } from '../../../lib/botcheck'
import { runAiTask } from '../../../lib/ai/service'

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

  const result = await runAiTask({
    taskId: 'ops.photoEstimate', feature: 'ops.photoEstimate',
    vars: {},
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Estimate the junk-removal load size and price for the items in this photo.' },
        { type: 'image', image },
      ],
    }],
    maxOutputTokens: 300, temperature: 0.3, requestChars: image.length,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  try {
    const json = JSON.parse(result.text.replace(/```json|```/g, '').trim())
    const low = Math.max(0, Math.round(Number(json.low) || 0))
    const high = Math.max(low, Math.round(Number(json.high) || 0))
    const loadSize = String(json.loadSize || '').slice(0, 60)
    const summary = String(json.summary || '').slice(0, 200)
    // high === 0 with a summary is a valid "we can't haul this" response.
    if (high <= 0 && !summary) throw new Error('bad shape')
    return NextResponse.json({ ok: true, loadSize, low, high, summary })
  } catch {
    return NextResponse.json({ error: 'Could not read that photo clearly — try another angle, or request a custom quote below.' }, { status: 422 })
  }
}
