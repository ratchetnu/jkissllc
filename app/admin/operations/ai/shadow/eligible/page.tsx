import { redirect } from 'next/navigation'

// Legacy route — the eligible-jobs picking list is now the AI Command Center's Evaluation
// Queue at /admin/operations/ai/queue, which unifies eligible + run + review + categorize.
export default async function LegacyEligibleRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const scope = typeof sp.scope === 'string' ? sp.scope : ''
  // Old "selected" scope maps loosely to the ready-to-run tier; otherwise land on the full queue.
  redirect(`/admin/operations/ai/queue${scope === 'selected' ? '?tier=ready_to_run' : ''}`)
}
