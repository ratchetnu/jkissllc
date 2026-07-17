import type { Metadata } from 'next'
import { COMPANY } from '../lib/company'
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
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <PortalShell>{children}</PortalShell>
}
