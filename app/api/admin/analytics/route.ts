import { NextRequest, NextResponse } from 'next/server'

function checkAuth(req: NextRequest): boolean {
  const pw = req.headers.get('x-admin-password')
  return !!pw && pw === process.env.ADMIN_PASSWORD
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const token = process.env.VERCEL_TOKEN
  const projectId = process.env.VERCEL_PROJECT_ID

  if (!token || !projectId) {
    return NextResponse.json({ error: 'VERCEL_TOKEN and VERCEL_PROJECT_ID must be set' }, { status: 500 })
  }

  const { searchParams } = req.nextUrl
  const range = searchParams.get('range') ?? '30d'

  const now = Date.now()
  const rangeMs: Record<string, number> = {
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
    '90d': 90 * 24 * 60 * 60 * 1000,
  }
  const from = now - (rangeMs[range] ?? rangeMs['30d'])
  const to = now

  const base = 'https://vercel.com/api/web/insights/stats'
  const params = new URLSearchParams({
    projectId,
    from: String(from),
    to: String(to),
    environment: 'production',
    filter: '{}',
  })

  const headers = { Authorization: `Bearer ${token}` }

  async function fetchStat(endpoint: string) {
    try {
      const res = await fetch(`${base}/${endpoint}?${params}`, { headers })
      if (!res.ok) return null
      return res.json()
    } catch {
      return null
    }
  }

  const [pageviews, visitors, referrers, paths] = await Promise.all([
    fetchStat('pageviews'),
    fetchStat('visitors'),
    fetchStat('referrers'),
    fetchStat('paths'),
  ])

  return NextResponse.json({ pageviews, visitors, referrers, paths, range })
}
