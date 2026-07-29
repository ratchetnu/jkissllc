import { NextRequest, NextResponse } from 'next/server'
import { runWithTenant } from '../../lib/platform/tenancy/context'
import { resolveTenantFromHost } from '../../lib/platform/tenancy/tenant-resolve'
import { COMPANY } from '../../lib/company'
import { redis } from '../../lib/redis'
import { rateLimit } from '../../lib/rate-limit'

// Pageview/visitor tracking. Previously used its own inline Upstash client, which
// bypassed the tenant-isolation chokepoint; it now goes through app/lib/redis.ts
// so the pv:*/uv:* keys are namespaced identically to every other tenant-owned
// key (unchanged while TENANCY_ENABLED=false). No cookies, no PII stored.
// WAVE 6D-A — HOST mapping, not a token.
//
// This is the one public surface with no capability to bind: an anonymous pageview
// beacon with no token, no resource and no [token] segment. `withTenantRoute` was
// wrong here for the same reason it is wrong on the token routes — there is no
// session — but the answer is different. "Which site was this pageview on?" is
// answered by the request HOST, and `resolveTenantFromHost` is the existing trusted
// mechanism for exactly that (a verified domain map; an unknown host resolves to
// null and fails closed rather than guessing).
//
// The host comes from the request, but it is not caller-authority: it is matched
// against a server-side allowlist, so an attacker-supplied Host header can only ever
// resolve to a tenant that already owns that domain, or to nothing.
export const POST = async (req: NextRequest, _ctx?: unknown) => {
  const resolved = resolveTenantFromHost(req.headers.get('host'))
  if (!resolved) {
    // Unknown host under tenancy — attribute nothing rather than attribute wrongly.
    // A dropped analytics beacon is strictly better than one counted for the wrong
    // tenant, and the caller neither needs nor gets a reason.
    return NextResponse.json({ ok: false }, { status: 202 })
  }
  return runWithTenant({ tenantId: resolved.tenantId }, async () => {
  try {
    // Unauthenticated public beacon: rate-limit per IP so a script can't inflate
    // counters or grow the pv:paths / pv:referrers hashes without bound.
    if (await rateLimit(req, 'track', 60, 60_000)) return NextResponse.json({ ok: false }, { status: 429 })
    const { path, referrer } = await req.json()
    // Cap the path so a single hash field can't be arbitrarily large.
    const page = (typeof path === 'string' && path ? path : '/').slice(0, 512)
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
  })
}
