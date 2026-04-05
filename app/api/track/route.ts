import { NextRequest, NextResponse } from 'next/server'

async function redis(url: string, token: string, ...args: string[]) {
  const res = await fetch(`${url}/${args.map(encodeURIComponent).join('/')}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  return res.json()
}

export async function POST(req: NextRequest) {
  const url = process.env.KV_REST_API_URL
  const token = process.env.KV_REST_API_TOKEN
  if (!url || !token) return NextResponse.json({ ok: false }, { status: 500 })

  try {
    const { path, referrer } = await req.json()
    const page = path || '/'
    const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

    // Unique visitor fingerprint (IP + UA hash — no cookies, no PII stored)
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown'
    const ua = req.headers.get('user-agent') ?? ''
    const fingerprint = Buffer.from(`${today}:${ip}:${ua}`).toString('base64').slice(0, 32)

    await Promise.all([
      // Total pageviews
      redis(url, token, 'INCR', 'pv:total'),
      // Daily pageviews
      redis(url, token, 'INCR', `pv:day:${today}`),
      // Per-path counts
      redis(url, token, 'HINCRBY', 'pv:paths', page, '1'),
      // Unique visitors via HyperLogLog
      redis(url, token, 'PFADD', `uv:day:${today}`, fingerprint),
      redis(url, token, 'PFADD', 'uv:total', fingerprint),
      // Referrer counts (skip self and empty)
      ...(referrer && !referrer.includes('jkissllc.com')
        ? [redis(url, token, 'HINCRBY', 'pv:referrers', new URL(referrer).hostname, '1')]
        : []),
      // Set 90-day expiry on daily keys
      redis(url, token, 'EXPIRE', `pv:day:${today}`, '7776000'),
      redis(url, token, 'EXPIRE', `uv:day:${today}`, '7776000'),
    ])

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
