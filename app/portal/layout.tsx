import type { Metadata } from 'next'
import { COMPANY } from '../lib/company'

export const metadata: Metadata = {
  title: `Crew Portal | ${COMPANY.legalName}`,
  robots: { index: false, follow: false, noarchive: true, nosnippet: true, noimageindex: true },
}

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
