import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../../_lib/session'
import { aiText } from '../../../../lib/ai'

export const maxDuration = 30

// POST /api/admin/ai/review-reply — drafts a public reply to a customer review.
export async function POST(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const rating = Math.max(1, Math.min(5, parseInt(String(body.rating)) || 5))
  const author = typeof body.author === 'string' ? body.author.slice(0, 80) : 'the customer'
  const text = typeof body.text === 'string' ? body.text.slice(0, 1000) : ''

  const r = await aiText({
    system: 'You write warm, professional, concise public replies to customer reviews on behalf of J Kiss LLC (a DFW box-truck delivery, junk-removal, and property-cleanout company). Sound like a grateful small-business owner, never robotic. 2–4 sentences. For low ratings, be gracious, take responsibility, and invite them to reach out at (817) 909-4312 to make it right. Do not invent specifics. Output only the reply text.',
    prompt: `Review from ${author} — ${rating} out of 5 stars.\nReview text: ${text || '(no written comment)'}\n\nWrite the reply.`,
    maxOutputTokens: 300,
    temperature: 0.6,
  })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 503 })
  return NextResponse.json({ ok: true, reply: r.text })
}
