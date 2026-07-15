'use client'

import { useCallback, useEffect, useState } from 'react'
import type { Booking } from '../../lib/bookings'
import type { EventEnvelope } from '../../lib/platform/events/types'

// ── Governed intake workflow timeline (the "watch it progress" surface) ──────
//
// A per-booking stepper + live event stream. Step completion is derived from the
// booking itself (works even with the workflow flag off) and enriched by the
// durable event stream (GET /api/admin/events) which it polls while open.

type StepDef = { key: string; label: string; done: (b: Booking, ev: Set<string>) => boolean; show?: (b: Booking, ev: Set<string>) => boolean }

const STEPS: StepDef[] = [
  { key: 'photos', label: 'Photos uploaded', done: (b, ev) => (b.invoicePhotos?.length ?? 0) > 0 || ev.has('LeadCreated') },
  // "AI analysis" resolves on an attached estimate OR once the owner has taken it over
  // (manual review) or already priced/sent a quote — so it never hangs "in progress"
  // forever after the owner handles it by hand.
  { key: 'analysis', label: 'AI analysis', done: (b, ev) => !!b.aiEstimate || ev.has('AIActionDrafted') || b.aiJob?.status === 'manual_review' || (b.invoiceAmountCents ?? 0) > 0 || ev.has('QuoteSent') },
  { key: 'pricing', label: 'Pricing', done: (b, ev) => !!b.aiEstimate?.pricing || ev.has('QuoteGenerated') },
  {
    key: 'approval', label: 'Owner approval',
    show: (b, ev) => b.aiEstimate?.decision === 'manual_review' || ev.has('AIActionApprovalRequested'),
    done: (b, ev) => ev.has('AIActionApproved') || ev.has('QuoteSent') || ((b.invoiceAmountCents ?? 0) > 0),
  },
  { key: 'quote', label: 'Quote sent', done: (b, ev) => (b.invoiceAmountCents ?? 0) > 0 || ev.has('QuoteSent') },
  { key: 'accepted', label: 'Accepted', done: (b, ev) => ev.has('QuoteAccepted') || (b.amountPaidCents ?? 0) > 0 },
  { key: 'deposit', label: 'Deposit / payment', done: (b, ev) => (b.amountPaidCents ?? 0) > 0 || ev.has('DepositPaid') || ev.has('PaymentReceived') },
  { key: 'confirmed', label: 'Confirmed', done: (b) => ['confirmed', 'in_progress', 'continued', 'completed'].includes(b.status) },
]

const EVENT_LABEL: Record<string, string> = {
  LeadCreated: 'Lead created', QuoteRequested: 'Quote requested', QuoteGenerated: 'AI quote generated',
  AIActionDrafted: 'AI drafted quote', AIActionApprovalRequested: 'Approval requested',
  AIActionApproved: 'Approved by owner', AIActionRejected: 'Rejected by owner',
  QuoteSent: 'Quote sent', QuoteViewed: 'Quote viewed', QuoteAccepted: 'Quote accepted',
  DepositPaid: 'Deposit paid', PaymentReceived: 'Payment received', BookingCreated: 'Booking created',
}

function relTime(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

type PendingApproval = {
  id: string; status: string; riskClass: string; actionPreview: string; explanation: string
  rollbackMetadata?: { bookingToken?: string }
}

export default function WorkflowTimeline({ booking }: { booking: Booking }) {
  const [events, setEvents] = useState<EventEnvelope[]>([])
  const [approval, setApproval] = useState<PendingApproval | null>(null)
  const [acting, setActing] = useState(false)
  const [actMsg, setActMsg] = useState('')
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    try {
      const [er, ar] = await Promise.all([
        fetch(`/api/admin/events?entityId=${encodeURIComponent(booking.token)}`, { credentials: 'same-origin' }),
        fetch('/api/admin/approvals?status=pending', { credentials: 'same-origin' }),
      ])
      if (er.ok) setEvents(((await er.json()) as { events?: EventEnvelope[] }).events ?? [])
      if (ar.ok) {
        const items = ((await ar.json()) as { items?: PendingApproval[] }).items ?? []
        setApproval(items.find((a) => a.rollbackMetadata?.bookingToken === booking.token) ?? null)
      }
    } catch { /* best-effort */ } finally { setLoaded(true) }
  }, [booking.token])

  const decide = useCallback(async (decision: 'approve' | 'reject') => {
    if (!approval || acting) return // guard against duplicate/repeat actions
    let reason: string | undefined
    if (decision === 'reject') {
      reason = (window.prompt('Reason for rejecting this AI quote (required — the job will need manual quoting):') || '').trim()
      if (!reason) return // an owner note is required to reject
    }
    setActing(true); setActMsg('')
    try {
      const r = await fetch('/api/admin/approvals', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId: approval.id, decision, reason }),
      })
      if (r.ok) { setActMsg(decision === 'approve' ? 'Approved — quote sent.' : 'Rejected — needs manual quoting.'); await load() }
      else { const e = await r.json().catch(() => ({})); setActMsg(e.error || 'Action failed') }
    } catch { setActMsg('Action failed') } finally { setActing(false) }
  }, [approval, acting, load])

  useEffect(() => {
    load()
    const t = setInterval(load, 12000) // light polling — no SSE infra to reuse
    return () => clearInterval(t)
  }, [load])

  const ev = new Set(events.map((e) => e.eventType))
  const steps = STEPS.filter((s) => !s.show || s.show(booking, ev)).map((s) => ({ ...s, isDone: s.done(booking, ev) }))
  const currentIdx = steps.findIndex((s) => !s.isDone)

  return (
    <div className="glass-card p-5 mb-4" style={{ borderRadius: '16px' }}>
      <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)' }}>Workflow</p>

      <div className="flex flex-col gap-2.5">
        {steps.map((s, i) => {
          const state = s.isDone ? 'done' : i === currentIdx ? 'current' : 'pending'
          const dot = state === 'done' ? 'var(--red)' : state === 'current' ? 'transparent' : 'rgba(255,255,255,.08)'
          return (
            <div key={s.key} className="flex items-center gap-3" style={{ opacity: state === 'pending' ? 0.5 : 1 }}>
              <span aria-hidden style={{
                width: 18, height: 18, borderRadius: 999, flexShrink: 0, display: 'grid', placeItems: 'center',
                background: dot, border: state === 'current' ? '2px solid var(--red)' : '1px solid var(--line)',
                color: '#fff', fontSize: 11, fontWeight: 800,
              }}>{state === 'done' ? '✓' : ''}</span>
              <span style={{ fontSize: 14, fontWeight: state === 'current' ? 700 : 500 }}>{s.label}</span>
              {state === 'current' && <span style={{ fontSize: 11, color: 'var(--muted)' }}>· in progress</span>}
            </div>
          )
        })}
      </div>

      {approval && (
        <div className="mt-4 p-3" style={{ borderRadius: 12, border: '1px solid var(--red)', background: 'rgba(224,0,42,.06)' }}>
          <p style={{ fontSize: 13, fontWeight: 700 }}>Awaiting owner approval · {approval.riskClass} risk</p>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{approval.actionPreview}</p>
          {approval.explanation && <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>Why: {approval.explanation}</p>}
          <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>To modify the price / truck-load / labor before sending, use the AI estimate panel above, then approve.</p>
          <div className="flex gap-2 mt-2">
            <button onClick={() => decide('approve')} disabled={acting} className="btn os-tap" style={{ height: 36, borderRadius: 10, flex: 1, justifyContent: 'center' }}>Approve &amp; send</button>
            <button onClick={() => decide('reject')} disabled={acting} className="btn-ghost os-tap" style={{ height: 36, borderRadius: 10, color: '#fca5a5' }}>Reject</button>
          </div>
        </div>
      )}
      {actMsg && <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>{actMsg}</p>}

      <div className="mt-4 pt-3" style={{ borderTop: '1px solid var(--line)' }}>
        {events.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {events.slice(0, 12).map((e) => (
              <div key={e.eventId} className="flex items-center gap-2" style={{ fontSize: 12.5 }}>
                <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--red)', flexShrink: 0 }} />
                <span style={{ fontWeight: 600 }}>{EVENT_LABEL[e.eventType] ?? e.eventType}</span>
                <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 11 }}>{relTime(e.occurredAt)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ fontSize: 12, color: 'var(--muted)' }}>
            {loaded ? 'No workflow events recorded yet for this booking.' : 'Loading workflow…'}
          </p>
        )}
      </div>
    </div>
  )
}
