'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, Camera, ExternalLink, Send, RefreshCw, CheckCircle2, MessageSquarePlus, AlertTriangle } from 'lucide-react'
import OperationsShell from '../../OperationsShell'
import WorkflowTimeline from '../../../bookings/WorkflowTimeline'
import { fmtTs, money } from '../../ui'
import { SERVICE_LABELS, INFO_REQUEST_FIELD_LABEL, type Booking, type InfoRequestField } from '../../../../lib/bookings'
import type { EstimationResult } from '../../../../lib/estimation/types'
import {
  bookNowStage, bookNowServiceGroup, aiStatus, quoteStatus, paymentStatus, ownerAlertStatus,
  confirmationStatus, BOOK_NOW_STAGE_LABEL,
} from '../../../../lib/book-now-queue'
import { buildOwnerReviewModel } from '../../../../lib/ai/confirmation-review'

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
function CountBadge({ label, n, tone }: { label: string; n: number; tone: string }) {
  if (n <= 0) return null
  return <span style={{ fontSize: 11, fontWeight: 700, color: tone, border: `1px solid ${tone}`, borderRadius: 999, padding: '2px 9px', background: `${tone}14` }}>{n} {label}</span>
}
const PROV_TONE: Record<string, string> = { ai: '#60a5fa', customer: '#34d399', owner: '#c084fc', combined: '#34d399', removed: '#f87171' }
const PROV_LABEL: Record<string, string> = { ai: 'AI', customer: 'Cust', owner: 'Owner', combined: 'Conf', removed: 'Rem' }
function ProvBadge({ p }: { p: string }) {
  const tone = PROV_TONE[p] ?? 'var(--muted)'
  return <span style={{ fontSize: 9.5, fontWeight: 800, color: tone, border: `1px solid ${tone}`, borderRadius: 5, padding: '2px 5px', flexShrink: 0, minWidth: 38, textAlign: 'center' }}>{PROV_LABEL[p] ?? p}</span>
}

function Detail({ token }: { token: string }) {
  const [b, setB] = useState<Booking | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [lightbox, setLightbox] = useState<number | null>(null)
  const [isOwner, setIsOwner] = useState(false)
  const [showInfoForm, setShowInfoForm] = useState(false)
  const [infoFields, setInfoFields] = useState<InfoRequestField[]>([])
  const [infoReason, setInfoReason] = useState('')

  useEffect(() => {
    fetch('/api/admin/session', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null).then(d => setIsOwner(d?.role === 'admin')).catch(() => {})
  }, [])

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

  // Short-poll while the AI job is actively moving so the owner watches it advance
  // without refreshing. Stops as soon as it reaches a terminal state.
  const activeJob = [b?.aiJob?.status, b?.finalAiJob?.status].some(s => s === 'queued' || s === 'processing' || s === 'retrying')
  useEffect(() => {
    if (!activeJob) return
    const t = setInterval(() => { load() }, 6000)
    return () => clearInterval(t)
  }, [activeJob, load])

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
  const review = b.confirmation || b.finalAiEstimate ? buildOwnerReviewModel(b) : null
  const confStatus = confirmationStatus(b)
  const fj = b.finalAiJob
  const toggleInfoField = (f: InfoRequestField) => setInfoFields(prev => prev.includes(f) ? prev.filter(x => x !== f) : [...prev, f])
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

        {/* Shadow estimate (VISION_ESTIMATION_SHADOW) — the deterministic engine's
            parallel result. INTERNAL only; never authoritative, never shown to the
            customer. Renders only when a shadow result was attached (i.e. the flag was on). */}
        {(() => {
          const shadow = (b as { shadowEstimate?: EstimationResult }).shadowEstimate
          if (!shadow) return null
          const itemsLabel = shadow.inventory.map((i) => `${i.itemName}×${i.count}`).join(', ')
          return (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
              <p style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', marginBottom: 8 }}>
                Shadow estimate · internal — not shown to customer
              </p>
              <KV k="Engine recommended" v={money(shadow.pricing.recommendedCents)} />
              <KV k="Engine range" v={`${money(shadow.pricing.rangeCents.low)} – ${money(shadow.pricing.rangeCents.high)}`} />
              <KV k="Inventory" v={itemsLabel || 'none detected'} />
              <KV k="Volume (cu yd)" v={`${shadow.volume.cubicYards.low}–${shadow.volume.cubicYards.high} (exp ${shadow.volume.cubicYards.expected})`} />
              <KV k="Truck loads" v={shadow.volume.truckLoads.expected} />
              <KV k="Weight (lbs)" v={`${shadow.weight.pounds.low}–${shadow.weight.pounds.high}`} />
              <KV k="Crew / labor" v={`${shadow.complexity.recommendedCrewSize} crew · ${shadow.complexity.laborHours.expected}h`} />
              <KV k="Complexity" v={shadow.complexity.level} />
              <KV k="Risk" v={shadow.riskLevel} />
              <KV k="Restricted items" v={shadow.restrictedItems.join(', ') || 'none'} />
              <KV k="Manual review" v={shadow.manualReviewRequired ? shadow.manualReviewReasons.join('; ') || 'required' : 'not required'} />
              {shadow.clarificationQuestions.length > 0 && (
                <KV k="Clarify" v={shadow.clarificationQuestions.map((q) => q.question).join(' | ')} />
              )}
              <KV k="Engine version" v={`v${shadow.engineVersion} · pricing ${shadow.pricingRuleVersion}`} />
            </div>
          )
        })()}

        {/* Durable server-side processing job — real, persisted status + owner controls. */}
        {b.aiJob && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
            <p style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', marginBottom: 8 }}>Server AI Processing Job</p>
            <KV k="AI status" v={b.aiJob.status} />
            <KV k="Attempts" v={b.aiJob.attempts} />
            <KV k="Last attempt" v={b.aiJob.lastAttemptAt ? fmtTs(b.aiJob.lastAttemptAt) : undefined} />
            <KV k="Next retry" v={b.aiJob.nextRetryAt && (b.aiJob.status === 'queued' || b.aiJob.status === 'retrying') ? fmtTs(b.aiJob.nextRetryAt) : undefined} />
            <KV k="Error" v={b.aiJob.errorCode ? `${b.aiJob.errorCode}${b.aiJob.errorSummary ? ` — ${b.aiJob.errorSummary}` : ''}` : undefined} />
            <KV k="Provider" v={b.aiJob.provider} />
            <KV k="Model" v={b.aiJob.model} />
            <KV k="Trace" v={b.aiJob.providerTraceId} />
          </div>
        )}

        {isOwner && (
          <div className="flex flex-wrap gap-2" style={{ marginTop: 12 }}>
            {(!b.aiJob || b.aiJob.status === 'not_started' || b.aiJob.status === 'failed') && (b.invoicePhotos?.length ?? 0) > 0 &&
              <button onClick={() => run(b.aiJob?.status === 'failed' ? 'retry-ai' : 'run-ai')} disabled={busy === 'run-ai' || busy === 'retry-ai'} style={{ ...btn, borderColor: 'var(--red)', color: '#fff', background: 'var(--red)' }}>
                {busy === 'run-ai' || busy === 'retry-ai' ? 'Running…' : b.aiJob?.status === 'failed' ? 'Retry AI Analysis' : 'Run AI Analysis'}
              </button>}
            {(b.aiJob?.status === 'queued' || b.aiJob?.status === 'retrying') &&
              <button onClick={() => run('cancel-ai')} disabled={busy === 'cancel-ai'} style={btn}>Cancel Pending Analysis</button>}
            {b.aiJob?.status !== 'manual_review' &&
              <button onClick={() => run('send-manual-review')} disabled={busy === 'send-manual-review'} style={btn}>Send to Manual Review</button>}
          </div>
        )}

        <Link href={`/admin/bookings?b=${encodeURIComponent(b.bookingNumber)}`} style={{ ...btn, marginTop: 10 }}>
          <ExternalLink size={13} /> Open full estimate editor (modify / approve / send quote)
        </Link>
      </Section>

      {/* ── Estate / property cleanout (Estate Cleanout edition) ───────────── */}
      {review?.isEstate && review.estate && (
        <Section title={`Estate Cleanout${review.estateSubtypeLabel ? ` · ${review.estateSubtypeLabel}` : ''}`}>
          {(review.sensitiveItemNames.length > 0 || review.siteVisit) && (
            <div style={{ marginBottom: 10, padding: '9px 11px', borderRadius: 8, border: '1px solid #f87171', background: 'rgba(248,113,113,.07)' }}>
              {review.siteVisit && <p style={{ fontSize: 12, fontWeight: 800, color: '#f59e0b', display: 'flex', alignItems: 'center', gap: 5 }}><AlertTriangle size={13} /> Site visit required — not auto-quoted.</p>}
              {review.sensitiveItemNames.length > 0 && <p style={{ fontSize: 12, color: '#f87171', marginTop: review.siteVisit ? 4 : 0 }}>⚠ Sensitive property flagged: {review.sensitiveItemNames.join(', ')} — route to owner before disposal.</p>}
            </div>
          )}
          <KV k="Property type" v={review.estate.propertyType} />
          <KV k="Approx. size" v={review.estate.approxSizeSqft ? `${review.estate.approxSizeSqft.toLocaleString()} sq ft` : undefined} />
          <KV k="Occupancy" v={review.estate.occupancy} />
          <KV k="Customer relationship" v={review.estate.relationship?.replace(/_/g, ' ')} />
          <KV k="Rep onsite" v={review.estate.repOnsite === undefined ? undefined : review.estate.repOnsite ? 'Yes' : 'No'} />
          <KV k="Access method" v={review.estate.accessMethod} />
          <KV k="Utilities active" v={review.estate.utilitiesActive === undefined ? undefined : review.estate.utilitiesActive ? 'Yes' : 'No'} />
          <KV k="Expected truckloads" v={review.estate.expectedTruckloads} />
          <KV k="Sorting required" v={review.estate.sortingRequired ? 'Yes' : review.estate.sortingRequired === false ? 'No' : undefined} />
          <KV k="Sorting instructions" v={review.estate.sortingInstructions} />
          <KV k="Cleaning requested" v={review.estate.cleaningRequested ? 'Yes' : undefined} />
          <KV k="Dumpster needed" v={review.estate.dumpsterNeeded ? 'Yes' : undefined} />
          <KV k="Multi-day / multi-crew" v={[review.estate.multipleDays && 'multi-day', review.estate.multipleCrews && 'multi-crew'].filter(Boolean).join(' · ') || undefined} />
          <KV k="Desired completion" v={review.estate.desiredCompletionDate} />
          <KV k="Deadline" v={review.estate.deadlineType && review.estate.deadlineType !== 'none' ? `${review.estate.deadlineType}${review.estate.deadlineDate ? ` · ${review.estate.deadlineDate}` : ''}` : undefined} />
          <KV k="Contact" v={[review.estate.contactName, review.estate.contactRole, review.estate.contactPhone, review.estate.contactEmail].filter(Boolean).join(' · ') || undefined} />
          {(review.dispositionCounts.keep + review.dispositionCounts.donate + review.dispositionCounts.recycle + review.dispositionCounts.sell + review.dispositionCounts.dispose) > 0 && (
            <div style={{ marginTop: 10 }}>
              <p style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 4 }}>Sorting</p>
              <div className="flex flex-wrap gap-1.5">
                {(['keep', 'donate', 'recycle', 'sell', 'dispose'] as const).map(d => review.dispositionCounts[d] > 0 && (
                  <span key={d} style={{ fontSize: 11, fontWeight: 700, color: '#a78bfa', border: '1px solid #a78bfa', borderRadius: 999, padding: '2px 9px' }}>{review.dispositionCounts[d]} {d}</span>
                ))}
              </div>
            </div>
          )}
        </Section>
      )}

      {/* ── Customer confirmation review (Part 12) ─────────────────────────── */}
      {review && review.hasConfirmation && (
        <Section title={`Customer Confirmation${review.final ? ` · v${review.final.confirmationVersion}` : ''}`}>
          <div className="flex flex-wrap gap-1.5" style={{ marginBottom: 10 }}>
            <CountBadge label="AI detected" n={review.counts.aiDetected} tone="#60a5fa" />
            <CountBadge label="Customer confirmed" n={review.counts.customerConfirmed} tone="#34d399" />
            <CountBadge label="Added" n={review.counts.customerAdded} tone="#fbbf24" />
            <CountBadge label="Removed" n={review.counts.removed} tone="#f87171" />
            <CountBadge label="Owner modified" n={review.counts.ownerModified} tone="#c084fc" />
            <CountBadge label="Uncertain" n={review.counts.uncertain} tone="#fbbf24" />
          </div>

          {review.items.length > 0 && (
            <div style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
              {review.items.map((it, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', borderRadius: 8, border: '1px solid var(--line)', background: it.removed ? 'rgba(248,113,113,.05)' : 'var(--card)', opacity: it.removed ? 0.65 : 1 }}>
                  <ProvBadge p={it.removed ? 'removed' : it.provenance} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)', textDecoration: it.removed ? 'line-through' : 'none' }}>{it.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 6 }}>{it.categoryLabel}</span>
                    {it.sensitive && <span style={{ fontSize: 9.5, fontWeight: 800, color: '#f87171', marginLeft: 6 }}>⚠ SENSITIVE</span>}
                    {it.disposition && <span style={{ fontSize: 9.5, fontWeight: 800, color: '#a78bfa', marginLeft: 6, textTransform: 'uppercase' }}>{it.disposition}</span>}
                    {it.changed && it.aiDetected && (it.aiName !== it.name || it.aiQuantity !== it.quantity) && (
                      <span style={{ fontSize: 10.5, color: 'var(--muted)', display: 'block' }}>AI read: {it.aiName ?? '—'}{it.aiQuantity != null ? ` ×${it.aiQuantity}` : ''}</span>
                    )}
                  </div>
                  {it.uncertain && <span style={{ fontSize: 10, fontWeight: 700, color: '#fbbf24' }}>unsure</span>}
                  <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)', minWidth: 26, textAlign: 'right' }}>×{it.quantity}</span>
                </div>
              ))}
            </div>
          )}

          <KV k="Is this everything?" v={review.isEverything} />
          {review.attestation && <KV k="Attestation" v={`${review.attestation.complete ? 'Complete' : 'Partial'} · v${review.attestation.version} · ${fmtTs(Date.parse(review.attestation.at))}`} />}

          {review.disclosures.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <p style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', marginBottom: 4 }}>Disclosures</p>
              {review.disclosures.map((d, i) => (
                <div key={i} className="flex justify-between gap-3" style={{ padding: '3px 0' }}>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{d.label}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: d.risk ? '#f87171' : 'var(--text)' }}>{d.value}</span>
                </div>
              ))}
            </div>
          )}

          {review.accessAnswers.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <p style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', marginBottom: 4 }}>Access answers</p>
              {review.accessAnswers.map((a, i) => <KV key={i} k={a.label} v={a.value} />)}
            </div>
          )}

          {review.photoQuality.length > 0 && review.photoQuality.map((q, i) => <KV key={`pq${i}`} k={q.label} v={q.value} />)}

          {review.conflicts.length > 0 && (
            <div style={{ marginTop: 10, padding: '9px 11px', borderRadius: 8, border: `1px solid ${review.conflictSeverity === 'material' ? '#f87171' : '#fbbf24'}`, background: review.conflictSeverity === 'material' ? 'rgba(248,113,113,.07)' : 'rgba(251,191,36,.06)' }}>
              <p style={{ fontSize: 11.5, fontWeight: 800, color: review.conflictSeverity === 'material' ? '#f87171' : '#fbbf24', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
                <AlertTriangle size={13} /> Photo/inventory flags ({review.conflictSeverity})
              </p>
              {review.conflicts.map((c, i) => <p key={i} style={{ fontSize: 12, color: 'var(--text)', marginTop: 2 }}>• {c.message}</p>)}
            </div>
          )}
        </Section>
      )}

      {/* ── Final (second) analysis — initial vs revised (Part 12) ──────────── */}
      {review?.final && (
        <Section title={`Final Analysis · ${review.final.tier} confidence`}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div style={{ padding: 10, borderRadius: 8, border: '1px solid var(--line)' }}>
              <p style={{ fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', color: 'var(--muted)' }}>Initial (photos only)</p>
              <p style={{ fontSize: 16, fontWeight: 900, color: 'var(--text)', marginTop: 3 }}>{review.initial ? `$${review.initial.lowUsd.toLocaleString()}–$${review.initial.highUsd.toLocaleString()}` : '—'}</p>
              {review.initial?.confidencePct != null && <p style={{ fontSize: 11, color: 'var(--muted)' }}>{review.initial.confidencePct}% · {review.initial.decision}</p>}
            </div>
            <div style={{ padding: 10, borderRadius: 8, border: '1px solid var(--red)', background: 'rgba(224,0,42,.05)' }}>
              <p style={{ fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', color: 'var(--red)' }}>Revised (confirmed)</p>
              <p style={{ fontSize: 16, fontWeight: 900, color: 'var(--text)', marginTop: 3 }}>${review.final.lowUsd.toLocaleString()}–${review.final.highUsd.toLocaleString()}</p>
              {review.final.confidencePct != null && <p style={{ fontSize: 11, color: 'var(--muted)' }}>{review.final.confidencePct}% · {review.final.finalDecision}</p>}
            </div>
          </div>
          <KV k="Recommended workflow" v={review.final.finalDecision} />
          <KV k="Truck loads" v={`${review.final.truckLoadMin}–${review.final.truckLoadMax}`} />
          <KV k="Labor" v={`${review.final.laborHours} hr · crew of ${review.final.crewSize}`} />
          <KV k="Disposal estimate" v={money(review.final.disposalUsd * 100)} />
          <KV k="Expected trips" v={review.final.expectedTrips} />
          <KV k="Special handling" v={review.final.specialHandling ? 'Yes' : 'No'} />
          <KV k="Pricing policy" v={review.final.policyVersion} />
          {review.final.evidenceSummary.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <p style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 4 }}>Evidence</p>
              {review.final.evidenceSummary.map((e, i) => <p key={i} style={{ fontSize: 12, color: 'var(--text)' }}>• {e}</p>)}
            </div>
          )}
          {review.final.missingInfo.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <p style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', color: '#fbbf24', marginBottom: 4 }}>Missing information</p>
              {review.final.missingInfo.map((e, i) => <p key={i} style={{ fontSize: 12, color: '#fcd34d' }}>• {e}</p>)}
            </div>
          )}
        </Section>
      )}

      {/* Server FINAL-analysis job (durable, persisted). */}
      {fj && (
        <Section title="Server Final-Analysis Job">
          <KV k="Status" v={fj.status} />
          <KV k="Confirmation phase" v={confStatus} />
          <KV k="Attempts" v={fj.attempts} />
          <KV k="Last attempt" v={fj.lastAttemptAt ? fmtTs(fj.lastAttemptAt) : undefined} />
          <KV k="Next retry" v={fj.nextRetryAt && (fj.status === 'queued' || fj.status === 'retrying') ? fmtTs(fj.nextRetryAt) : undefined} />
          <KV k="Error" v={fj.errorCode ? `${fj.errorCode}${fj.errorSummary ? ` — ${fj.errorSummary}` : ''}` : undefined} />
        </Section>
      )}

      {/* ── Guided-workflow owner actions (Part 12/13) ─────────────────────── */}
      {isOwner && (b.confirmation || confStatus === 'awaiting') && (
        <Section title="Guided Workflow Actions">
          <div className="flex flex-wrap gap-2">
            {b.confirmation && (
              <button onClick={() => run(fj?.status === 'failed' ? 'retry-final-ai' : 'run-final-ai')} disabled={busy === 'run-final-ai' || busy === 'retry-final-ai'} style={{ ...btn, borderColor: 'var(--red)', color: '#fff', background: 'var(--red)' }}>
                <RefreshCw size={13} /> {busy === 'run-final-ai' || busy === 'retry-final-ai' ? 'Running…' : fj?.status === 'failed' ? 'Retry Final Analysis' : 'Run Final Analysis'}
              </button>
            )}
            {review?.final && review.final.finalDecision !== 'manual_review' && review.final.finalDecision !== 'site_visit_required' && (
              <button onClick={() => run('approve-final', { send: true })} disabled={busy === 'approve-final'} style={{ ...btn, borderColor: '#34d399', color: '#34d399' }}>
                <CheckCircle2 size={13} /> {busy === 'approve-final' ? 'Approving…' : 'Approve & Send Quote'}
              </button>
            )}
            {b.confirmation && fj?.status !== 'manual_review' && (
              <button onClick={() => run('final-manual-review')} disabled={busy === 'final-manual-review'} style={btn}>Send to Manual Review</button>
            )}
            <button onClick={() => setShowInfoForm(s => !s)} style={btn}><MessageSquarePlus size={13} /> Request More Info</button>
          </div>

          {showInfoForm && (
            <div style={{ marginTop: 12, padding: 12, borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)' }}>
              <p style={{ fontSize: 12, fontWeight: 800, color: 'var(--text)', marginBottom: 8 }}>What do you need from the customer?</p>
              <div className="flex flex-wrap gap-1.5" style={{ marginBottom: 10 }}>
                {(Object.keys(INFO_REQUEST_FIELD_LABEL) as InfoRequestField[]).map(f => (
                  <button key={f} type="button" onClick={() => toggleInfoField(f)} style={{ ...btn, padding: '6px 10px', fontSize: 11.5, borderColor: infoFields.includes(f) ? 'var(--red)' : 'var(--line)', background: infoFields.includes(f) ? 'rgba(224,0,42,.1)' : 'var(--card)' }}>
                    {INFO_REQUEST_FIELD_LABEL[f]}
                  </button>
                ))}
              </div>
              <textarea value={infoReason} onChange={e => setInfoReason(e.target.value)} placeholder="Optional note to the customer…" rows={2}
                style={{ width: '100%', fontSize: 12.5, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg)', color: 'var(--text)', marginBottom: 8 }} />
              <button
                onClick={async () => { await run('request-info', { fields: infoFields, message: infoReason.trim() || undefined, reason: infoReason.trim() || undefined }); setShowInfoForm(false); setInfoFields([]); setInfoReason('') }}
                disabled={infoFields.length === 0 || busy === 'request-info'}
                style={{ ...btn, borderColor: 'var(--red)', color: '#fff', background: 'var(--red)', opacity: infoFields.length === 0 ? 0.5 : 1 }}>
                <Send size={13} /> {busy === 'request-info' ? 'Sending…' : 'Send Secure Link'}
              </button>
            </div>
          )}

          {b.infoRequest && (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
              <p style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>Info Request</p>
              <KV k="Requested" v={b.infoRequest.fields.map(f => INFO_REQUEST_FIELD_LABEL[f]).join(', ')} />
              <KV k="Sent" v={fmtTs(b.infoRequest.sentAt)} />
              <KV k="Delivery" v={b.infoRequest.channels ? [b.infoRequest.channels.sms && 'text', b.infoRequest.channels.email && 'email'].filter(Boolean).join(' + ') || 'not sent' : undefined} />
              <KV k="Customer viewed" v={b.infoRequest.viewedAt ? fmtTs(b.infoRequest.viewedAt) : 'not yet'} />
              <KV k="Customer responded" v={b.infoRequest.respondedAt ? fmtTs(b.infoRequest.respondedAt) : 'not yet'} />
              <KV k="Status" v={b.infoRequest.completed ? 'Completed' : 'Awaiting customer'} />
            </div>
          )}
        </Section>
      )}

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
