'use client'

// ── AI Command Center — Evaluation Queue (canonical) ─────────────────────────
// The owner's action-oriented workspace: one prioritized list answering "what needs me now,
// what to review next, why is this here, what finishes it". Reads /api/admin/ai-queue (pure,
// ZERO AI) and acts through the existing owner-gated shadow-run route. "Review next →" jumps to
// the highest-priority actionable item. No "run all"; one dominant action per row.

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import OperationsShell from '../../OperationsShell'
import AICommandShell, { aiCard, aiLabel, AISkeleton, AIError, AIEmpty } from '../AICommandShell'
import ShadowKillSwitch from '../ShadowKillSwitch'

const TIER_COLOR: Record<string, string> = {
  needs_intervention: '#f87171', awaiting_review: '#fbbf24', missing_ground_truth: '#a3e635',
  uncategorized: '#93c5fd', ready_to_run: '#34d399', in_flight: '#94a3b8', informational: '#64748b',
}
const usd = (n?: number | null) => (typeof n === 'number' ? `$${Math.round(n)}` : '—')
const age = (ms: number) => { const m = Math.round(ms / 60000); if (m < 60) return `${m}m`; const h = Math.round(m / 60); return h < 48 ? `${h}h` : `${Math.round(h / 24)}d` }

type Action = { kind: string; label: string }
type Row = {
  bookingId: string; bookingNumber?: string; label?: string; status: string
  v1Usd: number | null; v2Usd: number | null; groundTruthUsd: number | null; variancePctV2: number | null; winner: string | null
  ageMs: number; derived: { tier: string; reason: string; action: Action; actionable: boolean }
}
type Counts = Record<string, number>
type Payload = { enabled: boolean; total?: number; matched?: number; counts?: Counts; actionableCount?: number; nextActionableId?: string | null; tier?: string | null; rows?: Row[] }

const TIER_TABS = [
  { k: '', label: 'All' },
  { k: 'needs_intervention', label: 'Intervention' },
  { k: 'awaiting_review', label: 'Review' },
  { k: 'missing_ground_truth', label: 'Ground truth' },
  { k: 'uncategorized', label: 'Categorize' },
  { k: 'ready_to_run', label: 'Run' },
]

export default function QueuePage() {
  return <Suspense fallback={null}><OperationsShell><AICommandShell section="queue" title="Evaluation Queue"><Queue /></AICommandShell></OperationsShell></Suspense>
}

function Queue() {
  const router = useRouter()
  const sp = useSearchParams()
  const [tier, setTier] = useState(sp.get('tier') ?? '')
  const [res, setRes] = useState<{ key: string; payload: Payload | null; err: string } | null>(null)
  const [busy, setBusy] = useState('')

  const key = tier
  const load = useCallback((signal?: AbortSignal) => {
    const done = (payload: Payload | null, err: string) => setRes({ key, payload, err })
    return fetch(`/api/admin/ai-queue${tier ? `?tier=${tier}` : ''}`, { credentials: 'same-origin', signal })
      .then(async (r) => { if (r.status === 401 || r.status === 403) return done(null, 'Owner access required.'); done(await r.json(), '') })
      .catch((e) => { if ((e as { name?: string })?.name !== 'AbortError') done(null, 'Could not load the queue.') })
  }, [tier, key])
  useEffect(() => { const c = new AbortController(); load(c.signal); return () => c.abort() }, [load])

  // A row's dominant action. run/retry/select POST to shadow-run; the rest open the eval detail.
  const act = async (row: Row) => {
    const k = row.derived.action.kind
    if (k === 'run' || k === 'retry' || k === 'select') {
      setBusy(row.bookingId)
      try {
        await fetch(`/api/admin/shadow-run/${row.bookingId}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: k }) })
        await load()
      } finally { setBusy('') }
    } else {
      router.push(`/admin/operations/ai/eval/${row.bookingId}?from=queue${tier ? `&tier=${tier}` : ''}`)
    }
  }

  const loading = res?.key !== key
  const data = res?.payload ?? null
  const err = res?.err ?? ''

  if (err) return <AIError message={err} onRetry={() => load()} />
  if (!res || loading) return <AISkeleton rows={5} />
  if (data && !data.enabled) return <AIEmpty title="AI evaluation is off" detail="Enable SHADOW_ANALYTICS_ENABLED to populate the queue." />
  const rows = data?.rows ?? []
  const nextId = data?.nextActionableId

  return (
    <>
      <ShadowKillSwitch />
      {/* Attention header + guided entry point */}
      <div style={{ ...aiCard, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14 }}>
        <div style={{ flex: '1 1 200px' }}>
          <span style={aiLabel}>Needs your attention</span>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            {(data?.actionableCount ?? 0) === 0 ? 'Nothing waiting — the queue is clear.' : `${data?.actionableCount} item(s) need an action.`}
          </div>
        </div>
        {nextId && (
          <Link href={`/admin/operations/ai/eval/${nextId}?from=queue${tier ? `&tier=${tier}` : ''}`}
            style={{ fontSize: 13, fontWeight: 700, padding: '10px 16px', borderRadius: 11, border: '1px solid var(--line)', textDecoration: 'none', color: 'var(--text)', background: 'color-mix(in srgb, var(--text) 7%, transparent)' }}>
            Review next →
          </Link>
        )}
      </div>

      {/* Tier filter */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {TIER_TABS.map((t) => {
          const n = t.k ? (data?.counts?.[t.k] ?? 0) : (data?.total ?? 0)
          const on = tier === t.k
          return (
            <button key={t.k || 'all'} onClick={() => setTier(t.k)}
              style={{ fontSize: 12, fontWeight: 700, padding: '6px 12px', borderRadius: 999, cursor: 'pointer', border: `1px solid ${on ? 'var(--text)' : 'var(--line)'}`, background: on ? 'var(--text)' : 'transparent', color: on ? 'var(--card)' : 'var(--muted)' }}>
              {t.label} {n > 0 && <span style={{ opacity: on ? 0.8 : 1 }}>{n}</span>}
            </button>
          )
        })}
      </div>

      {rows.length === 0
        ? <AIEmpty title={tier ? 'Nothing in this tier' : 'Queue is clear'} detail={tier ? 'Try another tier or clear the filter.' : 'No bookings currently need shadow evaluation or review.'} />
        : <div style={{ display: 'grid', gap: 8 }}>{rows.map((r) => <QueueRow key={r.bookingId} r={r} onAct={() => act(r)} busy={busy === r.bookingId} highlight={r.bookingId === nextId} />)}</div>}
    </>
  )
}

function QueueRow({ r, onAct, busy, highlight }: { r: Row; onAct: () => void; busy: boolean; highlight: boolean }) {
  const c = TIER_COLOR[r.derived.tier] ?? 'var(--muted)'
  const variance = r.groundTruthUsd != null && r.v2Usd != null ? `${r.variancePctV2 ?? '—'}%` : null
  return (
    <div style={{ ...aiCard, padding: 14, borderLeft: `3px solid ${c}`, ...(highlight ? { boxShadow: `0 0 0 1px ${c}55` } : {}) }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <span style={{ fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 6, color: c, background: `color-mix(in srgb, ${c} 15%, transparent)`, border: `1px solid color-mix(in srgb, ${c} 35%, transparent)` }}>{r.derived.tier.replace(/_/g, ' ')}</span>
        <Link href={`/admin/operations/ai/eval/${r.bookingId}`} style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)', textDecoration: 'none' }}>{r.bookingNumber ?? r.bookingId.slice(0, 10)}</Link>
        {r.label && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{r.label.replace(/_/g, ' ')}</span>}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)' }}>{age(r.ageMs)} old</span>
      </div>

      <p style={{ margin: '7px 0', fontSize: 12.5, color: 'var(--text)', lineHeight: 1.45 }}>{r.derived.reason}</p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 14, fontSize: 11.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
          {r.v1Usd != null && <span>V1 <strong style={{ color: 'var(--text)' }}>{usd(r.v1Usd)}</strong></span>}
          {r.v2Usd != null && <span>V2 <strong style={{ color: 'var(--text)' }}>{usd(r.v2Usd)}</strong></span>}
          {r.groundTruthUsd != null && <span>Actual <strong style={{ color: 'var(--text)' }}>{usd(r.groundTruthUsd)}</strong></span>}
          {variance && <span>V2 error <strong style={{ color: 'var(--text)' }}>{variance}</strong></span>}
          {r.winner && <span>Winner <strong style={{ color: r.winner === 'v2' ? '#34d399' : r.winner === 'v1' ? '#f87171' : '#94a3b8' }}>{r.winner.toUpperCase()}</strong></span>}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {r.derived.action.kind !== 'none' && (
            <button disabled={busy} onClick={onAct}
              style={{ fontSize: 12, fontWeight: 700, padding: '7px 14px', borderRadius: 9, cursor: 'pointer', border: `1px solid ${c}55`, background: `color-mix(in srgb, ${c} 12%, transparent)`, color: 'var(--text)' }}>
              {busy ? '…' : r.derived.action.label}
            </button>
          )}
          <Link href={`/admin/operations/book-now/${r.bookingId}`} style={{ fontSize: 11.5, color: 'var(--muted)', textDecoration: 'none', alignSelf: 'center' }}>Booking</Link>
        </div>
      </div>
    </div>
  )
}
