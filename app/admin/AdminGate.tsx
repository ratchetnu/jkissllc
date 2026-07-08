'use client'

import OperationsShell from './operations/OperationsShell'

// Every admin page now runs inside the J KISS OS shell — one experience: the OS
// sign-in and the floating dock / bottom nav, no legacy top header. This thin
// wrapper keeps existing <AdminGate title=…> call sites working unchanged.
export default function AdminGate({ children }: { title?: string; children: React.ReactNode }) {
  return <OperationsShell>{children}</OperationsShell>
}
