'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { ShieldAlert } from 'lucide-react'
import { ClaimChip, RESP_COLOR, money, fmtDay, osLabel } from '../ui'
import { useClaims, remainingCents, recoveredCents } from './useClaims'

// Claims & Deductions for ONE crew member — dropped into the Employees page.
// Shows only THEIR responsibility, never the claim's full value, never another
// crew member's balance, and never what the business paid for the route.
const CLOSED = ['paid', 'closed', 'waived']

export default function CrewClaims({ staffId }: { staffId: string }) {
  const { claims } = useClaims()

  const s = useMemo(() => {
    const lines = claims
      .map(c => {
        const a = c.assignments.find(x => x.staffId === staffId)
        return a ? { c, a } : null
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((x, y) => y.c.claimDate.localeCompare(x.c.claimDate))

    return {
      lines,
      open: lines.filter(l => !CLOSED.includes(l.c.status) || remainingCents(l.a) > 0).length,
      responsibility: lines.reduce((n, l) => n + l.a.responsibilityCents, 0),
      recovered: lines.reduce((n, l) => n + recoveredCents(l.a), 0),
      outstanding: lines.reduce((n, l) => n + remainingCents(l.a), 0),
      weekly: lines.reduce((n, l) => n + (l.a.status === 'active' ? l.a.weeklyDeductionCents ?? 0 : 0), 0),
    }
  }, [claims, staffId])

  if (!s.lines.length) return null

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ ...osLabel, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <ShieldAlert size={13} /> Claims &amp; deductions
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--muted)', marginBottom: 9 }}>
        <span>{s.lines.length} claim{s.lines.length === 1 ? '' : 's'}</span>
        {s.open > 0 && <span style={{ color: '#fcd34d' }}>{s.open} open</span>}
        <span>{money(s.responsibility)} responsibility</span>
        <span style={{ color: '#86efac' }}>{money(s.recovered)} paid</span>
        {s.outstanding > 0 && <span style={{ color: '#fca5a5', fontWeight: 700 }}>{money(s.outstanding)} owed</span>}
        {s.weekly > 0 && <span style={{ color: '#7dd3fc' }}>{money(s.weekly)}/wk deducted</span>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {s.lines.slice(0, 6).map(({ c, a }) => {
          const left = remainingCents(a)
          return (
            <Link key={c.id} href={`/admin/operations/claims/${c.id}`} className="os-tap"
              style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, textDecoration: 'none', color: 'inherit' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--muted)', minWidth: 80 }}>{c.claimNumber}</span>
              <ClaimChip status={c.status} size="sm" />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.businessName}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: RESP_COLOR[a.status] }}>{a.status}</span>
              <span className="tabular-nums" style={{ fontWeight: 700, minWidth: 72, textAlign: 'right', color: left ? '#fca5a5' : '#86efac' }}>
                {money(left)}
              </span>
            </Link>
          )
        })}
      </div>

      {s.lines[0] && s.lines[0].a.nextDeductionOn && s.lines[0].a.status === 'active' && (
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 7 }}>
          Next deduction {fmtDay(s.lines[0].a.nextDeductionOn)} — it will appear on their pay statement.
        </p>
      )}
    </div>
  )
}
