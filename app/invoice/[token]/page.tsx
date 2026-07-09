'use client'

import { use, useEffect, useState } from 'react'
import { COMPANY } from '../../lib/company';
import { AlertTriangle, CheckCircle2 } from 'lucide-react'

type Line = { routeNumber?: string; routeDate?: string; description: string; amountCents: number }
type Invoice = {
  invoiceNumber: string; businessName: string; clientName?: string
  periodStart?: string; periodEnd?: string; lines: Line[]; notes?: string
  status: 'draft' | 'sent' | 'paid' | 'void'
  subtotalCents: number; amountPaidCents: number; balanceCents: number
  paidAt?: number; stripeConfigured: boolean
}

const money = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const fmtDate = (iso?: string) => { if (!iso) return ''; const d = new Date(`${iso}T12:00:00Z`); return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) }

export default function InvoicePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const [inv, setInv] = useState<Invoice | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [paying, setPaying] = useState(false)
  const [err, setErr] = useState('')
  const [justPaid, setJustPaid] = useState(false)
  const [cancelled, setCancelled] = useState(false)

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    if (sp.get('paid') === '1') setJustPaid(true)
    if (sp.get('pay') === 'cancelled') setCancelled(true)
    let alive = true
    fetch(`/api/invoice/${token}`, { cache: 'no-store' })
      .then(async r => { if (r.status === 404) { setNotFound(true); return null } return r.json() })
      .then(d => { if (alive && d?.invoice) setInv(d.invoice) })
      .catch(() => { if (alive) setNotFound(true) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [token])

  async function pay() {
    setPaying(true); setErr('')
    try {
      const res = await fetch(`/api/invoice/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const d = await res.json().catch(() => ({}))
      if (res.ok && d.url) { window.location.href = d.url; return }
      setErr(d.error || 'Could not start payment. Please try again.')
    } catch { setErr('Network error — please try again.') } finally { setPaying(false) }
  }

  const wrap = (children: React.ReactNode) => (
    <main style={{ minHeight: '100svh', background: 'var(--bg)', color: 'var(--text)', padding: '28px 18px 48px', display: 'flex', justifyContent: 'center' }}>
      <style>{`@media print { .no-print { display: none !important; } }`}</style>
      <div style={{ width: '100%', maxWidth: 560 }}>
        <p style={{ fontWeight: 900, letterSpacing: '-0.03em', fontSize: 22, marginBottom: 18 }}>{COMPANY.nameLead} <span style={{ color: 'var(--red)' }}>{COMPANY.nameAccent}</span></p>
        {children}
      </div>
    </main>
  )
  const card = (bg: string, border: string): React.CSSProperties => ({ background: bg, border: `1px solid ${border}`, borderRadius: 18, padding: 22 })

  if (loading) return wrap(<div className="glass-card" style={{ borderRadius: 18, padding: 22, textAlign: 'center', color: 'var(--muted)' }}>Loading invoice…</div>)
  if (notFound || !inv) return wrap(
    <div style={card('rgba(255,255,255,.04)', 'var(--line)')}>
      <AlertTriangle size={26} color="#f59e0b" />
      <h1 style={{ fontSize: 18, fontWeight: 800, marginTop: 10 }}>Invoice not found</h1>
      <p style={{ color: 'var(--muted)', marginTop: 8, fontSize: 14 }}>{`This invoice link isn’t valid. Contact ${COMPANY.legalName} at ${COMPANY.phoneDisplay}.`}</p>
    </div>
  )

  const isPaid = inv.status === 'paid' || justPaid || inv.balanceCents <= 0

  return wrap(
    <div style={card('rgba(255,255,255,.04)', 'var(--line)')}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--red)' }}>Invoice</div>
          <h1 style={{ fontSize: 22, fontWeight: 800, marginTop: 2, letterSpacing: '-0.02em', fontFamily: 'var(--font-mono)' }}>{inv.invoiceNumber}</h1>
        </div>
        {isPaid
          ? <span style={{ fontSize: 12, fontWeight: 800, padding: '5px 12px', borderRadius: 99, background: 'rgba(34,197,94,.16)', color: '#22c55e', display: 'inline-flex', alignItems: 'center', gap: 5 }}><CheckCircle2 size={14} /> Paid</span>
          : <span style={{ fontSize: 12, fontWeight: 800, padding: '5px 12px', borderRadius: 99, background: 'rgba(245,158,11,.14)', color: '#f59e0b' }}>Due</span>}
      </div>

      <div style={{ marginTop: 10, fontSize: 14, color: 'var(--muted)' }}>
        <div>Billed to: <b style={{ color: 'var(--text)' }}>{inv.clientName || inv.businessName}</b></div>
        {inv.periodStart && inv.periodEnd && <div>Period: {fmtDate(inv.periodStart)} – {fmtDate(inv.periodEnd)}</div>}
      </div>

      <div style={{ marginTop: 18, borderTop: '1px solid var(--line)' }}>
        {inv.lines.map((l, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '11px 0', borderBottom: '1px solid var(--line)' }}>
            <div>
              <div style={{ fontSize: 14.5, fontWeight: 600 }}>{l.description}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>{[l.routeNumber, fmtDate(l.routeDate)].filter(Boolean).join(' · ')}</div>
            </div>
            <div style={{ fontSize: 14.5, fontWeight: 700, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{money(l.amountCents)}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
        <span style={{ fontSize: 16, fontWeight: 700 }}>{isPaid ? 'Total paid' : 'Total due'}</span>
        <span style={{ fontSize: 24, fontWeight: 900, color: isPaid ? '#22c55e' : 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{money(isPaid ? inv.subtotalCents : inv.balanceCents)}</span>
      </div>

      {inv.notes && <p style={{ marginTop: 14, fontSize: 13.5, color: 'var(--muted)', padding: 12, borderRadius: 10, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>{inv.notes}</p>}

      {justPaid && <p style={{ marginTop: 16, fontSize: 14, color: '#22c55e', fontWeight: 600 }}>Payment received — thank you!</p>}
      {cancelled && !isPaid && <p style={{ marginTop: 16, fontSize: 13.5, color: 'var(--muted)' }}>Payment was cancelled. You can try again below.</p>}
      {err && <p style={{ color: '#f87171', fontSize: 13.5, marginTop: 12 }}>{err}</p>}

      {!isPaid && (
        <div className="no-print" style={{ marginTop: 18 }}>
          {inv.stripeConfigured ? (
            <button onClick={pay} disabled={paying}
              style={{ width: '100%', padding: '15px', borderRadius: 12, border: 'none', fontWeight: 800, fontSize: 15, color: '#fff', background: 'var(--red)', cursor: 'pointer', opacity: paying ? .7 : 1 }}>
              {paying ? 'Starting checkout…' : `Pay ${money(inv.balanceCents)}`}
            </button>
          ) : (
            <p style={{ fontSize: 13.5, color: 'var(--muted)' }}>{`To pay this invoice, contact ${COMPANY.legalName} at ${COMPANY.phoneDisplay}.`}</p>
          )}
          <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 10, textAlign: 'center' }}>A card processing fee is added at checkout.</p>
        </div>
      )}

      <button onClick={() => window.print()} className="no-print" style={{ marginTop: 14, width: '100%', padding: '11px', borderRadius: 10, border: '1px solid var(--line)', background: 'transparent', color: 'var(--muted)', fontWeight: 700, fontSize: 13.5, cursor: 'pointer' }}>Print / Save PDF</button>
    </div>
  )
}
