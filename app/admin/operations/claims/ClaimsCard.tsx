'use client'

import Link from 'next/link'
import { ShieldAlert } from 'lucide-react'
import { money } from '../ui'
import { useClaims } from './useClaims'

// Home-screen claims summary. Deliberately quiet: with no claims and nothing
// outstanding there's nothing to act on, so the card stays out of the way.
export default function ClaimsCard() {
  const { report } = useClaims()
  if (!report || (report.openCount === 0 && report.outstandingCents === 0)) return null

  const bits = [
    report.openCount > 0 && `${report.openCount} open`,
    report.outstandingCents > 0 && `${money(report.outstandingCents)} outstanding`,
    report.recoveredCents > 0 && `${money(report.recoveredCents)} recovered`,
  ].filter(Boolean).join(' · ')

  return (
    <Link href="/admin/operations/claims" className="os-card os-tap os-rise"
      style={{ display: 'flex', alignItems: 'center', gap: 13, padding: 16, marginBottom: 26, textDecoration: 'none', color: 'var(--text)' }}>
      <div style={{ width: 38, height: 38, borderRadius: 11, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)' }}>
        <ShieldAlert size={18} style={{ color: report.openCount ? '#fcd34d' : 'var(--muted)' }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>Claims</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{bits}</div>
      </div>
      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--red)' }}>Open →</span>
    </Link>
  )
}
