'use client'

// Sprint 5 — retail customer lookup.
//
// Lookup, not a directory: `customers.ts` keeps identity indexes but no customer
// index, so there is nothing honest to list. You arrive here with an email, a
// phone number, or a booking token.
//
// The three outcomes are all rendered explicitly, including the one an operator
// most needs to see — a customer whose email and phone point at two DIFFERENT
// records. That is presented for review, never resolved by picking a side.

import { useState } from 'react'
import Link from 'next/link'
import { Search, AlertTriangle, UserRound, ArrowRight } from 'lucide-react'
import OperationsShell from '../OperationsShell'

type Customer = { id: string; name: string; email?: string; phone?: string; bookingCount: number }
type Side = { id: string; name: string; email?: string; phone?: string } | null

// Flattened from the API shape so the discriminant is top-level and narrowing works.
type Result =
  | { kind: 'linked'; customerId: string; basis: string; customer: Customer }
  | { kind: 'unlinked'; reason: 'no_identifier' | 'no_customer_record' }
  | { kind: 'conflict'; email: Side; phone: Side }

type ApiResponse = {
  link: { kind: 'linked'; customerId: string; basis: string } | { kind: 'unlinked'; reason: 'no_identifier' | 'no_customer_record' } | { kind: 'conflict' }
  customer?: Customer
  review?: { reason: string; email: Side; phone: Side }
}

function toResult(d: ApiResponse): Result | null {
  if (d.link?.kind === 'linked' && d.customer) {
    return { kind: 'linked', customerId: d.link.customerId, basis: d.link.basis, customer: d.customer }
  }
  if (d.link?.kind === 'unlinked') return { kind: 'unlinked', reason: d.link.reason }
  if (d.link?.kind === 'conflict' && d.review) {
    return { kind: 'conflict', email: d.review.email, phone: d.review.phone }
  }
  return null
}

const UNLINKED_COPY: Record<string, string> = {
  no_identifier: 'This booking has neither an email address nor a phone number, so it cannot be attributed to a customer. It is left unlinked rather than matched by name.',
  no_customer_record: 'No customer record matches that email or phone number yet.',
}

export default function CustomerLookupPage() {
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [bookingToken, setBookingToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [result, setResult] = useState<Result | null>(null)

  async function lookup() {
    setBusy(true); setErr(''); setResult(null)
    try {
      const q = new URLSearchParams()
      if (bookingToken.trim()) q.set('bookingToken', bookingToken.trim())
      else { if (email.trim()) q.set('email', email.trim()); if (phone.trim()) q.set('phone', phone.trim()) }
      const res = await fetch(`/api/admin/customers/lookup?${q}`, { credentials: 'same-origin' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(d.message || 'Could not look that up.'); return }
      const r = toResult(d as ApiResponse)
      if (!r) { setErr('That response could not be read.'); return }
      setResult(r)
    } catch {
      setErr('Network error — please try again.')
    } finally { setBusy(false) }
  }

  return (
    <OperationsShell>
      <div style={{ maxWidth: 760 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: '0 0 6px' }}>Customers</h1>
        <p style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.55, margin: '0 0 18px' }}>
          Look up one retail customer by email, phone, or booking. Matching is on email and phone
          only — never on name, because two different people share a name far more often than they
          share a phone number.
        </p>

        <div style={{ display: 'grid', gap: 10, marginBottom: 14 }}>
          <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email address"
            style={FIELD} inputMode="email" autoComplete="off" />
          <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="Phone number"
            style={FIELD} inputMode="tel" autoComplete="off" />
          <input value={bookingToken} onChange={e => setBookingToken(e.target.value)}
            placeholder="…or a booking token (uses that booking’s own contact details)" style={FIELD} autoComplete="off" />
          <button onClick={lookup} disabled={busy} className="os-tap"
            style={{ padding: '12px 16px', borderRadius: 11, border: 'none', background: 'var(--red)', color: '#fff', fontWeight: 800, fontSize: 14, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Search size={16} /> {busy ? 'Looking up…' : 'Look up customer'}
          </button>
        </div>

        {err && <p role="alert" style={{ color: '#f87171', fontSize: 13.5 }}>{err}</p>}

        {result?.kind === 'linked' && (
          <Link href={`/admin/operations/customers/${result.customerId}`} style={{ textDecoration: 'none' }}>
            <div style={CARD}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <UserRound size={20} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 800, fontSize: 15, color: 'var(--text)' }}>{result.customer.name}</div>
                  <div style={{ color: 'var(--muted)', fontSize: 13 }}>
                    {result.customer.email || '—'} · {result.customer.phone || '—'}
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 3 }}>
                    Matched on {result.basis.replace('+', ' and ')}
                  </div>
                </div>
                <ArrowRight size={17} style={{ marginLeft: 'auto', color: 'var(--muted)', flexShrink: 0 }} />
              </div>
            </div>
          </Link>
        )}

        {result?.kind === 'unlinked' && (
          <div style={{ ...CARD, cursor: 'default' }}>
            <div style={{ fontWeight: 800, fontSize: 14.5, marginBottom: 5 }}>No customer record</div>
            <p style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.55, margin: 0 }}>
              {UNLINKED_COPY[result.reason]}
            </p>
          </div>
        )}

        {result?.kind === 'conflict' && (
          <div role="alert" style={{ ...CARD, cursor: 'default', border: '1px solid rgba(245,158,11,.4)', background: 'rgba(245,158,11,.07)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
              <AlertTriangle size={17} style={{ color: '#fcd34d', flexShrink: 0 }} />
              <span style={{ fontWeight: 800, fontSize: 14.5, color: '#fcd34d' }}>Needs manual review</span>
            </div>
            <p style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.55, margin: '0 0 12px' }}>
              The email and the phone number point at two different customer records. Nothing is
              joined automatically — picking one would attach one person’s payment history to
              another’s. Decide which record is correct before relying on either timeline.
            </p>
            <div style={{ display: 'grid', gap: 8 }}>
              <ConflictSide title="Matched by email" side={result.email} />
              <ConflictSide title="Matched by phone" side={result.phone} />
            </div>
          </div>
        )}
      </div>
    </OperationsShell>
  )
}

function ConflictSide({ title, side }: { title: string; side: Side }) {
  return (
    <div style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', background: 'rgba(255,255,255,.03)' }}>
      <div style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)', marginBottom: 3 }}>{title}</div>
      {side ? (
        <>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{side.name}</div>
          <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>{side.email || '—'} · {side.phone || '—'}</div>
          <Link href={`/admin/operations/customers/${side.id}`} style={{ fontSize: 12.5, color: 'var(--red)', fontWeight: 700 }}>
            Open this record →
          </Link>
        </>
      ) : <div style={{ color: 'var(--muted)', fontSize: 13 }}>That record no longer exists.</div>}
    </div>
  )
}

const FIELD: React.CSSProperties = {
  width: '100%', padding: '11px 12px', borderRadius: 10, background: 'rgba(255,255,255,.04)',
  border: '1px solid var(--line)', color: 'var(--text)', fontSize: 14, fontFamily: 'inherit',
}
const CARD: React.CSSProperties = {
  display: 'block', padding: '14px 15px', borderRadius: 12, border: '1px solid var(--line)',
  background: 'rgba(255,255,255,.03)', marginTop: 12, cursor: 'pointer',
}
