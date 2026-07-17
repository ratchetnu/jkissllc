import { redirect } from 'next/navigation'

// The per-alert detail belonged to the persisted background-alerting notification center, which
// is dormant (SHADOW_ALERTING_ENABLED off) and superseded by the live Alerts & Readiness view.
// Redirect deep links to the canonical section rather than keep a second, conflicting surface.
export default async function LegacyAlertDetailRedirect() {
  redirect('/admin/operations/ai/alerts')
}
