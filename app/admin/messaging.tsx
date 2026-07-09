'use client'

// Shared admin messaging primitives — used by BOTH /admin/inbox and the booking
// detail page so the conversation looks identical everywhere. Pure presentation +
// data helpers; no network calls live here.

import type { CSSProperties } from 'react'
import { COMPANY } from '../lib/company'

// A superset message shape covering everything the inbox + booking thread render.
export type ThreadMessage = {
  id: string
  direction: 'inbound' | 'outbound'
  channel: string // 'sms' | 'email' | 'note' | 'system'
  from?: string
  to?: string
  subject?: string
  body: string
  customerName?: string
  customerPhone?: string
  customerEmail?: string
  bookingToken?: string
  bookingNumber?: string
  status?: string
  unread?: boolean
  reviewState?: string
  tags?: string[]
  createdAt: number
}

// ── time / format helpers ─────────────────────────────────────────────────────

export function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export const REVIEW_LABEL: Record<string, string> = {
  needs_reply: 'Needs Reply',
  customer_responded: 'Customer Responded',
  waiting_on_customer: 'Waiting on Customer',
  resolved: 'Resolved',
}

export function channelLabel(c: string): string {
  return c === 'sms' ? 'SMS' : c === 'email' ? 'Email' : c === 'note' ? 'Note' : c === 'system' ? 'System' : c
}

// ── small pill components ─────────────────────────────────────────────────────

const pillBase: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 800,
  padding: '2px 7px', borderRadius: 999, lineHeight: 1.4, whiteSpace: 'nowrap', letterSpacing: '.01em',
}

export function ChannelPill({ channel }: { channel: string }) {
  const sms = channel === 'sms'
  return (
    <span style={{ ...pillBase, background: sms ? 'rgba(52,211,153,.14)' : 'rgba(96,165,250,.14)', color: sms ? '#6ee7b7' : '#93c5fd' }}>
      {sms ? '💬' : '✉️'} {channelLabel(channel)}
    </span>
  )
}

// Booking-status badge with color coding consistent with the rest of admin.
const STATUS_TONE: Record<string, { bg: string; fg: string }> = {
  confirmed: { bg: 'rgba(52,211,153,.14)', fg: '#6ee7b7' },
  time_verified: { bg: 'rgba(52,211,153,.14)', fg: '#6ee7b7' },
  completed: { bg: 'rgba(96,165,250,.14)', fg: '#93c5fd' },
  in_progress: { bg: 'rgba(251,191,36,.14)', fg: '#fcd34d' },
  continued: { bg: 'rgba(251,191,36,.14)', fg: '#fcd34d' },
  payment_received: { bg: 'rgba(52,211,153,.12)', fg: '#6ee7b7' },
  cancelled: { bg: 'rgba(248,113,113,.14)', fg: '#fca5a5' },
  could_not_complete: { bg: 'rgba(248,113,113,.14)', fg: '#fca5a5' },
  partially_completed: { bg: 'rgba(251,191,36,.14)', fg: '#fcd34d' },
  refunded: { bg: 'rgba(248,113,113,.12)', fg: '#fca5a5' },
}

export function StatusPill({ status, label }: { status?: string; label?: string }) {
  if (!status) return null
  const tone = STATUS_TONE[status] ?? { bg: 'rgba(255,255,255,.07)', fg: 'var(--muted)' }
  return <span style={{ ...pillBase, background: tone.bg, color: tone.fg }}>{label ?? status.replace(/_/g, ' ')}</span>
}

export function UnmatchedPill() {
  return <span style={{ ...pillBase, background: 'rgba(251,191,36,.14)', color: '#fcd34d' }}>⚠ Unmatched</span>
}

// ── conversation thread (the shared bubble timeline) ──────────────────────────

export function ConversationThread({
  messages, customerName, onMarkRead, emptyHint,
}: {
  messages: ThreadMessage[]
  customerName?: string
  onMarkRead?: (id: string) => void
  emptyHint?: string
}) {
  if (!messages.length) {
    return (
      <div className="text-center py-10 px-4">
        <div style={{ fontSize: 26, marginBottom: 8, opacity: .5 }}>💬</div>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>{emptyHint ?? 'No messages yet.'}</p>
      </div>
    )
  }
  return (
    <div className="space-y-2.5">
      {messages.map(m => {
        if (m.channel === 'note' || m.channel === 'system') {
          return (
            <div key={m.id} className="flex justify-center">
              <div style={{ maxWidth: '90%', padding: '6px 12px', borderRadius: 10, background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.07)' }}>
                <p className="text-xs" style={{ color: 'var(--muted)', whiteSpace: 'pre-wrap' }}>
                  <span style={{ fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em', fontSize: 9.5 }}>
                    {m.channel === 'note' ? '📝 Internal note' : 'System'}
                  </span>{' · '}{fmtDateTime(m.createdAt)}
                </p>
                <p className="text-sm mt-0.5" style={{ color: '#d1d5db', whiteSpace: 'pre-wrap' }}>{m.body}</p>
              </div>
            </div>
          )
        }
        const inbound = m.direction === 'inbound'
        const failed = m.status === 'failed'
        return (
          <div key={m.id} style={{ display: 'flex', justifyContent: inbound ? 'flex-start' : 'flex-end' }}>
            <div style={{
              maxWidth: '85%', padding: '9px 13px', borderRadius: 14,
              borderTopLeftRadius: inbound ? 4 : 14, borderTopRightRadius: inbound ? 14 : 4,
              background: inbound ? 'rgba(255,255,255,.06)' : 'rgba(224,0,42,.13)',
              border: `1px solid ${inbound ? 'rgba(255,255,255,.08)' : 'rgba(224,0,42,.22)'}`,
              borderLeft: m.unread ? '3px solid var(--red)' : undefined,
            }}>
              <div className="flex items-center gap-1.5 flex-wrap" style={{ marginBottom: 3 }}>
                <span className="text-xs font-bold" style={{ color: inbound ? '#e5e7eb' : '#fff' }}>
                  {inbound ? (customerName || m.customerName || 'Customer') : COMPANY.shortNameUpper}
                </span>
                <ChannelPill channel={m.channel} />
                {m.tags?.includes('opt-out') && <span style={{ ...pillBase, background: 'rgba(251,191,36,.16)', color: '#fcd34d' }}>OPT-OUT</span>}
              </div>
              {m.subject && <p className="text-sm font-bold text-white" style={{ marginBottom: 2 }}>{m.subject}</p>}
              <p className="text-sm" style={{ color: '#e5e7eb', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.body}</p>
              <div className="flex items-center gap-2 flex-wrap" style={{ marginTop: 4 }}>
                <span className="text-xs" style={{ color: 'var(--muted)', fontSize: 10.5 }}>{fmtDateTime(m.createdAt)}</span>
                {!inbound && m.status && (
                  <span className="text-xs" style={{ fontSize: 10.5, color: failed ? '#fca5a5' : 'var(--muted)' }}>
                    · {failed ? 'failed' : m.status}
                  </span>
                )}
                {inbound && m.unread && onMarkRead && (
                  <button onClick={() => onMarkRead(m.id)} className="text-xs font-semibold" style={{ color: 'var(--red)', fontSize: 10.5 }}>Mark read</button>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── editable message templates (used in the reply composer) ───────────────────

export type TemplateCtx = { firstName?: string; bookingNumber?: string; service?: string }

function name(c: TemplateCtx) { return (c.firstName || 'there').trim() }
function ref(c: TemplateCtx) { return c.bookingNumber ? ` (${c.bookingNumber})` : '' }

export const MESSAGE_TEMPLATES: { key: string; label: string; build: (c: TemplateCtx) => string }[] = [
  { key: 'booking_confirmation', label: 'Booking confirmation', build: c =>
    `Hi ${name(c)}, this is ${COMPANY.legalNameUpper} confirming your booking${ref(c)}. We've got you scheduled and will follow up with any details. Reply here with questions anytime — thank you!` },
  { key: 'running_late', label: 'Running late', build: c =>
    `Hi ${name(c)}, this is ${COMPANY.legalNameUpper}. We're running a little behind schedule and wanted to keep you posted — we'll be there as soon as we can. Thank you for your patience!` },
  { key: 'need_photos', label: 'Need more photos', build: c =>
    `Hi ${name(c)}, this is ${COMPANY.legalNameUpper}. To finalize your quote${ref(c)}, could you text a couple of photos of the items/area? That helps us price it accurately. Thank you!` },
  { key: 'updated_quote', label: 'Updated quote', build: c =>
    `Hi ${name(c)}, this is ${COMPANY.legalNameUpper}. We've updated your quote${ref(c)} based on the details. Let us know if you'd like to move forward and we'll lock in a time. Thanks!` },
  { key: 'payment_reminder', label: 'Payment reminder', build: c =>
    `Hi ${name(c)}, this is ${COMPANY.legalNameUpper} — a friendly reminder that there's a balance due on your job${ref(c)}. You can pay securely from your booking page, or reply here if you have any questions. Thank you!` },
  { key: 'zelle_verify', label: 'Manual/Zelle payment verification', build: c =>
    `Hi ${name(c)}, this is ${COMPANY.legalNameUpper} confirming we received your payment${ref(c)}. Thank you so much — you're all set! Let us know if you need a receipt.` },
  { key: 'partially_completed', label: 'Partially completed job', build: c =>
    `Hi ${name(c)}, this is ${COMPANY.legalNameUpper}. We completed part of your job${ref(c)} today and will return to finish the remaining work. We'll confirm the return date with you shortly. Thank you for your patience!` },
  { key: 'could_not_complete', label: 'Could not complete job', build: c =>
    `Hi ${name(c)}, this is ${COMPANY.legalNameUpper}. I apologize, but due to unforeseen scheduling issues we won't be able to return this week to complete the remaining work. Because the job won't be completed, there will be no remaining balance due — your deposit is applied toward the work already done and disposal costs. I'm sorry for the inconvenience and appreciate your understanding.` },
  { key: 'reschedule', label: 'Reschedule request', build: c =>
    `Hi ${name(c)}, this is ${COMPANY.legalNameUpper}. We need to reschedule your job${ref(c)}. What day works best for you this week? Reply here and we'll get you back on the calendar. Thank you!` },
  { key: 'review_request', label: 'Review request', build: c =>
    `Hi ${name(c)}, thank you for choosing ${COMPANY.legalNameUpper}! If you have a moment, we'd really appreciate a quick review — it helps our small business a lot. Thank you!` },
]
