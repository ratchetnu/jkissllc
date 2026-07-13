import { NextRequest, NextResponse } from 'next/server'
import { COMPANY } from '../../lib/company'
import { redis } from '../../lib/redis'

// Pageview/visitor tracking. Previously used its own inline Upstash client, which
// bypassed the tenant-isolation chokepoint; it now goes through app/lib/redis.ts
// so the pv:*/uv:* keys are namespaced identically to every other tenant-owned
// key (unchanged while TENANCY_ENABLED=false). No cookies, no PII stored.
export async function POST(req: NextRequest) {
  try {
    const { path, referrer } = await req.json()
    const page = path || '/'
    const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

    // Unique visitor fingerprint (IP + UA hash — no cookies, no PII stored)
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown'
    const ua = req.headers.get('user-agent') ?? ''
    const fingerprint = Buffer.from(`${today}:${ip}:${ua}`).toString('base64').slice(0, 32)

    await Promise.all([
      redis.incr('pv:total'),
      redis.incr(`pv:day:${today}`),
      redis.hincrby('pv:paths', page, 1),
      redis.pfadd(`uv:day:${today}`, fingerprint),
      redis.pfadd('uv:total', fingerprint),
      ...(referrer && !referrer.includes(COMPANY.domain)
        ? [redis.hincrby('pv:referrers', new URL(referrer).hostname, 1)]
        : []),
      // 90-day expiry on the daily keys
      redis.expire(`pv:day:${today}`, 7776000),
      redis.expire(`uv:day:${today}`, 7776000),
    ])

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
