'use client'

import Link from 'next/link'
import { Clock, CalendarDays, ChevronRight } from 'lucide-react'
import { STATUS as CHIP, fmtDay, type RouteStatus } from './ui'
import type { OpsRoute } from '../../lib/ops-groups'

// One route row — shared by the Operations list and the per-business operations page
// so both render a route identically.
export default function RouteRow({ o, i = 0 }: { o: OpsRoute & { status: RouteStatus }; i?: number }) {
  const chip = CHIP[o.status]
  return (
    <Link href={`/admin/operations/${o.token}`} className="os-card os-tap os-rise" style={{ padding: 15, display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none', color: 'var(--text)', animationDelay: `${Math.min(i * 30, 240)}ms` }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, fontSize: 15.5 }}>{o.businessName}</span>
          <span style={{ fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 99, background: chip.bg, color: chip.fg }}>{chip.label}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4, fontSize: 12.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><CalendarDays size={13} /> {fmtDay(o.routeDate)}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Clock size={13} /> {o.reportTime}</span>
          <span>{o.assignedStaffName || 'Unassigned'}</span>
        </div>
      </div>
      <ChevronRight size={18} style={{ color: 'var(--muted)', flexShrink: 0 }} />
    </Link>
  )
}
