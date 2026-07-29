'use client'

import { use, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, Plus, Search, Building2, ShieldAlert, Ban, RotateCcw } from 'lucide-react'
import OperationsShell from '../../OperationsShell'
import RouteRow from '../../RouteRow'
import { useOps } from '../../useOps'
import { ymd, money, type RouteStatus } from '../../ui'
import { opsBizKey, groupOpsByBusiness, type OpsRoute } from '../../../../lib/ops-groups'
import { addDaysStr } from '../../../../lib/dates'

type Op = OpsRoute & { status: RouteStatus }
type Claim = { id: string; claimNumber: string; businessKey: string; status: string; claimType: string; totalCents: number; createdAt: number }
type BusinessRec = { key: string; name: string; contractEndedAt?: number; contractEndReason?: string }

const TABS = ['today', 'tomorrow', 'upcoming', 'confirmed', 'pending', 'active', 'completed', 'cancelled', 'claims'] as const
type Tab = typeof TABS[number]
const TAB_LABEL: Record<Tab, string> = {
  today: 'Today', tomorrow: 'Tomorrow', upcoming: 'Upcoming', confirmed: 'Confirmed', pending: 'Pending',
  active: 'Active', completed: 'Completed', cancelled: 'Cancelled', claims: 'Claims',
}

function BusinessOpsPage({ bizKey }: { bizKey: string }) {
  const { routes: ops, loading, reload } = useOps<Op>()
  const [tab, setTab] = useState<Tab>('upcoming')
  const [q, setQ] = useState('')
  const [claims, setClaims] = useState<Claim[]>([])
  const [business, setBusiness] = useState<BusinessRec | null>(null)
  const [contractBusy, setContractBusy] = useState(false)
  const [contractMsg, setContractMsg] = useState('')

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
  const loadBusiness = useCallback(async () => {
    try {
      const d = await fetch('/api/admin/businesses', { credentials: 'same-origin' }).then(r => r.json())
      setBusiness((d.items || []).find((b: BusinessRec) => b.key === bizKey) ?? null)
    } catch { /* route history remains usable if metadata is unavailable */ }
  }, [bizKey])
  useEffect(() => { void loadBusiness() }, [loadBusiness])

  async function changeContract(action: 'end_contract' | 'reopen_contract') {
    if (action === 'end_contract') {
      const upcoming = summary?.counts.upcoming ?? 0
      const warning = `End the contract with ${name}? This will cancel ${upcoming} current or future operation${upcoming === 1 ? '' : 's'} and pause every recurring schedule. Completed work, invoices, pay, and claims will stay in history.`
      if (!confirm(warning)) return
    } else if (!confirm(`Restore ${name} to active clients? Cancelled operations and paused recurring schedules will stay stopped.`)) return

    setContractBusy(true)
    setContractMsg('')
    try {
      const reason = action === 'end_contract' ? 'Contract expired' : undefined
      const res = await fetch('/api/admin/businesses', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action, businessKey: bizKey, businessName: name, reason }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setContractMsg(data.error || 'Could not update the contract. Please try again.')
        return
      }
      if (action === 'end_contract') {
        setContractMsg(`Contract ended. ${data.cancelledRouteCount ?? 0} operation${data.cancelledRouteCount === 1 ? '' : 's'} cancelled and ${data.pausedTemplateCount ?? 0} recurring schedule${data.pausedTemplateCount === 1 ? '' : 's'} paused.`)
      } else {
        setContractMsg('Client restored. Create new assignments or resume schedules when you are ready.')
      }
      await Promise.all([reload(), loadBusiness()])
      setTab(action === 'end_contract' ? 'cancelled' : 'upcoming')
    } catch {
      setContractMsg('Network error. Nothing else was changed by this screen.')
    } finally {
      setContractBusy(false)
    }
  }

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

      <div className="os-rise" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ width: 46, height: 46, borderRadius: 12, background: 'rgba(224,0,42,.12)', display: 'grid', placeItems: 'center', flexShrink: 0, color: 'var(--red-glow)' }}><Building2 size={22} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="jkos-h" style={{ fontSize: 'clamp(22px,5vw,30px)' }}>{name}</h1>
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{summary ? `${summary.counts.upcoming} upcoming · ${summary.counts.completed} completed` : 'No routes yet'}{summary && summary.upcomingValueCents > 0 ? ` · ${money(summary.upcomingValueCents)} upcoming` : ''}</div>
        </div>
        {business?.contractEndedAt ? (
          <button onClick={() => changeContract('reopen_contract')} disabled={contractBusy} className="btn-ghost os-tap" style={{ borderRadius: 999, height: 42, flexShrink: 0 }}>
            <RotateCcw size={15} /> Restore client
          </button>
        ) : (
          <>
            <button onClick={() => changeContract('end_contract')} disabled={contractBusy || loading} className="btn-ghost os-tap" style={{ borderRadius: 999, height: 42, flexShrink: 0, color: '#fca5a5' }}>
              <Ban size={15} /> End contract
            </button>
            <Link href="/admin/operations/new" className="btn os-tap" style={{ borderRadius: 999, height: 42, flexShrink: 0 }}><Plus size={16} /> New</Link>
          </>
        )}
      </div>

      {business?.contractEndedAt && (
        <div role="status" className="os-card" style={{ padding: '11px 14px', marginBottom: 12, borderColor: 'rgba(248,113,113,.35)', color: '#fca5a5', fontSize: 13.5 }}>
          Contract ended {new Date(business.contractEndedAt).toLocaleDateString()}. Future work is stopped; completed history is retained.
          {business.contractEndReason ? ` Reason: ${business.contractEndReason}.` : ''}
        </div>
      )}
      {contractMsg && <div role="status" className="os-card" style={{ padding: '11px 14px', marginBottom: 12, color: contractMsg.startsWith('Contract ended') || contractMsg.startsWith('Client restored') ? '#86efac' : '#fca5a5', fontSize: 13.5 }}>{contractMsg}</div>}

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
