'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ShieldAlert } from 'lucide-react'
import { ClaimChip, money, fmtDay, osLabel } from '../ui'
import { useClaims, claimOutstanding } from './useClaims'
import NewClaim from './NewClaim'

// Claims History for ONE business — dropped into the Businesses page. Thin: all the
// arithmetic it shows comes from the claim records the API already returned.
const CLOSED = ['paid', 'closed', 'waived']

export default function ClaimsHistory({ businessKey, businessName }: { businessKey: string; businessName: string }) {
  const { claims, reload } = useClaims()
  const [creating, setCreating] = useState(false)

  const s = useMemo(() => {
    const rows = claims
      .filter(c => c.businessKey === businessKey)
      .sort((a, b) => b.claimDate.localeCompare(a.claimDate))
    const total = rows.reduce((n, c) => n + c.totalCents, 0)
    const outstanding = rows.reduce((n, c) => n + claimOutstanding(c), 0)
    const open = rows.filter(c => !CLOSED.includes(c.status)).length
    return {
      rows, total, outstanding, open,
      closed: rows.length - open,
      average: rows.length ? Math.round(total / rows.length) : 0,
      largest: rows.reduce((m, c) => Math.max(m, c.totalCents), 0),
    }
  }, [claims, businessKey])

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ ...osLabel, display: 'flex', alignItems: 'center', gap: 6 }}><ShieldAlert size={13} /> Claims history</div>
        <button onClick={() => setCreating(true)} className="os-tap" style={{ fontSize: 12, fontWeight: 700, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer' }}>+ New claim</button>
      </div>

      {s.rows.length === 0 ? (
        <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>No claims from this client. Clean record.</p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--muted)', marginBottom: 8 }}>
            <span>{s.rows.length} claim{s.rows.length === 1 ? '' : 's'}</span>
            {s.open > 0 && <span style={{ color: '#fcd34d' }}>{s.open} open</span>}
            <span>{money(s.total)} lifetime</span>
            <span>avg {money(s.average)}</span>
            <span>largest {money(s.largest)}</span>
            {s.outstanding > 0 && <span style={{ color: '#fca5a5', fontWeight: 700 }}>{money(s.outstanding)} outstanding</span>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {s.rows.slice(0, 6).map(c => (
              <Link key={c.id} href={`/admin/operations/claims/${c.id}`} className="os-tap"
                style={{ display: 'flex', gap: 10, fontSize: 13, alignItems: 'center', textDecoration: 'none', color: 'inherit' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--muted)', minWidth: 80 }}>{c.claimNumber}</span>
                <ClaimChip status={c.status} size="sm" />
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>{fmtDay(c.claimDate)}</span>
                <span className="tabular-nums" style={{ marginLeft: 'auto', fontWeight: 700 }}>{money(c.totalCents)}</span>
              </Link>
            ))}
            {s.rows.length > 6 && (
              <Link href="/admin/operations/claims" style={{ fontSize: 12.5, color: 'var(--red)', fontWeight: 700, textDecoration: 'none', marginTop: 2 }}>
                View all {s.rows.length} →
              </Link>
            )}
          </div>
        </>
      )}

      {creating && <NewClaim businessName={businessName} onClose={() => setCreating(false)} onCreated={reload} />}
    </div>
  )
}
