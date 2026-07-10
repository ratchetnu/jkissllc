'use client'

import { use, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, Plus, Search, Building2, ShieldAlert } from 'lucide-react'
import OperationsShell from '../../OperationsShell'
import RouteRow from '../../RouteRow'
import { useOps } from '../../useOps'
import { ymd, money, type RouteStatus } from '../../ui'
import { opsBizKey, groupOpsByBusiness, type OpsRoute } from '../../../../lib/ops-groups'
import { addDaysStr } from '../../../../lib/dates'

type Op = OpsRoute & { status: RouteStatus }
type Claim = { id: string; claimNumber: string; businessKey: string; status: string; claimType: string; totalCents: number; createdAt: number }

const TABS = ['today', 'tomorrow', 'upcoming', 'confirmed', 'pending', 'active', 'completed', 'cancelled', 'claims'] as const
type Tab = typeof TABS[number]
const TAB_LABEL: Record<Tab, string> = {
  today: 'Today', tomorrow: 'Tomorrow', upcoming: 'Upcoming', confirmed: 'Confirmed', pending: 'Pending',
  active: 'Active', completed: 'Completed', cancelled: 'Cancelled', claims: 'Claims',
}

function BusinessOpsPage({ bizKey }: { bizKey: string }) {
  const { routes: ops, loading } = useOps<Op>()
  const [tab, setTab] = useState<Tab>('upcoming')
  const [q, setQ] = useState('')
  const [claims, setClaims] = useState<Claim[]>([])

  const today = ymd(new Date())
  const tomorrow = addDaysStr(today, 1)

  const mine = useMemo(() => ops.filter(o => opsBizKey(o.businessName) === bizKey), [ops, bizKey])
  const name = mine[0]?.businessName || bizKey
  const summary = useMemo(() => groupOpsByBusiness(mine, today)[0], [mine, today])

  useEffect(() => {
    fetch('/api/admin/claims', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(d => setClaims((d.items || []).filter((c: Claim) => c.businessKey === bizKey)))
      .catch(() => {})
  }, [bizKey])

  const shown = useMemo(() => {
    const match = (o: Op): boolean => {
      switch (tab) {
        case 'today': return o.routeDate === today && o.status !== 'cancelled'
        case 'tomorrow': return o.routeDate === tomorrow && o.status !== 'cancelled'
        case 'upcoming': return o.routeDate >= today && !['cancelled', 'completed'].includes(o.status)
        case 'confirmed': return o.status === 'confirmed'
        case 'pending': return o.status === 'assigned' || o.status === 'text_sent'
        case 'active': return o.routeDate === today && o.status === 'confirmed'
        case 'completed': return o.status === 'completed'
        case 'cancelled': return o.status === 'cancelled'
        default: return false
      }
    }
    const query = q.trim().toLowerCase()
    const asc = ['today', 'tomorrow', 'upcoming', 'confirmed', 'pending', 'active'].includes(tab)
    return mine.filter(match).filter(o => !query || o.routeNumber.toLowerCase().includes(query) || (o.assignedStaffName || '').toLowerCase().includes(query))
      .sort((a, b) => asc ? a.routeDate.localeCompare(b.routeDate) : b.routeDate.localeCompare(a.routeDate) || a.reportTime.localeCompare(b.reportTime))
  }, [mine, tab, q, today, tomorrow])

  const claimCount = claims.filter(c => !['closed', 'waived'].includes(c.status)).length

  return (
    <div>
      <Link href="/admin/operations/list" className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', color: 'var(--muted)', fontSize: 13.5, fontWeight: 600, textDecoration: 'none', marginBottom: 14 }}><ChevronLeft size={16} /> Operations</Link>

      <div className="os-rise" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <div style={{ width: 46, height: 46, borderRadius: 12, background: 'rgba(224,0,42,.12)', display: 'grid', placeItems: 'center', flexShrink: 0, color: 'var(--red-glow)' }}><Building2 size={22} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="jkos-h" style={{ fontSize: 'clamp(22px,5vw,30px)' }}>{name}</h1>
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{summary ? `${summary.counts.upcoming} upcoming · ${summary.counts.completed} completed` : 'No routes yet'}{summary && summary.upcomingValueCents > 0 ? ` · ${money(summary.upcomingValueCents)} upcoming` : ''}</div>
        </div>
        <Link href="/admin/operations/new" className="btn os-tap" style={{ borderRadius: 999, height: 42, flexShrink: 0 }}><Plus size={16} /> New</Link>
      </div>

      <div style={{ position: 'relative', marginBottom: 12 }}>
        <Search size={17} style={{ position: 'absolute', left: 14, top: 13, color: 'var(--muted)' }} />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search this client's routes"
          style={{ width: '100%', padding: '12px 14px 12px 40px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 13, color: 'var(--text)', fontSize: 15, outline: 'none' }} />
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, overflowX: 'auto', paddingBottom: 2 }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} className="os-tap"
            style={{ padding: '8px 14px', borderRadius: 999, fontSize: 13, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', border: `1px solid ${tab === t ? 'var(--red)' : 'var(--line)'}`, background: tab === t ? 'var(--red)' : 'transparent', color: tab === t ? '#fff' : 'var(--muted)' }}>
            {TAB_LABEL[t]}{t === 'claims' && claimCount > 0 && <span style={{ marginLeft: 6, fontSize: 11, opacity: .9 }}>{claimCount}</span>}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{[0, 1, 2].map(i => <div key={i} className="os-card" style={{ padding: 15 }}><div className="skeleton" style={{ width: '45%', height: 15, borderRadius: 7 }} /></div>)}</div>
      ) : tab === 'claims' ? (
        claims.length === 0 ? <Empty title="No claims for this client" /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {claims.sort((a, b) => b.createdAt - a.createdAt).map(c => (
              <Link key={c.id} href={`/admin/operations/claims/${c.id}`} className="os-card os-tap" style={{ padding: 15, display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none', color: 'var(--text)' }}>
                <ShieldAlert size={18} style={{ color: 'var(--red-glow)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14.5 }}>{c.claimType.replace(/_/g, ' ')}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{c.claimNumber} · {c.status.replace(/_/g, ' ')}</div>
                </div>
                <span className="tabular-nums" style={{ fontWeight: 700 }}>{money(c.totalCents)}</span>
              </Link>
            ))}
          </div>
        )
      ) : shown.length === 0 ? (
        <Empty title={`No ${TAB_LABEL[tab].toLowerCase()} routes`} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {shown.map((o, i) => <RouteRow key={o.token} o={o} i={i} />)}
        </div>
      )}
    </div>
  )
}

function Empty({ title }: { title: string }) {
  return <div className="os-card os-rise" style={{ padding: 30, textAlign: 'center' }}><p style={{ color: 'var(--muted)', fontSize: 14 }}>{title}</p></div>
}

export default function Page({ params }: { params: Promise<{ key: string }> }) {
  const { key } = use(params)
  return <OperationsShell><BusinessOpsPage bizKey={decodeURIComponent(key)} /></OperationsShell>
}
