'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ShieldAlert, Plus, Search, TrendingDown } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { ClaimChip, CLAIM_TYPE_LABEL, Stat, money, fmtDay, osField, osLabel } from '../ui'
import { useClaims, claimOutstanding, type ClaimListItem } from './useClaims'
import NewClaim from './NewClaim'

const FILTERS = [
  { key: 'open', label: 'Open' },
  { key: 'deduction_active', label: 'Recovering' },
  { key: 'disputed', label: 'Disputed' },
  { key: 'paid', label: 'Paid' },
  { key: 'all', label: 'All' },
] as const

const CLOSED = ['paid', 'closed', 'waived']
const isOpen = (c: ClaimListItem) => !CLOSED.includes(c.status)

function Claims() {
  const { claims, report, loading, error, reload } = useClaims()
  const [filter, setFilter] = useState<string>('open')
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return claims
      .filter(c => filter === 'all' ? true : filter === 'open' ? isOpen(c) : c.status === filter)
      .filter(c => !needle || [c.claimNumber, c.businessName, c.description, c.routeNumber ?? '']
        .some(v => v.toLowerCase().includes(needle)))
      .sort((a, b) => b.claimDate.localeCompare(a.claimDate) || b.createdAt - a.createdAt)
  }, [claims, filter, q])

  return (
    <div style={{ maxWidth: 980, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <div>
          <h1 className="jkos-h" style={{ fontSize: 28, display: 'flex', alignItems: 'center', gap: 10 }}>
            <ShieldAlert size={24} style={{ color: 'var(--red)' }} /> Claims
          </h1>
          <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 4 }}>Damage claims, crew responsibility, and cost recovery.</p>
        </div>
        <button onClick={() => setCreating(true)} className="btn os-tap" style={{ borderRadius: 12, height: 42 }}>
          <Plus size={16} /> New claim
        </button>
      </div>

      {report && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 18 }}>
          <Stat label="Open claims" value={String(report.openCount)} sub={`${report.claimCount} all time`} tone={report.openCount ? '#fcd34d' : undefined} />
          <Stat label="This month" value={money(report.thisMonthCents)} sub={`${report.thisMonthCount} claim${report.thisMonthCount === 1 ? '' : 's'}`} />
          <Stat label="Outstanding" value={money(report.outstandingCents)} sub="still owed by crew" tone={report.outstandingCents ? '#fca5a5' : undefined} />
          <Stat label="Recovered" value={money(report.recoveredCents)} sub="collected from crew" tone={report.recoveredCents ? '#86efac' : undefined} />
          <Stat label="Average claim" value={money(report.averageCents)} sub={report.largest ? `largest ${money(report.largestCents)}` : undefined} />
          <Stat label="J KISS absorbed" value={money(report.absorbedCents)} sub="unassigned + waived" />
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {FILTERS.map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)} className="os-tap"
            style={{ padding: '7px 14px', borderRadius: 999, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: `1px solid ${filter === f.key ? 'var(--red)' : 'var(--line)'}`, background: filter === f.key ? 'var(--red)' : 'transparent', color: filter === f.key ? '#fff' : 'var(--muted)' }}>
            {f.label}
          </button>
        ))}
        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search claims…" aria-label="Search claims" style={{ ...osField, paddingLeft: 34, height: 38, fontSize: 14 }} />
        </div>
      </div>

      {loading ? <p style={{ color: 'var(--muted)' }}>Loading…</p>
        : error ? <p style={{ color: '#f87171' }}>{error}</p>
          : rows.length === 0 ? (
            <div className="os-card" style={{ padding: 36, textAlign: 'center' }}>
              <ShieldAlert size={30} style={{ color: 'var(--muted)', margin: '0 auto 10px' }} />
              <p style={{ color: 'var(--muted)', fontSize: 14.5 }}>{claims.length ? 'No claims match that.' : 'No claims yet. That’s the goal.'}</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {rows.map(c => <Row key={c.id} c={c} />)}
            </div>
          )}

      {report && report.byCrew.length > 0 && (
        <div className="os-card os-rise" style={{ padding: 20, marginTop: 20 }}>
          <div style={{ ...osLabel, display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}>
            <TrendingDown size={14} /> Crew balances
          </div>
          {report.byCrew.filter(g => g.outstandingCents > 0 || g.recoveredCents > 0).map(g => (
            <div key={g.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--line)' }}>
              <span style={{ flex: 1, fontWeight: 700, fontSize: 14 }}>{g.label}</span>
              <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{g.claimCount} claim{g.claimCount === 1 ? '' : 's'}</span>
              <span className="tabular-nums" style={{ fontSize: 13, color: '#86efac', minWidth: 80, textAlign: 'right' }}>{money(g.recoveredCents)} paid</span>
              <span className="tabular-nums" style={{ fontSize: 13.5, fontWeight: 800, color: g.outstandingCents ? '#fca5a5' : 'var(--muted)', minWidth: 90, textAlign: 'right' }}>{money(g.outstandingCents)} owed</span>
            </div>
          ))}
        </div>
      )}

      {creating && <NewClaim onClose={() => setCreating(false)} onCreated={reload} />}
    </div>
  )
}

function Row({ c }: { c: ClaimListItem }) {
  const owed = claimOutstanding(c)
  const crew = c.assignments.map(a => a.name).join(', ')
  return (
    <Link href={`/admin/operations/claims/${c.id}`} className="os-card os-rise os-tap" style={{ padding: 16, display: 'block', textDecoration: 'none', color: 'inherit' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <ClaimChip status={c.status} size="sm" />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--muted)' }}>{c.claimNumber}</span>
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{CLAIM_TYPE_LABEL[c.claimType] ?? c.claimType}</span>
        <span className="tabular-nums" style={{ marginLeft: 'auto', fontSize: 18, fontWeight: 900, letterSpacing: '-.02em' }}>{money(c.totalCents)}</span>
      </div>
      <div style={{ fontWeight: 800, fontSize: 15.5, marginTop: 7 }}>{c.businessName}</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.description}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8, fontSize: 12.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
        <span>{fmtDay(c.claimDate)}</span>
        {c.routeNumber && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{c.routeNumber}</span>}
        {crew ? <span>Crew: {crew}</span> : <span style={{ color: '#fcd34d' }}>No one assigned</span>}
        {owed > 0 && <span className="tabular-nums" style={{ marginLeft: 'auto', color: '#fca5a5', fontWeight: 700 }}>{money(owed)} owed</span>}
      </div>
    </Link>
  )
}

export default function Page() {
  return <OperationsShell><Claims /></OperationsShell>
}
