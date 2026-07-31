'use client'

// Sprint 5 — one retail customer's traceable record.
//
// The point of this page is that a reader can tell WHAT IS STORED from WHAT IS
// DERIVED. The customer↔booking association is derived at read time from the
// email/phone identity indexes; the payments, refunds, communications and events
// inside each booking are stored on that booking. Every entry is labelled, and the
// derivation is stated in prose at the top rather than left as a footnote — a
// derived link can change when an index changes, and the reader has to know that
// before treating this as a financial record.
//
// Incompleteness is shown, never hidden: if the scan stopped early or a record
// could not be read, this says so instead of implying the customer simply has no
// more history.

import { use, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, RefreshCw, ArrowLeft } from 'lucide-react'
import OperationsShell from '../../OperationsShell'
import { Stat } from '../../ui'

type Entry = {
  at: number; kind: 'booking' | 'payment' | 'refund' | 'communication' | 'audit'
  bookingToken: string; bookingNumber: string; label: string; detail?: string
  amountCents?: number; provenance: 'stored' | 'derived'
}
type Timeline = {
  customer: { id: string; name: string; email?: string; phone?: string; bookingCount: number; createdAt: number }
  linkProvenance: 'derived'
  bookings: { token: string; bookingNumber: string; status: string; createdAt: number; basis: string }[]
  entries: Entry[]
  totals: { bookings: number; paidCents: number; refundedCents: number; communications: number }
  conflicts: { bookingToken: string; bookingNumber: string; emailCustomerId: string; phoneCustomerId: string }[]
  scan: { indexed: number; scanned: number; read: number; complete: boolean; pageLimitReached: boolean; unlinkedNoIdentifier: number; missingRecords: number }
  includesAudit: boolean
}

const money = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const ts = (n: number) => new Date(n).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })

const KIND_TONE: Record<Entry['kind'], string> = {
  booking: '#93c5fd', payment: '#86efac', refund: '#fcd34d', communication: '#c4b5fd', audit: 'var(--muted)',
}

export default function CustomerRecordPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [data, setData] = useState<Timeline | null>(null)
  const [err, setErr] = useState('')
  const [notFound, setNotFound] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const res = await fetch(`/api/admin/customers/${id}`, { credentials: 'same-origin' })
      if (res.status === 404) { setNotFound(true); return }
      const d = await res.json().catch(() => ({}))
      // An error must never wipe a record already on screen.
      if (!res.ok) { setErr(d.message || 'Could not load this customer.'); return }
      setData(d as Timeline); setNotFound(false)
    } catch {
      setErr('Connection problem — the record below may be out of date.')
    } finally { setLoading(false) }
  }, [id])

  useEffect(() => { void load() }, [load])

  if (notFound) return (
    <OperationsShell>
      <div style={{ maxWidth: 620 }}>
        <h1 style={{ fontSize: 20, fontWeight: 800 }}>No such customer</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14 }}>That customer record does not exist.</p>
        <Link href="/admin/operations/customers" style={{ color: 'var(--red)', fontWeight: 700, fontSize: 14 }}>← Back to lookup</Link>
      </div>
    </OperationsShell>
  )

  return (
    <OperationsShell>
      <div style={{ maxWidth: 860 }}>
        <Link href="/admin/operations/customers" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 13, fontWeight: 700, textDecoration: 'none', marginBottom: 12 }}>
          <ArrowLeft size={15} /> Lookup
        </Link>

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>{data?.customer.name ?? 'Customer'}</h1>
          <button onClick={load} disabled={loading} className="os-tap"
            style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 13px', borderRadius: 10, background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', color: 'var(--text)', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
            <RefreshCw size={14} /> {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        {data && (
          <p style={{ color: 'var(--muted)', fontSize: 13.5, margin: '0 0 14px' }}>
            {data.customer.email || '—'} · {data.customer.phone || '—'}
          </p>
        )}

        {err && <p role="alert" style={{ color: '#fcd34d', fontSize: 13.5, marginBottom: 12 }}>{err}</p>}

        {data && (
          <>
            <div style={{ padding: '11px 13px', borderRadius: 11, border: '1px solid var(--line)', background: 'rgba(255,255,255,.03)', marginBottom: 14 }}>
              <p style={{ margin: 0, color: 'var(--muted)', fontSize: 12.5, lineHeight: 1.6 }}>
                Bookings are attributed to this customer by matching the booking’s email or phone
                against the customer index — a <strong style={{ color: 'var(--text)' }}>derived</strong> link,
                recalculated on every load, not a stored one. Payments, refunds, messages and events
                are <strong style={{ color: 'var(--text)' }}>stored</strong> on the booking itself.
                Names are never used to match.
              </p>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10, marginBottom: 16 }}>
              <Stat label="Bookings" value={String(data.totals.bookings)} />
              <Stat label="Paid" value={money(data.totals.paidCents)} />
              <Stat label="Refunded" value={money(data.totals.refundedCents)} />
              <Stat label="Messages" value={String(data.totals.communications)} />
            </div>

            {!data.scan.complete && (
              <div role="alert" style={{ padding: '11px 13px', borderRadius: 11, border: '1px solid rgba(245,158,11,.4)', background: 'rgba(245,158,11,.07)', marginBottom: 14 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                  <AlertTriangle size={16} style={{ color: '#fcd34d', flexShrink: 0 }} />
                  <strong style={{ color: '#fcd34d', fontSize: 13.5 }}>This history is incomplete</strong>
                </div>
                <p style={{ margin: 0, color: 'var(--muted)', fontSize: 12.5, lineHeight: 1.55 }}>
                  Scanned {data.scan.scanned.toLocaleString()} of {data.scan.indexed.toLocaleString()} bookings
                  {data.scan.pageLimitReached && ' before reaching the scan limit'}
                  {data.scan.missingRecords > 0 && `; ${data.scan.missingRecords} record(s) could not be read`}.
                  Treat totals as a floor, not a balance.
                </p>
              </div>
            )}

            {data.conflicts.length > 0 && (
              <div role="alert" style={{ padding: '11px 13px', borderRadius: 11, border: '1px solid rgba(245,158,11,.4)', background: 'rgba(245,158,11,.07)', marginBottom: 14 }}>
                <strong style={{ color: '#fcd34d', fontSize: 13.5 }}>{data.conflicts.length} booking(s) need manual review</strong>
                <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 12.5, lineHeight: 1.55 }}>
                  Their email and phone resolve to two different customer records, so they are
                  excluded from the totals above rather than guessed at:{' '}
                  {data.conflicts.map(c => c.bookingNumber).join(', ')}.
                </p>
              </div>
            )}

            <h2 style={{ fontSize: 15, fontWeight: 800, margin: '0 0 9px' }}>
              Timeline{!data.includesAudit && <span style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--muted)' }}> · event history is admin-only</span>}
            </h2>

            {data.entries.length === 0 ? (
              <p style={{ color: 'var(--muted)', fontSize: 14 }}>No activity attributed to this customer.</p>
            ) : (
              <div style={{ display: 'grid', gap: 7 }}>
                {data.entries.map((e, i) => (
                  <div key={`${e.bookingToken}-${e.at}-${i}`}
                    style={{ display: 'flex', gap: 11, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', background: 'rgba(255,255,255,.025)' }}>
                    <div style={{ width: 3, borderRadius: 3, background: KIND_TONE[e.kind], flexShrink: 0 }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 700, fontSize: 13.5 }}>{e.label}</span>
                        {e.amountCents != null && <span style={{ fontSize: 13, color: 'var(--muted)' }}>{money(e.amountCents)}</span>}
                        <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--muted)' }}>{ts(e.at)}</span>
                      </div>
                      {e.detail && <div style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 2, overflowWrap: 'anywhere' }}>{e.detail}</div>}
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>
                        {e.bookingNumber} · {e.provenance === 'derived' ? 'linked by email/phone match' : 'recorded on the booking'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </OperationsShell>
  )
}
