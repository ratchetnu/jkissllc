import { notFound } from 'next/navigation'
import { isEnabled } from '../../lib/platform/flags'
import MyJobsClient from './MyJobsClient'

// My Jobs — the unified crew feed (contract routes AND customer bookings).
//
// A SERVER component whose only job is the flag gate. With
// BOOKING_ASSIGNMENT_ENABLED off this route is genuinely absent — notFound()
// terminates the segment, so the crew portal in Production is exactly the portal
// it has always been rather than gaining a second tab onto the same work. The
// interactive screen lives in ./MyJobsClient, which cannot read a server-only flag.
//
// The matching guards are on /api/portal/jobs (404) and on the nav item in
// PortalShell, which the portal layout feeds from this same flag.

// Dynamic so the flag is read PER REQUEST. Prerendered, the gate would be frozen
// into the build output — turning the flag on later would keep serving the baked
// 404. Every other flag in this app is resolved at request time; this matches.
export const dynamic = 'force-dynamic'

export default function MyJobsPage() {
  if (!isEnabled('BOOKING_ASSIGNMENT_ENABLED')) notFound()
  return <MyJobsClient />
}
