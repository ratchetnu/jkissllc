'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Plus, Search, Clock, CalendarDays, ChevronRight } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { useOps } from '../useOps'
import { STATUS as CHIP, ymd, fmtDay, type RouteStatus } from '../ui'

type Op = { token: string; routeNumber: string; status: RouteStatus; businessName: string; reportAddress: string; reportTime: string; routeDate: string; assignedStaffName?: string; requiresHelper?: boolean; assignees?: { role?: string }[] }
const crewGap = (o: Op) => !!o.requiresHelper && !['cancelled', 'completed'].includes(o.status) && (!(o.assignees ?? []).some(a => /driver/i.test(a.role || '')) || !(o.assignees ?? []).some(a => /helper/i.test(a.role || '')))

type Filter = 'attention' | 'upcoming' | 'completed' | 'all'
const FILTERS: { key: Filter; label: string }[] = [{ key: 'attention', label: 'Attention' }, { key: 'upcoming', label: 'Upcoming' }, { key: 'completed', label: 'Completed' }, { key: 'all', label: 'All' }]

function List() {
  const { routes: ops, loading } = useOps<Op>()
  const [filter, setFilter] = useState<Filter>('attention')
  const [q, setQ] = useState('')

  const today = ymd(new Date())
  const counts = useMemo(() => {
    const attention = ops.filter(o => o.status === 'declined' || o.status === 'no_response' || (o.status === 'draft' && o.routeDate >= today) || ((o.status === 'assigned' || o.status === 'text_sent') && o.routeDate < today) || (crewGap(o) && o.routeDate >= today)).length
    return { attention }
  }, [ops, today])

  const shown = useMemo(() => {
    let list = ops
    if (filter === 'attention') list = ops.filter(o => o.status === 'declined' || o.status === 'no_response' || (o.status === 'draft' && o.routeDate >= today) || ((o.status === 'assigned' || o.status === 'text_sent') && o.routeDate < today) || (crewGap(o) && o.routeDate >= today))
    else if (filter === 'upcoming') list = ops.filter(o => o.routeDate >= today && !['cancelled', 'completed'].includes(o.status))
    else if (filter === 'completed') list = ops.filter(o => o.status === 'completed')
    const query = q.trim().toLowerCase()
    if (query) list = list.filter(o => o.businessName.toLowerCase().includes(query) || o.routeNumber.toLowerCase().includes(query) || (o.assignedStaffName || '').toLowerCase().includes(query))
    const asc = filter === 'upcoming'
    return [...list].sort((a, b) => asc ? a.routeDate.localeCompare(b.routeDate) : b.routeDate.localeCompare(a.routeDate) || a.reportTime.localeCompare(b.reportTime))
  }, [ops, filter, q, today])

  return (
    <div>
      <div className="os-rise" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <h1 className="jkos-h" style={{ fontSize: 'clamp(28px,6vw,40px)' }}>Operations</h1>
        <Link href="/admin/operations/new" className="btn os-tap" style={{ borderRadius: 999, height: 44 }}><Plus size={17} /> New assignment</Link>
      </div>

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: 14 }}>
        <Search size={17} style={{ position: 'absolute', left: 14, top: 13, color: 'var(--muted)' }} />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search by business, route #, or crew"
          style={{ width: '100%', padding: '12px 14px 12px 40px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 13, color: 'var(--text)', fontSize: 15, outline: 'none' }} />
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 18, overflowX: 'auto' }}>
        {FILTERS.map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)} className="os-tap"
            style={{ padding: '8px 15px', borderRadius: 999, fontSize: 13.5, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', border: `1px solid ${filter === f.key ? 'var(--red)' : 'var(--line)'}`, background: filter === f.key ? 'var(--red)' : 'transparent', color: filter === f.key ? '#fff' : 'var(--muted)' }}>
            {f.label}{f.key === 'attention' && counts.attention > 0 && <span style={{ marginLeft: 6, fontSize: 11, opacity: .9 }}>{counts.attention}</span>}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{[0, 1, 2, 3].map(i => <div key={i} className="os-card" style={{ padding: 15 }}><div className="skeleton" style={{ width: '45%', height: 15, borderRadius: 7 }} /><div className="skeleton" style={{ width: '30%', height: 11, borderRadius: 6, marginTop: 8 }} /></div>)}</div>
      ) : shown.length === 0 ? (
        <div className="os-card os-rise" style={{ padding: 34, textAlign: 'center' }}>
          <p className="jkos-h" style={{ fontSize: 18 }}>{filter === 'attention' ? 'Nothing needs attention' : 'Nothing here'}</p>
          <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 6 }}>{filter === 'attention' ? 'All operations are on track.' : 'Try another filter.'}</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {shown.map((o, i) => {
            const chip = CHIP[o.status]
            return (
              <Link key={o.token} href={`/admin/operations/${o.token}`} className="os-card os-tap os-rise" style={{ padding: 15, display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none', color: 'var(--text)', animationDelay: `${Math.min(i * 30, 240)}ms` }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, fontSize: 15.5 }}>{o.businessName}</span>
                    <span style={{ fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 99, background: chip.bg, color: chip.fg }}>{chip.label}</span>
                    {crewGap(o) && <span style={{ fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 99, background: 'rgba(196,181,253,.14)', color: '#c4b5fd' }}>needs driver + helper</span>}
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
          })}
        </div>
      )}
    </div>
  )
}

export default function OperationsListPage() {
  return <OperationsShell><List /></OperationsShell>
}
