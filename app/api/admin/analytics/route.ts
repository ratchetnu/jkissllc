import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireSession } from '../_lib/session'
import { redis } from '../../../lib/redis'

// Site analytics read. Previously used its own inline Upstash client (bypassing
// the tenant-isolation chokepoint); it now reads through app/lib/redis.ts so the
// pv:*/uv:* keys resolve through the same boundary as every tenant-owned key.

function parseHash(arr: string[]): { key: string; total: number }[] {
  const out: { key: string; total: number }[] = []
  for (let i = 0; i < arr.length; i += 2) {
    out.push({ key: arr[i], total: parseInt(arr[i + 1]) || 0 })
  }
  return out.sort((a, b) => b.total - a.total)
}

export const GET = withTenantRoute(async (req: NextRequest) => {
  if (!(await requireSession(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = req.nextUrl
  const range = searchParams.get('range') ?? '30d'
  const days = range === '7d' ? 7 : range === '90d' ? 90 : 30

  // Build list of daily keys
  const dailyKeys: string[] = []
  for (let i = 0; i < days; i++) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    dailyKeys.push(d.toISOString().slice(0, 10))
  }

  try {
    const [totalPv, pathsArr, referrersArr, totalUv, ...dailyPv] = await Promise.all([
      redis.get('pv:total'),
      redis.hgetall('pv:paths'),
      redis.hgetall('pv:referrers'),
      redis.pfcount('uv:total'),
      ...dailyKeys.map((d) => redis.get(`pv:day:${d}`)),
    ])

    const dailyUv = await Promise.all(dailyKeys.map((d) => redis.pfcount(`uv:day:${d}`)))

    const rangePageviews = (dailyPv as (string | null)[]).reduce((sum, r) => sum + (parseInt(r ?? '0') || 0), 0)
    const rangeVisitors = dailyUv.reduce((sum, n) => sum + (n ?? 0), 0)

    const daily = dailyKeys.map((date, i) => ({
      date,
      pageviews: parseInt((dailyPv as (string | null)[])[i] ?? '0') || 0,
      visitors: dailyUv[i] ?? 0,
    })).reverse()

    return NextResponse.json({
      totalPageviews: totalPv ? parseInt(totalPv) : 0,
      totalVisitors: totalUv ?? 0,
      rangePageviews,
      rangeVisitors,
      paths: parseHash(pathsArr).slice(0, 10),
      referrers: parseHash(referrersArr).slice(0, 10),
      daily,
      range,
    })
  } catch {
    return NextResponse.json({ error: 'analytics unavailable' }, { status: 500 })
  }
})
