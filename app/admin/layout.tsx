import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Admin | J Kiss LLC',
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
