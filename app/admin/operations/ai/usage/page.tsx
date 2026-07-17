'use client'

// ── AI Command Center — Usage & Controls (canonical) ─────────────────────────
// The operational home: global kill switch (confirmed, audited), V1/V2 states, budget (read-
// only, env-configured), and usage counters. Reuses /api/admin/ai-config (read) and the
// existing /api/admin/shadow-kill-switch (the ONLY mutating action). ZERO AI on load — the kill
// switch is the only write, and it is never toggled by a page load or refresh.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import OperationsShell from '../../OperationsShell'
import AICommandShell, { aiCard, aiLabel, AIStat, AISkeleton, AIError, AIEmpty } from '../AICommandShell'

const usd = (n?: number | null) => (typeof n === 'number' ? `$${n.toFixed(n % 1 ? 2 : 0)}` : '—')

type Budget = { maxEvalsPerDay: number; maxEvalsPerBooking: number; maxEstDailyCostUsd: number; maxAttempts: number }
type Spend = { day: string; evals: number; costUsd: number; retries: number; preventedRetries: number; budgetBlocked: number }
type Usage = { totalInferenceAttempts: number; totalRetries: number; estTotalCostUsd: number; missingCost: number; byFailureCategory: Record<string, number> }
type Controls = { killed: boolean; killOverride: boolean | null; envKillForced: boolean; budget: Budget; spendToday: Spend; usage: Usage }
type Payload = { enabled: boolean; controls?: Controls; flags?: { shadowWorker: boolean; selectedOnly: boolean; shadowAlerting: boolean } }

export default function UsagePage() {
  return <OperationsShell><AICommandShell section="controls" title="Usage & Controls"><Usage /></AICommandShell></OperationsShell>
}

function Usage() {
  const [res, setRes] = useState<{ payload: Payload | null; err: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback((signal?: AbortSignal) =>
    fetch('/api/admin/ai-config', { credentials: 'same-origin', signal })
      .then(async (r) => { if (r.status === 401 || r.status === 403) return setRes({ payload: null, err: 'Owner access required.' }); setRes({ payload: await r.json(), err: '' }) })
      .catch((e) => { if ((e as { name?: string })?.name !== 'AbortError') setRes({ payload: null, err: 'Could not load usage & controls.' }) }), [])
  useEffect(() => { const c = new AbortController(); load(c.signal); return () => c.abort() }, [load])

  // The ONLY mutating action on this page — explicit, confirmed, audited server-side.
  const toggleKill = async (on: boolean) => {
    const msg = on
      ? 'Engage the kill switch? This HALTS all new V2 shadow evaluations immediately. V1 (customer-facing), analytics, and ground-truth editing are NOT affected. This is audited.'
      : 'Release the kill switch? New V2 shadow evaluations may resume, subject to the budget caps. This is audited.'
    if (!window.confirm(msg)) return
    setBusy(true)
    try {
      await fetch('/api/admin/shadow-kill-switch', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on }) })
      await load()
    } finally { setBusy(false) }
  }

  if (!res) return <AISkeleton rows={4} />
  if (res.err) return <AIError message={res.err} />
  const d = res.payload
  if (d && !d.enabled) return <AIEmpty title="AI evaluation is off" detail="Enable SHADOW_ANALYTICS_ENABLED to view usage & controls." />
  if (!d?.controls) return <AISkeleton rows={4} />
  const c = d.controls
  const b = c.budget, sp = c.spendToday
  const evalPct = Math.min(100, Math.round((sp.evals / Math.max(1, b.maxEvalsPerDay)) * 100))
  const costPct = Math.min(100, Math.round((sp.costUsd / Math.max(0.0001, b.maxEstDailyCostUsd)) * 100))
  const budgetExhausted = sp.evals >= b.maxEvalsPerDay || sp.costUsd >= b.maxEstDailyCostUsd

  return (
    <>
      {/* Kill switch — distinct states, never collapsed into a vague "offline" */}
      <div style={{ ...aiCard, borderColor: c.killed ? '#f8717155' : 'var(--line)', display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <span style={aiLabel}>V2 inference kill switch</span>
          <span style={{ fontSize: 12.5, fontWeight: 800, color: c.killed ? '#f87171' : '#34d399' }}>{c.killed ? '● HALTED' : '● Running'}</span>
          <button disabled={busy || c.envKillForced} onClick={() => toggleKill(!c.killed)}
            title={c.envKillForced ? 'Forced off by the SHADOW_V2_KILL_SWITCH environment flag' : ''}
            style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 700, padding: '8px 15px', borderRadius: 10, cursor: c.envKillForced ? 'not-allowed' : 'pointer', border: `1px solid ${c.killed ? '#34d39955' : '#f8717155'}`, background: 'transparent', color: c.killed ? '#34d399' : '#f87171', opacity: c.envKillForced ? 0.5 : 1 }}>
            {busy ? '…' : c.killed ? 'Resume V2' : 'Emergency stop'}
          </button>
        </div>
        <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: 0 }}>Halts ONLY new V2 shadow inference. V1 (customer-facing), analytics, ground-truth editing, and stored results are never affected.</p>
        {c.envKillForced && <p style={{ fontSize: 11, color: '#f87171', margin: 0 }}>Forced off by the environment flag — the runtime toggle cannot re-enable it.</p>}
      </div>

      {/* Operational states — one row each, distinct */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <State label="V1 production" ok detail="Customer-facing — always live" />
        <State label="V2 shadow" ok={!c.killed && (d.flags?.shadowWorker ?? false)} detail={c.killed ? 'Halted by kill switch' : (d.flags?.shadowWorker ? 'Active' : 'Worker idle')} />
        <State label="Budget" ok={!budgetExhausted} detail={budgetExhausted ? 'Daily cap reached' : 'Within caps'} />
        <State label="Provider" ok={c.spendToday.preventedRetries === 0} detail={c.spendToday.preventedRetries > 0 ? `${c.spendToday.preventedRetries} permanent failure(s)` : 'Healthy'} />
        <State label="Retry protection" ok detail={`≤${b.maxAttempts - 1} retry per run`} />
      </div>

      {/* Budget — read-only (env-configured), with clear units + reset window */}
      <div style={{ ...aiCard, display: 'grid', gap: 12 }}>
        <span style={aiLabel}>Budget (resets at UTC midnight · deployment-configured)</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
          <Meter label="Evaluations today" value={`${sp.evals} / ${b.maxEvalsPerDay}`} pct={evalPct} />
          <Meter label="Est. cost today" value={`${usd(sp.costUsd)} / ${usd(b.maxEstDailyCostUsd)}`} pct={costPct} />
          <AIStat label="Remaining today" value={`${Math.max(0, b.maxEvalsPerDay - sp.evals)} eval`} sub={`${usd(Math.max(0, b.maxEstDailyCostUsd - sp.costUsd))} budget`} />
          <AIStat label="Per-booking cap" value={`${b.maxEvalsPerBooking}`} sub="attempts" />
        </div>
        <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>
          Warning threshold 80% of the daily cost cap; hard stop at 100% (evaluations pause automatically). Caps are set via <code>SHADOW_MAX_*</code> deployment variables — there is no runtime budget store to edit here.
        </p>
      </div>

      {/* Usage counters */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
        <AIStat label="Retries today" value={`${sp.retries}`} />
        <AIStat label="Retries prevented" value={`${sp.preventedRetries}`} tone={sp.preventedRetries > 0 ? '#34d399' : undefined} sub="permanent failures not re-tried" />
        <AIStat label="Budget-blocked today" value={`${sp.budgetBlocked}`} />
        <AIStat label="All-time calls" value={`${c.usage.totalInferenceAttempts}`} sub={`${usd(c.usage.estTotalCostUsd)} total`} />
      </div>
      {c.usage.missingCost > 0 && <p style={{ fontSize: 10.5, color: 'var(--muted)', margin: 0 }}>{c.usage.missingCost} completed evaluation(s) reported no token usage — cost recorded as unknown, never guessed.</p>}

      <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>
        Analytics and this page load run no AI. Version details are in <Link href="/admin/operations/ai/models" style={{ color: '#93c5fd', textDecoration: 'none' }}>Models &amp; Versions</Link>. Live production-AI telemetry (V1 cost/quality) is in <Link href="/admin/operations/ai/controls" style={{ color: '#93c5fd', textDecoration: 'none' }}>Production AI telemetry</Link>.
      </p>
    </>
  )
}

function State({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  const c = ok ? '#34d399' : '#f87171'
  return (
    <div style={aiCard}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 7, height: 7, borderRadius: 999, background: c }} /><span style={aiLabel}>{label}</span></div>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: c, marginTop: 4 }}>{ok ? 'OK' : 'Attention'}</div>
      <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{detail}</div>
    </div>
  )
}
function Meter({ label, value, pct }: { label: string; value: string; pct: number }) {
  const fill = pct >= 100 ? '#f87171' : pct > 80 ? '#fbbf24' : '#34d399'
  return (
    <div style={aiCard}>
      <span style={aiLabel}>{label}</span>
      <div style={{ fontSize: 16, fontWeight: 800 }}>{value}</div>
      <div style={{ height: 6, borderRadius: 3, background: 'var(--line)', overflow: 'hidden', marginTop: 6 }}><div style={{ height: '100%', width: `${pct}%`, background: fill }} /></div>
    </div>
  )
}
