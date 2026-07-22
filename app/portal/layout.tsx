import type { Metadata } from 'next'
import { COMPANY } from '../lib/company'
import { isEnabled } from '../lib/platform/flags'
import PortalShell from './PortalShell'

export const metadata: Metadata = {
  title: `Crew Portal | ${COMPANY.legalName}`,
  robots: { index: false, follow: false, noarchive: true, nosnippet: true, noimageindex: true },
}

// The crew portal chrome (auth gate, header, nav docks) lives in the LAYOUT, not in
// each page, so it stays mounted across client navigations. Rendering it per-page
// made every nav tap unmount + remount the shell — re-running the session check and
// flashing the skeleton loader before the page appeared (the "load glitch"). As a
// layout it persists; only the page content below swaps, so transitions are smooth.
//
// The layout is a SERVER component, which makes it the right place to read
// BOOKING_ASSIGNMENT_ENABLED and hand the answer to the client shell: a nav item
// must never point at a route that 404s, and PortalShell cannot read the flag
// itself. With the flag off the nav is exactly what it was before Sprint 1.
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <PortalShell showJobs={isEnabled('BOOKING_ASSIGNMENT_ENABLED')}>{children}</PortalShell>
}
