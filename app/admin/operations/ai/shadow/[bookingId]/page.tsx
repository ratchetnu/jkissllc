import { redirect } from 'next/navigation'

// Legacy path — the evaluation drill-down now lives under the AI Command Center at
// /admin/operations/ai/eval/[bookingId]. Redirect so old bookmarks and deep links resolve.
export default async function LegacyShadowEvalRedirect({ params }: { params: Promise<{ bookingId: string }> }) {
  const { bookingId } = await params
  redirect(`/admin/operations/ai/eval/${bookingId}`)
}
