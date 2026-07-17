'use client'

// ── Owner Select / Run / Retry / Rerun controls for one booking ──────────────
// Self-contained: fetches its own status from GET /api/admin/shadow-run/[bookingId] and posts
// actions back to the same route. Owner-gated server-side (the parent also hides it from
// non-owners). Renders the full status vocabulary and a cost preview before any run. It never
// mutates the customer-facing quote — the API guarantees that; this is only its UI.
//
// Reused on the booking-detail page and inside the Shadow Analytics eligible-jobs view.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

const box: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: 12 }
const btn = (accent?: string): React.CSSProperties => ({ fontSize: 12, fontWeight: 700, padding: '6px 11px', borderRadius: 8, cursor: 'pointer', border: `1px solid ${accent ?? 'var(--line)'}`, background: 'transparent', color: accent ?? 'var(--text)' })
const usd = (n?: number | null) => (typeof n === 'number' ? `$${n.toFixed(n % 1 ? 2 : 0)}` : '—')

const STATUS_COLOR: Record<string, string> = {
  not_selected: '#94a3b8', selected: '#93c5fd', queued: '#93c5fd', processing: '#fbbf24',
  completed: '#34d399', failed: '#f87171', retry_blocked: '#fb923c', budget_blocked: '#fbbf24',
  kill_switch: '#f87171', awaiting_ground_truth: '#a3e635',
}

type View = {
  status: string; label: string; detail: string
  canSelect: boolean; canUnselect: boolean; canRun: boolean; canRetry: boolean; canRerun: boolean; canOpen: boolean
}
type Budget = { killed: boolean; maxEvalsPerDay: number; maxEvalsPerBooking: number; maxEstDailyCostUsd: number; maxAttempts: number }
type Spend = { evalsToday: number; costTodayUsd: number; attemptsForBooking: number }
type Payload = {
  enabled: boolean; bookingId?: string; bookingNumber?: string; view?: View
  selected?: boolean; eligible?: boolean; eligibilityReason?: string; imageCount?: number
  budget?: Budget; spend?: Spend; reusableResult?: boolean; blocked?: string
  job?: { status?: string; priorRuns?: unknown[] } | null
}

export default function ShadowRunControls({ bookingId, compact = false }: { bookingId: string; compact?: boolean }) {
  const [data, setData] = useState<Payload | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [confirmRun, setConfirmRun] = useState<'run' | 'rerun' | null>(null)

  const load = useCallback(async () => {
    setErr('')
    try {
      const res = await fetch(`/api/admin/shadow-run/${bookingId}`, { credentials: 'same-origin' })
      if (res.status === 401 || res.status === 403) { setErr('Owner access required.'); return }
      if (res.status === 404) { setErr('Booking not found.'); return }
      setData(await res.json())
    } catch { setErr('Could not load shadow status.') }
  }, [bookingId])
  useEffect(() => { load() }, [load])

  const act = useCallback(async (action: string) => {
    setBusy(action); setErr(''); setConfirmRun(null)
    try {
      const res = await fetch(`/api/admin/shadow-run/${bookingId}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(j.error ?? 'Action failed.'); return }
      setData(j)   // the POST returns the fresh status payload — no extra round-trip
    } catch { setErr('Action failed.') } finally { setBusy('') }
  }, [bookingId])

  if (data && !data.enabled) return null   // analytics off → nothing to show
  if (err && !data) return <div style={{ ...box, borderColor: '#f87171', color: '#f87171', fontSize: 12 }}>{err}</div>
  if (!data?.view) return <div style={{ ...box, fontSize: 12, color: 'var(--muted)' }}>Loading shadow status…</div>

  const v = data.view
  const budget = data.budget
  const spend = data.spend
  const color = STATUS_COLOR[v.status] ?? 'var(--muted)'
  const remainingEvals = budget && spend ? Math.max(0, budget.maxEvalsPerDay - spend.evalsToday) : undefined
  const remainingCost = budget && spend ? Math.max(0, budget.maxEstDailyCostUsd - spend.costTodayUsd) : undefined

  return (
    <div style={{ ...box, display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)' }}>V2 Shadow (owner-only)</span>
        <span style={{ fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 6, color, background: `color-mix(in srgb, ${color} 15%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 35%, transparent)` }}>
          {v.label}
        </span>
        <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>V1 stays customer-facing</span>
      </div>

      {v.detail && <p style={{ margin: 0, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.4 }}>{v.detail}</p>}
      {data.blocked && <p style={{ margin: 0, fontSize: 11.5, color: '#fbbf24' }}>Blocked before inference: {data.blocked.replace('budget_', '').replace(/_/g, ' ')} — no AI was called.</p>}

      {/* Cost preview — shown before any run/rerun. */}
      {(v.canRun || v.canRerun) && budget && spend && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 8, fontSize: 11 }}>
          <Mini k="Images" v={String(data.imageCount ?? 0)} />
          <Mini k="Reuse result?" v={v.canRerun && data.reusableResult ? 'ground truth only' : 'no — new call'} />
          <Mini k="Today" v={`${spend.evalsToday}/${budget.maxEvalsPerDay}`} />
          <Mini k="Cost today" v={`${usd(spend.costTodayUsd)}/${usd(budget.maxEstDailyCostUsd)}`} />
          <Mini k="Remaining" v={`${remainingEvals} eval · ${usd(remainingCost)}`} />
          <Mini k="This booking" v={`${spend.attemptsForBooking}/${budget.maxEvalsPerBooking}`} />
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {v.canSelect && <button disabled={!!busy} onClick={() => act('select')} style={btn('#93c5fd')}>{busy === 'select' ? '…' : 'Select for shadow'}</button>}
        {v.canUnselect && <button disabled={!!busy} onClick={() => act('unselect')} style={btn()}>{busy === 'unselect' ? '…' : 'Unselect'}</button>}

        {v.canRun && (confirmRun === 'run'
          ? <ConfirmRun label="Run 1 evaluation" onConfirm={() => act('run')} onCancel={() => setConfirmRun(null)} busy={!!busy} />
          : <button disabled={!!busy} onClick={() => setConfirmRun('run')} style={btn('#34d399')}>Run V2 Shadow Evaluation</button>)}

        {v.canRetry && <button disabled={!!busy} onClick={() => act('retry')} style={btn('#fbbf24')}>{busy === 'retry' ? '…' : 'Retry failed run'}</button>}

        {v.canRerun && (confirmRun === 'rerun'
          ? <ConfirmRun label="Rerun (1 new call)" onConfirm={() => act('rerun')} onCancel={() => setConfirmRun(null)} busy={!!busy} />
          : <button disabled={!!busy} onClick={() => setConfirmRun('rerun')} style={btn()}>Rerun</button>)}

        {v.canOpen && <Link href={`/admin/operations/ai/shadow/${bookingId}`} style={{ ...btn('#a3e635'), textDecoration: 'none' }}>Open comparison →</Link>}
        {!busy && <button onClick={() => load()} style={{ ...btn(), fontSize: 11 }} title="Refresh status (no AI call)">↻</button>}
      </div>

      {v.status === 'awaiting_ground_truth' && (
        <Link href={`/admin/operations/ai/shadow/${bookingId}`} style={{ fontSize: 11.5, color: '#a3e635', textDecoration: 'none' }}>
          → Record the amount you actually quoted to score this evaluation
        </Link>
      )}
      {(data.job?.priorRuns?.length ?? 0) > 0 && !compact && (
        <p style={{ margin: 0, fontSize: 10.5, color: 'var(--muted)' }}>{data.job!.priorRuns!.length} prior run(s) preserved in history.</p>
      )}
      {err && <p style={{ margin: 0, fontSize: 11, color: '#f87171' }}>{err}</p>}
    </div>
  )
}

function Mini({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{k}</div>
      <div style={{ fontSize: 12, fontWeight: 700 }}>{v}</div>
    </div>
  )
}

function ConfirmRun({ label, onConfirm, onCancel, busy }: { label: string; onConfirm: () => void; onCancel: () => void; busy: boolean }) {
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <button disabled={busy} onClick={onConfirm} style={btn('#34d399')}>{busy ? 'Running…' : `Confirm: ${label}`}</button>
      <button disabled={busy} onClick={onCancel} style={btn()}>Cancel</button>
    </span>
  )
}
