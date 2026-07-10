'use client'

import { useCallback, useEffect, useState } from 'react'

// Shared routes+stats loader with a short module-level cache, so navigating
// between OS pages reuses the last fetch instead of hitting /api/admin/routes
// again. reload() forces a fresh pull after a mutation.
export type OpsStats = Record<string, {
  score: number | null; assignments?: number; confirmed?: number; completed?: number
  declined?: number; noResponse?: number; noShow?: number
}>
type Data = { items: unknown[]; stats: OpsStats }

let cache: { at: number; data: Data } | null = null
let inflight: Promise<Data> | null = null

// Drop the shared cache after a mutation (route create/edit/status/crew/money)
// so Home and List re-fetch fresh state instead of reading a ≤10s-stale copy.
// Pages that mutate routes outside useOps (the wizard, the route detail) call
// this on success; the next useOps mount/reload then pulls live data.
export function invalidateOps(): void {
  cache = null
  inflight = null
}

async function fetchOps(force = false): Promise<Data> {
  if (!force && cache && Date.now() - cache.at < 10_000) return cache.data
  if (inflight) return inflight
  inflight = fetch('/api/admin/routes', { credentials: 'same-origin' })
    .then(r => r.json())
    .then((d): Data => ({ items: Array.isArray(d.items) ? d.items : [], stats: d.stats || {} }))
    .then(data => { cache = { at: Date.now(), data }; inflight = null; return data })
    .catch(e => { inflight = null; throw e })
  return inflight
}

export function useOps<R = Record<string, unknown>>() {
  const [data, setData] = useState<Data | null>(cache?.data ?? null)
  const [loading, setLoading] = useState(!cache)
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    setLoading(true); setError('')
    try { setData(await fetchOps(true)) } catch { setError('Couldn’t load your operations.') } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    let alive = true
    fetchOps()
      .then(d => { if (alive) { setData(d); setLoading(false) } })
      .catch(() => { if (alive) { setError('Couldn’t load your operations.'); setLoading(false) } })
    return () => { alive = false }
  }, [])

  return { routes: (data?.items ?? []) as R[], stats: (data?.stats ?? {}) as OpsStats, loading, error, reload }
}
