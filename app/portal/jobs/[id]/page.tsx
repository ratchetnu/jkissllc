import { notFound } from 'next/navigation'
import { isEnabled } from '../../../lib/platform/flags'
import JobDetailClient from './JobDetailClient'

// One booking job, from the assigned crew member's phone.
//
// A SERVER component whose only job is the flag gate — with
// BOOKING_ASSIGNMENT_ENABLED off the route is genuinely absent rather than a
// screen that renders and then discovers its API 404s. The interactive screen
// lives in ./JobDetailClient, which cannot read a server-only flag.
//
// The per-record authorization still happens server-side on every request in
// /api/portal/jobs/[id]: this gate is about the surface existing at all, never
// about who may see a given job.

// Dynamic so the flag is read PER REQUEST rather than frozen into the build.
export const dynamic = 'force-dynamic'

export default function JobDetailPage() {
  if (!isEnabled('BOOKING_ASSIGNMENT_ENABLED')) notFound()
  return <JobDetailClient />
}
