'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Plus, Search, ChevronRight, Building2, Users, AlertTriangle } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { useOps } from '../useOps'
import { ymd, fmtDay, money, type RouteStatus } from '../ui'
import { groupOpsByBusiness, type OpsRoute } from '../../../lib/ops-groups'
import RouteRow from '../RouteRow'

type Op = OpsRoute & { status: RouteStatus; reportAddress?: string }

// Two drivers count as a driver + helper: a spare driver fills the helper seat.
const crewGap = (o: Op) => {
  if (!o.requiresHelper || ['cancelled', 'completed'].includes(o.status)) return false
  const roles = (o.assignees ?? []).map(a => (a.role || '').toLowerCase())
  const drivers = roles.filter(x => x.includes('driver')).length
  const hasHelper = roles.some(x => x.includes('helper'))
  return drivers === 0 || (!hasHelper && drivers < 2)
}

type Filter = 'attention' | 'upcoming' | 'completed' | 'all'
const FILTERS: { key: Filter; label: string }[] = [{ key: 'attention', label: 'Attention' }, { key: 'upcoming', label: 'Upcoming' }, { key: 'completed', label: 'Completed' }, { key: 'all', label: 'All' }]

// Home's triage cards deep-link here with ?filter= so tapping a count lands on a tab
// that actually contains those routes. When a filter is present we default to the
// flat "All routes" view so those deep-links keep working; otherwise we open the
// business-grouped view. Client-only read — no Suspense needed.
function initialFilter(): Filter {
  if (typeof window === 'undefined') return 'attention'
  const f = new URLSearchParams(window.location.search).get('filter')
  return FILTERS.some(x => x.key === f) ? (f as Filter) : 'attention'
}
function initialView(): 'business' | 'routes' {
  if (typeof window === 'undefined') return 'business'
  return new URLSearchParams(window.location.search).get('filter') ? 'routes' : 'business'
}

function List() {
  const { routes: ops, loading } = useOps<Op>()
  const [view, setView] = useState<'business' | 'routes'>(initialView)
  const [filter, setFilter] = useState<Filter>(initialFilter)
  const [q, setQ] = useState('')
  const today = ymd(new Date())
  const query = q.trim().toLowerCase()

  const counts = useMemo(() => ({
    attention: ops.filter(o => crewGap(o) ? o.routeDate >= today : (o.status === 'declined' || o.status === 'no_response' || (o.status === 'draft' && o.routeDate >= today) || ((o.status === 'assigned' || o.status === 'text_sent') && o.routeDate < today))).length,
  }), [ops, today])

  const groups = useMemo(() => {
    const all = groupOpsByBusiness(ops, today)
    return query ? all.filter(g => g.businessName.toLowerCase().includes(query)) : all
  }, [ops, today, query])

  const shown = useMemo(() => {
    let list = ops
    if (filter === 'attention') list = ops.filter(o => o.status === 'declined' || o.status === 'no_response' || (o.status === 'draft' && o.routeDate >= today) || ((o.status === 'assigned' || o.status === 'text_sent') && o.routeDate < today) || (crewGap(o) && o.routeDate >= today))
    else if (filter === 'upcoming') list = ops.filter(o => o.routeDate >= today && !['cancelled', 'completed'].includes(o.status))
    else if (filter === 'completed') list = ops.filter(o => o.status === 'completed')
    if (query) list = list.filter(o => o.businessName.toLowerCase().includes(query) || o.routeNumber.toLowerCase().includes(query) || (o.assignedStaffName || '').toLowerCase().includes(query))
    const asc = filter === 'upcoming'
    return [...list].sort((a, b) => asc ? a.routeDate.localeCompare(b.routeDate) : b.routeDate.localeCompare(a.routeDate) || a.reportTime.localeCompare(b.reportTime))
  }, [ops, filter, query, today])

  return (
    <div>
      <div className="os-rise" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <h1 className="jkos-h" style={{ fontSize: 'clamp(28px,6vw,40px)' }}>Operations</h1>
        <Link href="/admin/operations/new" className="btn os-tap" style={{ borderRadius: 999, height: 44 }}><Plus size={17} /> New assignment</Link>
      </div>

      {/* View toggle: business-grouped (default) vs the flat route list. */}
      <div style={{ display: 'inline-flex', gap: 2, padding: 4, borderRadius: 999, border: '1px solid var(--line)', marginBottom: 14 }}>
        {([['business', 'By business'], ['routes', 'All routes']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setView(k)} className="os-tap"
            style={{ padding: '7px 15px', borderRadius: 999, fontSize: 13, fontWeight: 700, cursor: 'pointer', border: 'none', background: view === k ? 'var(--red)' : 'transparent', color: view === k ? '#fff' : 'var(--muted)' }}>{label}</button>
        ))}
      </div>

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: 14 }}>
        <Search size={17} style={{ position: 'absolute', left: 14, top: 13, color: 'var(--muted)' }} />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={view === 'business' ? 'Search businesses' : 'Search by business, route #, or crew'}
          style={{ width: '100%', padding: '12px 14px 12px 40px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 13, color: 'var(--text)', fontSize: 15, outline: 'none' }} />
      </div>

      {/* Filters — only in the flat routes view */}
      {view === 'routes' && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 18, overflowX: 'auto' }}>
          {FILTERS.map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)} className="os-tap"
              style={{ padding: '8px 15px', borderRadius: 999, fontSize: 13.5, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', border: `1px solid ${filter === f.key ? 'var(--red)' : 'var(--line)'}`, background: filter === f.key ? 'var(--red)' : 'transparent', color: filter === f.key ? '#fff' : 'var(--muted)' }}>
              {f.label}{f.key === 'attention' && counts.attention > 0 && <span style={{ marginLeft: 6, fontSize: 11, opacity: .9 }}>{counts.attention}</span>}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{[0, 1, 2, 3].map(i => <div key={i} className="os-card" style={{ padding: 15 }}><div className="skeleton" style={{ width: '45%', height: 15, borderRadius: 7 }} /><div className="skeleton" style={{ width: '30%', height: 11, borderRadius: 6, marginTop: 8 }} /></div>)}</div>
      ) : view === 'business' ? (
        groups.length === 0 ? <Empty title="No businesses yet" sub="Create an assignment to get started." /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* Recurring/active clients first, one-time customers grouped after. */}
            {groups.filter(g => !g.isOneTime).map((g, i) => <BizCard key={g.bizKey} g={g} i={i} />)}
            {groups.some(g => g.isOneTime) && (
              <>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)', margin: '10px 2px 2px' }}>One-time & ad-hoc</div>
                {groups.filter(g => g.isOneTime).map((g, i) => <BizCard key={g.bizKey} g={g} i={i} />)}
              </>
            )}
          </div>
        )
      ) : shown.length === 0 ? (
        <Empty title={filter === 'attention' ? 'Nothing needs attention' : 'Nothing here'} sub={filter === 'attention' ? 'All operations are on track.' : 'Try another filter.'} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {shown.map((o, i) => <RouteRow key={o.token} o={o} i={i} />)}
        </div>
      )}
    </div>
  )
}

function BizCard({ g, i }: { g: ReturnType<typeof groupOpsByBusiness>[number]; i: number }) {
  const chips: [string, number][] = [['Upcoming', g.counts.upcoming], ['Pending', g.counts.pending], ['Confirmed', g.counts.confirmed], ['Active', g.counts.active], ['Completed', g.counts.completed]]
  return (
    <Link href={`/admin/operations/business/${encodeURIComponent(g.bizKey)}`} className="os-card os-tap os-rise" style={{ padding: 16, display: 'block', textDecoration: 'none', color: 'var(--text)', animationDelay: `${Math.min(i * 30, 240)}ms` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 40, height: 40, borderRadius: 11, background: 'rgba(224,0,42,.12)', display: 'grid', placeItems: 'center', flexShrink: 0, color: 'var(--red-glow)' }}><Building2 size={20} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.businessName}</div>
          {g.nextRoute && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>Next: {fmtDay(g.nextRoute.routeDate)} · {g.nextRoute.reportTime}</div>}
        </div>
        {g.counts.attention > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 800, padding: '3px 9px', borderRadius: 99, background: 'rgba(251,191,36,.15)', color: '#fbbf24', flexShrink: 0 }}><AlertTriangle size={12} /> {g.counts.attention}</span>}
        <ChevronRight size={18} style={{ color: 'var(--muted)', flexShrink: 0 }} />
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
        {chips.filter(([, n]) => n > 0).map(([label, n]) => (
          <span key={label} style={{ fontSize: 11.5, fontWeight: 700, padding: '3px 9px', borderRadius: 99, background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', color: 'var(--muted)' }}>{label} {n}</span>
        ))}
        {g.counts.upcoming === 0 && g.counts.completed === 0 && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>No live routes</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 10, fontSize: 12.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
        {g.upcomingValueCents > 0 && <span className="tabular-nums" style={{ fontWeight: 700, color: 'var(--text)' }}>{money(g.upcomingValueCents)} upcoming</span>}
        {g.crew.length > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Users size={13} /> {g.crew.slice(0, 3).join(', ')}{g.crew.length > 3 ? ` +${g.crew.length - 3}` : ''}</span>}
      </div>
    </Link>
  )
}

function Empty({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="os-card os-rise" style={{ padding: 34, textAlign: 'center' }}>
      <p className="jkos-h" style={{ fontSize: 18 }}>{title}</p>
      <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 6 }}>{sub}</p>
    </div>
  )
}

export default function OperationsListPage() {
  return <OperationsShell><List /></OperationsShell>
}
