'use client'

// ── Compact booking AI Card ──────────────────────────────────────────────────
// Booking pages get a GLANCE, not the platform: status, V1, V2, ground truth, one primary
// action, and a link into the AI Command Center. The full run/retry/rerun/cost workflow lives
// in the Command Center — a booking page should never carry it. Reuses the existing owner-gated
// GET /api/admin/shadow-run/[bookingId] (zero AI). Owner-only; the API is the real gate.

import { useEffect, useState } from 'react'
import Link from 'next/link'

const STATUS_COLOR: Record<string, string> = {
  not_selected: '#94a3b8', selected: '#93c5fd', queued: '#93c5fd', processing: '#fbbf24',
  completed: '#34d399', failed: '#f87171', retry_blocked: '#fb923c', budget_blocked: '#fbbf24',
  kill_switch: '#f87171', awaiting_ground_truth: '#a3e635',
}
const usd = (n?: number | null) => (typeof n === 'number' ? `$${Math.round(n)}` : '—')

type View = { status: string; label: string; canRun: boolean; canRetry: boolean; canRerun: boolean; canOpen: boolean }
type Payload = {
  enabled: boolean; bookingId?: string; view?: View
  job?: { comparison?: { authoritativeRecommendedUsd?: number; shadowRecommendedUsd?: number }; groundTruth?: { actualQuoteUsd?: number; actualFinalUsd?: number } } | null
}

export default function BookingAICard({ bookingId }: { bookingId: string }) {
  const [data, setData] = useState<Payload | null>(null)
  const [busy, setBusy] = useState('')

  const load = () => fetch(`/api/admin/shadow-run/${bookingId}`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null)).then(setData).catch(() => {})
  useEffect(() => { load() }, [bookingId]) // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (action: string) => {
    setBusy(action)
    try {
      const r = await fetch(`/api/admin/shadow-run/${bookingId}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
      })
      if (r.ok) setData(await r.json())
    } finally { setBusy('') }
  }

  if (data && !data.enabled) return null
  if (!data?.view) return <div style={box} />

  const v = data.view
  const c = STATUS_COLOR[v.status] ?? 'var(--muted)'
  const comp = data.job?.comparison
  const gt = data.job?.groundTruth?.actualQuoteUsd ?? data.job?.groundTruth?.actualFinalUsd

  // Exactly one primary action, chosen by state. Everything else lives in the Command Center.
  const primary = v.canRun ? { label: 'Run V2 shadow', action: 'run' }
    : v.canRetry ? { label: 'Retry', action: 'retry' }
    : v.status === 'awaiting_ground_truth' ? { label: 'Record ground truth', href: `/admin/operations/ai/eval/${bookingId}` }
    : v.canOpen ? { label: 'Open comparison', href: `/admin/operations/ai/eval/${bookingId}` }
    : null

  return (
    <div style={box}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)' }}>V2 Shadow</span>
        <span style={{ fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 6, color: c, background: `color-mix(in srgb, ${c} 15%, transparent)`, border: `1px solid color-mix(in srgb, ${c} 35%, transparent)` }}>{v.label}</span>
        <Link href={`/admin/operations/ai/eval/${bookingId}`} style={{ marginLeft: 'auto', fontSize: 11.5, color: '#93c5fd', textDecoration: 'none' }}>Open in AI Command Center →</Link>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 10 }}>
        <Cell label="V1 (customer)" value={usd(comp?.authoritativeRecommendedUsd)} />
        <Cell label="V2 (shadow)" value={usd(comp?.shadowRecommendedUsd)} />
        <Cell label="Ground truth" value={usd(gt)} />
      </div>

      {primary && (
        <div style={{ marginTop: 10 }}>
          {'href' in primary
            ? <Link href={primary.href!} style={btn}>{primary.label}</Link>
            : <button disabled={!!busy} onClick={() => act(primary.action!)} style={btn}>{busy ? '…' : primary.label}</button>}
        </div>
      )}
      <p style={{ fontSize: 10.5, color: 'var(--muted)', margin: '8px 0 0' }}>V1 is the customer-facing estimate; V2 never changes a customer quote.</p>
    </div>
  )
}

const box: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: 13, minHeight: 60 }
const btn: React.CSSProperties = { display: 'inline-block', fontSize: 12, fontWeight: 700, padding: '7px 13px', borderRadius: 9, cursor: 'pointer', border: '1px solid var(--line)', background: 'color-mix(in srgb, var(--text) 6%, transparent)', color: 'var(--text)', textDecoration: 'none' }

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700 }}>{value}</div>
    </div>
  )
}
