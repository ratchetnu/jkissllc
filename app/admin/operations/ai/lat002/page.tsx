'use client'

// LAT-002 — the photo-estimate latency experiment.
//
// The page states the thing the numbers cannot: latency is MEASURED and never
// fails a run, while quote, confidence, review rate and schema validity are
// GUARDRAILS that do. Without that framing a reader sees seven numbers and assumes
// they are all targets — and LAT-002 is deliberately not a latency SLO.

import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, FlaskConical, AlertTriangle, CheckCircle2, MinusCircle } from 'lucide-react'
import OperationsShell from '../../OperationsShell'
import { Stat } from '../../ui'

type Verdict = 'safe_to_promote' | 'no_regression_no_benefit' | 'parity_regression' | 'insufficient_samples'
type Arm = {
  latency: { avg: number; p50: number; p95: number; p99: number }
  totalOutputTokens: number; meanOutputTokens: number
  totalCostUsd: number; meanCostUsd: number
  meanConfidence: number; reviewRate: number; schemaValidRate: number
}
type Report = {
  pairs: number
  baseline: Arm; candidate: Arm
  measured: { latencyP50ImprovedPct: number; latencyP95ImprovedPct: number; meanLatencyDeltaMs: number; outputTokenReductionPct: number; costReductionPct: number }
  guardrails: { quoteMismatchRate: number; worstQuoteDeltaPct: number; confidenceDrop: number; reviewRateDelta: number; candidateSchemaInvalid: number; breached: string[] }
  verdict: Verdict
  reasons: string[]
}
type RunSummary = { runId: string; arms: { baseline: string; candidate: string }; note?: string; createdAt: number; createdBy: string; report: Report }

const VERDICT: Record<Verdict, { label: string; fg: string; bg: string; icon: typeof CheckCircle2 }> = {
  safe_to_promote: { label: 'Safe to promote', fg: '#86efac', bg: 'rgba(34,197,94,.12)', icon: CheckCircle2 },
  no_regression_no_benefit: { label: 'No regression, no benefit', fg: '#93c5fd', bg: 'rgba(96,165,250,.12)', icon: MinusCircle },
  parity_regression: { label: 'Parity regression — do not promote', fg: '#fcd34d', bg: 'rgba(245,158,11,.12)', icon: AlertTriangle },
  insufficient_samples: { label: 'Not enough pairs to say', fg: 'var(--muted)', bg: 'rgba(255,255,255,.05)', icon: MinusCircle },
}

const pct = (n: number) => `${n > 0 ? '+' : ''}${n}%`
const ms = (n: number) => `${Math.round(n).toLocaleString()} ms`
const ts = (n: number) => new Date(n).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export default function Lat002Page() {
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [recordingEnabled, setRecordingEnabled] = useState(false)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const res = await fetch('/api/admin/ai/lat002', { credentials: 'same-origin' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(d.message || 'Could not load LAT-002 runs.'); return }
      setRuns(d.runs ?? []); setRecordingEnabled(!!d.recordingEnabled)
    } catch { setErr('Connection problem — anything shown below may be out of date.') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  return (
    <OperationsShell>
      <div style={{ maxWidth: 900 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <FlaskConical size={19} style={{ color: 'var(--muted)' }} />
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>LAT-002 · photo-estimate latency</h1>
          <button onClick={load} disabled={loading} className="os-tap"
            style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 13px', borderRadius: 10, background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', color: 'var(--text)', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
            <RefreshCw size={14} /> {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        <p style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.6, margin: '0 0 16px' }}>
          A paired A/B measurement: the same bookings analyzed by two arms.
          <strong style={{ color: 'var(--text)' }}> Latency, tokens and cost are measured and never fail a run</strong> —
          a slower candidate is a result, not an error.
          <strong style={{ color: 'var(--text)' }}> Quote, confidence, review rate and schema validity are guardrails</strong> —
          moving any of them beyond tolerance means the candidate is not promotable, however fast it is.
          LAT-002 is an experiment identifier, not a latency target.
        </p>

        <div style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', background: 'rgba(255,255,255,.03)', marginBottom: 16, fontSize: 12.5, color: 'var(--muted)' }}>
          Recording new runs is <strong style={{ color: recordingEnabled ? '#86efac' : 'var(--text)' }}>{recordingEnabled ? 'enabled' : 'off'}</strong> in
          this environment. Existing runs stay readable either way, so the evidence does not vanish when the flag does.
        </div>

        {err && <p role="alert" style={{ color: '#fcd34d', fontSize: 13.5 }}>{err}</p>}

        {!loading && runs.length === 0 && !err && (
          <p style={{ color: 'var(--muted)', fontSize: 14 }}>No LAT-002 runs recorded yet.</p>
        )}

        <div style={{ display: 'grid', gap: 14 }}>
          {runs.map(run => {
            const v = VERDICT[run.report.verdict] ?? VERDICT.insufficient_samples
            const Icon = v.icon
            return (
              <div key={run.runId} style={{ padding: '14px 15px', borderRadius: 12, border: '1px solid var(--line)', background: 'rgba(255,255,255,.03)' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 99, background: v.bg, color: v.fg, fontWeight: 800, fontSize: 12 }}>
                    <Icon size={13} /> {v.label}
                  </span>
                  <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                    {run.arms.baseline} → {run.arms.candidate} · {run.report.pairs} pairs
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' }}>{ts(run.createdAt)}</span>
                </div>

                {run.note && <p style={{ color: 'var(--muted)', fontSize: 13, margin: '0 0 10px' }}>{run.note}</p>}

                <div style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)', marginBottom: 6 }}>Measured</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 8, marginBottom: 12 }}>
                  <Stat label="p50 latency" value={pct(run.report.measured.latencyP50ImprovedPct)} sub={`${ms(run.report.baseline.latency.p50)} → ${ms(run.report.candidate.latency.p50)}`} />
                  <Stat label="p95 latency" value={pct(run.report.measured.latencyP95ImprovedPct)} sub={`${ms(run.report.baseline.latency.p95)} → ${ms(run.report.candidate.latency.p95)}`} />
                  <Stat label="Output tokens" value={pct(run.report.measured.outputTokenReductionPct)} />
                  <Stat label="Model cost" value={pct(run.report.measured.costReductionPct)} />
                </div>

                <div style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)', marginBottom: 6 }}>Guardrails</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 8 }}>
                  <Stat label="Quote mismatch" value={`${Math.round(run.report.guardrails.quoteMismatchRate * 100)}%`} sub={`worst ${run.report.guardrails.worstQuoteDeltaPct}%`} />
                  <Stat label="Confidence drop" value={String(run.report.guardrails.confidenceDrop)} />
                  <Stat label="Review rate Δ" value={String(run.report.guardrails.reviewRateDelta)} />
                  <Stat label="Schema invalid" value={String(run.report.guardrails.candidateSchemaInvalid)} />
                </div>

                {run.report.reasons.length > 0 && (
                  <p style={{ margin: '10px 0 0', fontSize: 12.5, color: 'var(--muted)', overflowWrap: 'anywhere' }}>
                    {run.report.reasons.join(' · ')}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </OperationsShell>
  )
}
