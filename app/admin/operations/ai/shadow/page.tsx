import { redirect } from 'next/navigation'

// Legacy route — the Shadow Analytics dashboard is now the AI Command Center's Performance
// section at /admin/operations/ai/performance. Redirect (preserving any query) so old bookmarks
// and deep links resolve; the canonical accuracy view lives under one destination.
export default async function LegacyShadowDashboardRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string') qs.set(k, v)
  redirect(`/admin/operations/ai/performance${qs.toString() ? `?${qs}` : ''}`)
}
