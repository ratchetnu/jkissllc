import { NextRequest, NextResponse } from 'next/server'

function checkAuth(req: NextRequest): boolean {
  const pw = req.headers.get('x-admin-password')
  return !!pw && pw === process.env.ADMIN_PASSWORD
}

async function redis(url: string, token: string, ...args: string[]) {
  const res = await fetch(`${url}/${args.map(encodeURIComponent).join('/')}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  })
  return res.json()
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = process.env.KV_REST_API_URL
  const token = process.env.KV_REST_API_TOKEN

  if (!url || !token) {
    return NextResponse.json({ error: 'KV_REST_API_URL and KV_REST_API_TOKEN must be set' }, { status: 500 })
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

  const [
    totalPvResult,
    pathsResult,
    referrersResult,
    totalUvResult,
    ...dailyPvResults
  ] = await Promise.all([
    redis(url, token, 'GET', 'pv:total'),
    redis(url, token, 'HGETALL', 'pv:paths'),
    redis(url, token, 'HGETALL', 'pv:referrers'),
    redis(url, token, 'PFCOUNT', 'uv:total'),
    ...dailyKeys.map(d => redis(url, token, 'GET', `pv:day:${d}`)),
  ])

  // Sum pageviews for range
  const rangePageviews = dailyPvResults.reduce((sum: number, r: { result: string | null }) => {
    return sum + (parseInt(r?.result ?? '0') || 0)
  }, 0)

  // Count unique visitors in range using individual day HyperLogLog counts
  const dailyUvResults = await Promise.all(
    dailyKeys.map(d => redis(url, token, 'PFCOUNT', `uv:day:${d}`))
  )
  const rangeVisitors = dailyUvResults.reduce((sum: number, r: { result: number }) => {
    return sum + (r?.result ?? 0)
  }, 0)

  // Parse HGETALL into sorted array
  function parseHash(result: { result: string[] | null }): { key: string; total: number }[] {
    const arr = result?.result ?? []
    const out: { key: string; total: number }[] = []
    for (let i = 0; i < arr.length; i += 2) {
      out.push({ key: arr[i], total: parseInt(arr[i + 1]) || 0 })
    }
    return out.sort((a, b) => b.total - a.total)
  }

  // Daily chart data
  const daily = dailyKeys.map((date, i) => ({
    date,
    pageviews: parseInt(dailyPvResults[i]?.result ?? '0') || 0,
    visitors: dailyUvResults[i]?.result ?? 0,
  })).reverse()

  return NextResponse.json({
    totalPageviews: totalPvResult?.result ? parseInt(totalPvResult.result) : 0,
    totalVisitors: totalUvResult?.result ?? 0,
    rangePageviews,
    rangeVisitors,
    paths: parseHash(pathsResult).slice(0, 10),
    referrers: parseHash(referrersResult).slice(0, 10),
    daily,
    range,
  })
}
