import type { Metadata } from 'next'
import { COMPANY } from '../lib/company';

export const metadata: Metadata = {
  title: `OpsPilot | ${COMPANY.legalName}`,
  robots: {
    index: false,
    follow: false,
    noarchive: true,
    nosnippet: true,
    noimageindex: true,
  },
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
