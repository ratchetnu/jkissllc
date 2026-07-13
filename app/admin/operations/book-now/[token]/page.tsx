'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, Camera, ExternalLink } from 'lucide-react'
import OperationsShell from '../../OperationsShell'
import WorkflowTimeline from '../../../bookings/WorkflowTimeline'
import { fmtTs, money } from '../../ui'
import { SERVICE_LABELS, type Booking } from '../../../../lib/bookings'
import {
  bookNowStage, bookNowServiceGroup, aiStatus, quoteStatus, paymentStatus, ownerAlertStatus,
  BOOK_NOW_STAGE_LABEL,
} from '../../../../lib/book-now-queue'

const GROUP_LABEL: Record<string, string> = { junk: 'Junk Removal', moving: 'Moving', delivery: 'Delivery', other: 'Service' }

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="os-card" style={{ padding: 18, marginBottom: 14 }}>
      <p style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)', marginBottom: 10 }}>{title}</p>
      {children}
    </div>
  )
}
function KV({ k, v }: { k: string; v?: string | number | null }) {
  if (v === undefined || v === null || v === '') return null
  return <div className="flex justify-between gap-3" style={{ padding: '4px 0' }}><span style={{ fontSize: 12.5, color: 'var(--muted)', flexShrink: 0 }}>{k}</span><span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', textAlign: 'right', wordBreak: 'break-word' }}>{v}</span></div>
}

function Detail({ token }: { token: string }) {
  const [b, setB] = useState<Booking | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [lightbox, setLightbox] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/admin/book-now', { credentials: 'same-origin' })
      if (res.status === 401) { setError('Session expired — reload.'); return }
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'Failed')
      const found = (j.items as Booking[]).find(x => x.token === token) ?? null
      setB(found)
      if (!found) setError('Request not found.')
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed') }
    finally { setLoading(false) }
  }, [token])
  useEffect(() => { load() }, [load])

  const run = async (action: string, body: Record<string, unknown> = {}) => {
    setBusy(action)
    try {
      const res = await fetch(`/api/admin/bookings/${token}`, {
        method: 'PATCH', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...body }),
      })
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error ?? 'Action failed') }
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed') }
    finally { setBusy('') }
  }

  if (loading) return <p style={{ color: 'var(--muted)' }}>Loading…</p>
  if (!b) return (
    <div>
      <Link href="/admin/operations/book-now" style={{ color: 'var(--muted)', fontSize: 13 }}>← Book Now Requests</Link>
      <p role="alert" style={{ color: '#f87171', marginTop: 16 }}>{error || 'Not found.'}</p>
    </div>
  )

  const stage = bookNowStage(b)
  const alert = ownerAlertStatus(b)
  const est = b.aiEstimate
  const bn = b.bookNow
  const mailto = b.customerEmail ? `mailto:${b.customerEmail}` : undefined
  const tel = b.customerPhone ? `tel:${b.customerPhone.replace(/[^\d+]/g, '')}` : undefined
  const btn: React.CSSProperties = { fontSize: 12.5, fontWeight: 700, padding: '8px 13px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--text)', cursor: 'pointer', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }

  return (
    <div>
      <Link href="/admin/operations/book-now" style={{ color: 'var(--muted)', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 5, marginBottom: 14 }}><ArrowLeft size={14} /> Book Now Requests</Link>

      {/* Header */}
      <div className="os-card" style={{ padding: 18, marginBottom: 14, borderColor: 'var(--red)' }}>
        <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 6 }}>
          <span style={{ background: 'var(--red)', color: '#fff', borderRadius: 6, fontSize: 10, fontWeight: 800, padding: '2px 7px', letterSpacing: '.04em' }}>⚡ BOOK NOW</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>{BOOK_NOW_STAGE_LABEL[stage]}</span>
          {!!b.createdAt && <span style={{ fontSize: 12, color: 'var(--muted)' }}>· submitted {fmtTs(b.createdAt)}</span>}
        </div>
        <p style={{ fontSize: 22, fontWeight: 900, color: 'var(--text)' }}>{b.customerName}</p>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
          {GROUP_LABEL[bookNowServiceGroup(b.serviceType)]} · {SERVICE_LABELS[b.serviceType] ?? b.serviceType} · <span className="font-mono">{b.bookingNumber}</span>
        </p>
        <div className="flex items-center gap-2 flex-wrap" style={{ marginTop: 12 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: alert === 'sent' ? '#34d399' : alert === 'failed' ? '#f87171' : '#fbbf24' }}>
            {alert === 'sent' ? '✓ Owner alerted' : alert === 'failed' ? '⚠ Alert failed' : '⚠ No owner alert on record'}
          </span>
          <button onClick={() => run('resend-notification', { kind: 'new_submission' })} disabled={busy === 'resend-notification'} style={{ ...btn, borderColor: 'var(--red)', color: '#fff', background: 'var(--red)' }}>
            {busy === 'resend-notification' ? '…' : alert === 'sent' ? 'Re-send Alert' : 'Send Owner Alert'}
          </button>
        </div>
      </div>

      {error && <p role="alert" style={{ color: '#f87171', fontSize: 13, marginBottom: 12 }}>{error}</p>}

      <Section title="Customer">
        <KV k="Name" v={b.customerName} />
        <KV k="Phone" v={b.customerPhone} />
        <KV k="Email" v={b.customerEmail} />
        <KV k="Preferred contact" v={bn?.contactMethod} />
      </Section>

      <Section title="Request">
        <KV k="Source" v="Book Now (online wizard)" />
        <KV k="Submitted" v={b.createdAt ? fmtTs(b.createdAt) : undefined} />
        <KV k="Service family" v={GROUP_LABEL[bookNowServiceGroup(b.serviceType)]} />
        <KV k="Service type" v={SERVICE_LABELS[b.serviceType] ?? b.serviceType} />
        <KV k="Requested date" v={bn?.requestedDate || b.availableDates?.[0]} />
        <KV k="Load size" v={bn?.loadSizeLabel} />
        <KV k="Timing preference" v={bn?.timing} />
        <KV k="Add-ons" v={bn?.addOns?.length ? bn.addOns.join(', ') : undefined} />
        <KV k="Promo code" v={b.promoCode} />
        {(bn?.shownEstimateHighCents ?? 0) > 0 && <KV k="Instant estimate shown" v={`${money(bn!.shownEstimateLowCents ?? 0)} – ${money(bn!.shownEstimateHighCents ?? 0)}`} />}
        {b.description && <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 8, whiteSpace: 'pre-wrap' }}>{b.description}</p>}
        {b.customerNotes && <p style={{ fontSize: 12.5, color: 'var(--text)', marginTop: 8, whiteSpace: 'pre-wrap' }}><strong>Customer notes:</strong> {b.customerNotes}</p>}
      </Section>

      <Section title="Locations">
        <KV k="Job site" v={b.jobSiteAddress} />
        <KV k="Pickup" v={b.pickupAddress} />
        <KV k="Delivery" v={b.dropoffAddress} />
        <KV k="Gate code" v={b.gateCode} />
        <KV k="Parking" v={b.parkingNotes} />
        <KV k="Access" v={b.accessNotes} />
        <KV k="Special instructions" v={b.specialInstructions} />
      </Section>

      <Section title={`Photos · ${b.invoicePhotos?.length ?? 0}`}>
        {b.invoicePhotos && b.invoicePhotos.length > 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(74px, 1fr))', gap: 8 }}>
            {b.invoicePhotos.map((p, n) => (
              <button key={n} type="button" onClick={() => setLightbox(n)} aria-label={`View photo ${n + 1}`}
                style={{ aspectRatio: '1 / 1', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--line)', cursor: 'zoom-in', padding: 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.url} alt={p.name ?? `Photo ${n + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </button>
            ))}
          </div>
        ) : (
          <p style={{ fontSize: 12.5, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Camera size={14} /> No photos uploaded yet.</p>
        )}
      </Section>

      <Section title="AI & Pricing">
        <KV k="Analysis status" v={aiStatus(b)} />
        {est ? (
          <>
            <KV k="Decision" v={est.decision} />
            <KV k="Recommended quote" v={est.pricing?.recommendedUsd != null ? `$${est.pricing.recommendedUsd.toLocaleString()}` : undefined} />
            <KV k="Load range" v={est.pricing ? `$${est.pricing.lowUsd?.toLocaleString()} – $${est.pricing.highUsd?.toLocaleString()}` : undefined} />
            <KV k="Labor estimate" v={est.pricing?.breakdown?.laborCents != null ? money(est.pricing.breakdown.laborCents) : undefined} />
            <KV k="Disposal estimate" v={est.pricing?.breakdown?.disposalCents != null ? money(est.pricing.breakdown.disposalCents) : (b.disposalEstimateCents != null ? money(b.disposalEstimateCents) : undefined)} />
            <KV k="Disposal trips" v={est.pricing?.breakdown?.disposalTrips} />
            <KV k="Confidence" v={est.analysis?.confidence?.overall != null ? `${Math.round((est.analysis.confidence.overall) * 100)}%` : undefined} />
            <KV k="Manual review" v={est.decision === 'manual_review' ? 'required' : 'not required'} />
            <KV k="Overridden quote" v={est.override?.overriddenUsd != null ? `$${est.override.overriddenUsd.toLocaleString()}` : undefined} />
          </>
        ) : (
          <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>No AI estimate yet{(b.invoicePhotos?.length ?? 0) > 0 ? ' — analysis pending.' : ' — no photos to analyze.'}</p>
        )}
        <Link href={`/admin/bookings?b=${encodeURIComponent(b.bookingNumber)}`} style={{ ...btn, marginTop: 10 }}>
          <ExternalLink size={13} /> Open full estimate editor (modify / approve / send quote)
        </Link>
      </Section>

      <Section title="Workflow">
        <KV k="Quote status" v={quoteStatus(b)} />
        <KV k="Payment status" v={paymentStatus(b)} />
        <KV k="Booking status" v={b.status} />
        <KV k="Owner alert" v={alert} />
        <div style={{ marginTop: 12 }}><WorkflowTimeline booking={b} /></div>
      </Section>

      <Section title="Actions">
        <div className="flex flex-wrap gap-2">
          {mailto && <a href={mailto} style={btn}>✉ Email customer</a>}
          {tel && <a href={tel} style={btn}>📞 Call customer</a>}
          <Link href={`/admin/bookings?b=${encodeURIComponent(b.bookingNumber)}`} style={btn}><ExternalLink size={13} /> Full editor</Link>
          {b.archived
            ? <button onClick={() => run('unarchive')} disabled={busy === 'unarchive'} style={btn}>Restore</button>
            : <button onClick={() => run('archive')} disabled={busy === 'archive'} style={btn}>Archive</button>}
          {b.isTest
            ? <button onClick={() => run('unmark-test')} disabled={busy === 'unmark-test'} style={btn}>Convert to production</button>
            : <button onClick={() => run('mark-test')} disabled={busy === 'mark-test'} style={btn}>Mark test</button>}
        </div>
      </Section>

      {b.invoicePhotos && lightbox !== null && (
        <button onClick={() => setLightbox(null)} aria-label="Close photo"
          style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,.85)', border: 'none', cursor: 'zoom-out', display: 'grid', placeItems: 'center', padding: 20 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={b.invoicePhotos[lightbox].url} alt={`Photo ${lightbox + 1}`} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 10 }} />
        </button>
      )}
    </div>
  )
}

export default function BookNowDetailPage() {
  const params = useParams()
  const token = String(params?.token ?? '')
  return <OperationsShell><Detail token={token} /></OperationsShell>
}
