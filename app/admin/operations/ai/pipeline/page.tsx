'use client'

// ── AI Command Center — Pipeline (stage latency observability) ────────────────
// OPERION AI OBSERVABILITY. "Where does the time go?" for the durable Book Now AI job.
// Reads the pure /api/admin/ai/pipeline aggregate (ZERO AI): end-to-end latency, a
// per-stage breakdown (queue → image prep → provider → AI → pricing → database →
// notification), throughput, status mix, and the slowest recent runs to drill into.
// Every stat carries its denominator; sub-stages (provider, image prep) are shown as
// nested drill-downs of the AI stage so no time is double-counted.

import { Suspense, useEffect, useState } from 'react'
import OperationsShell from '../../OperationsShell'
import AICommandShell, { aiCard, aiLabel, AIStat, AISkeleton, AIError, AIEmpty } from '../AICommandShell'

// Stage display order + colors (pipeline order). Sub-stages render indented under `ai`.
const STAGE_META: Record<string, { label: string; color: string; note?: string }> = {
  queue:            { label: 'Queue wait',      color: '#a78bfa', note: 'enqueued → attempt start' },
  ai:               { label: 'AI analysis',     color: '#60a5fa', note: 'vision + normalization' },
  image_preprocess: { label: 'Image preprocess', color: '#22d3ee', note: 'URL filter + message build' },
  provider:         { label: 'Provider call',   color: '#38bdf8', note: 'AI Gateway round-trip' },
  pricing:          { label: 'Pricing',         color: '#fbbf24', note: 'monitor + decision + critic' },
  database:         { label: 'Database',        color: '#34d399', note: 'booking writes (Redis)' },
  notification:     { label: 'Notification',    color: '#f472b6', note: 'owner outcome send' },
}

type StageAgg = {
  stage: string; count: number; occurrences: number; totalMs: number; avgMs: number
  p50: number; p95: number; p99: number; maxMs: number; isSubStage: boolean; shareOfTotalPct: number
}
type Overall = { count: number; avgMs: number; p50: number; p95: number; p99: number; maxMs: number }
type SlowTrace = { id: string; bookingId?: string; attempt?: number; status?: string; outcome?: string; at: number; durationMs: number; stages: Record<string, number> }
type Payload = {
  ok: boolean; enabled: boolean; reason?: string; generatedAt?: number
  traces?: number; window?: { from: number; to: number; spanMs: number } | null
  overall?: Overall; stages?: StageAgg[]; throughputPerMin?: number
  statusBreakdown?: { status: string; count: number }[]; slowest?: SlowTrace[]
}

const STATUS_COLOR: Record<string, string> = {
  completed: '#34d399', manual_review: '#fbbf24', failed: '#f87171', retrying: '#a78bfa', unknown: '#94a3b8',
}

/** Milliseconds → a compact, human duration. */
function ms(n?: number | null): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  if (n < 1000) return `${Math.round(n)}ms`
  if (n < 10_000) return `${(n / 1000).toFixed(1)}s`
  return `${Math.round(n / 1000)}s`
}

export default function PipelinePage() {
  return <Suspense fallback={null}><OperationsShell><AICommandShell section="pipeline" title="Pipeline"><Pipeline /></AICommandShell></OperationsShell></Suspense>
}

function Pipeline() {
  const [res, setRes] = useState<{ payload: Payload | null; err: string } | null>(null)
  useEffect(() => {
    const c = new AbortController()
    fetch('/api/admin/ai/pipeline', { credentials: 'same-origin', signal: c.signal })
      .then(async (r) => {
        if (r.status === 401 || r.status === 403) return setRes({ payload: null, err: 'Owner or manager access required.' })
        setRes({ payload: await r.json(), err: '' })
      })
      .catch((e) => { if ((e as { name?: string })?.name !== 'AbortError') setRes({ payload: null, err: 'Could not load pipeline observability.' }) })
    return () => c.abort()
  }, [])

  if (res?.err) return <AIError message={res.err} />
  if (!res) return <AISkeleton rows={4} />
  const data = res.payload
  if (data && !data.enabled) return <AIEmpty title="Pipeline observability is off" detail={data.reason ?? 'Enable AI_PIPELINE_OBSERVABILITY_ENABLED to record per-stage latency.'} />
  const o = data?.overall
  if (!data || !o) return <AISkeleton rows={4} />

  if (!data.traces) {
    return <AIEmpty title="No pipeline traces yet" detail="Once the flag is on, each durable Book Now AI job records its per-stage timing here. Run an AI job to populate this view." />
  }

  const stages = data.stages ?? []
  const topStages = stages.filter((s) => !s.isSubStage && s.count > 0)
  const grandShareTotal = topStages.reduce((sum, s) => sum + s.totalMs, 0)

  return (
    <>
      {/* Health summary — the latency headline */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <AIStat label="Job runs" value={`${data.traces}`} sub={data.window ? `over ${ms(data.window.spanMs)}` : undefined} />
        <AIStat label="End-to-end p50" value={ms(o.p50)} sub={`avg ${ms(o.avgMs)}`} />
        <AIStat label="End-to-end p95" value={ms(o.p95)} tone={o.p95 > 60_000 ? '#f87171' : undefined} sub={`p99 ${ms(o.p99)} · max ${ms(o.maxMs)}`} />
        <AIStat label="Throughput" value={typeof data.throughputPerMin === 'number' ? `${data.throughputPerMin}/min` : '—'} sub="observed rate" />
      </div>

      {/* Where the time goes — non-overlapping top-level stages */}
      <div style={aiCard}>
        <span style={aiLabel}>Where the time goes — top-level stages</span>
        {grandShareTotal > 0 ? (
          <>
            <div style={{ display: 'flex', height: 24, borderRadius: 6, overflow: 'hidden', gap: 2, marginTop: 4 }}>
              {topStages.map((s) => (
                <div key={s.stage} title={`${STAGE_META[s.stage]?.label ?? s.stage}: ${s.shareOfTotalPct}% (${ms(s.totalMs)})`}
                  style={{ width: `${s.shareOfTotalPct}%`, background: STAGE_META[s.stage]?.color ?? '#94a3b8' }} />
              ))}
            </div>
            <div style={{ display: 'flex', gap: 14, marginTop: 10, flexWrap: 'wrap', fontSize: 11.5 }}>
              {topStages.map((s) => (
                <span key={s.stage} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--muted)' }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: STAGE_META[s.stage]?.color ?? '#94a3b8' }} />
                  {STAGE_META[s.stage]?.label ?? s.stage} {s.shareOfTotalPct}%
                </span>
              ))}
            </div>
          </>
        ) : <div style={{ fontSize: 12, color: 'var(--muted)' }}>No stage timing recorded yet.</div>}
      </div>

      {/* Per-stage latency table */}
      <div style={aiCard}>
        <span style={aiLabel}>Per-stage latency (per job run)</span>
        <StageTable stages={stages} />
        <p style={{ fontSize: 11, color: 'var(--muted)', margin: '10px 0 0' }}>
          Indented rows (provider, image preprocess) are components of the AI stage — shown for drill-down, not counted twice in the breakdown above.
        </p>
      </div>

      {/* Status mix */}
      {(data.statusBreakdown?.length ?? 0) > 0 && (
        <div style={aiCard}>
          <span style={aiLabel}>Outcome mix</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
            {data.statusBreakdown!.map((s) => (
              <span key={s.status} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '5px 10px', borderRadius: 999, border: '1px solid var(--line)' }}>
                <span style={{ width: 8, height: 8, borderRadius: 999, background: STATUS_COLOR[s.status] ?? '#94a3b8' }} />
                {s.status.replace(/_/g, ' ')} · {s.count}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Slowest recent runs */}
      <div style={aiCard}>
        <span style={aiLabel}>Slowest recent runs</span>
        <SlowestTable rows={data.slowest ?? []} />
      </div>

      <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>
        Observability only — this page runs no AI. Timings are recorded per durable Book Now AI job for performance tuning.
      </p>
    </>
  )
}

function StageTable({ stages }: { stages: StageAgg[] }) {
  const rows = stages.filter((s) => s.count > 0)
  if (!rows.length) return <div style={{ fontSize: 12, color: 'var(--muted)' }}>No stage timing recorded yet.</div>
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 520 }}>
        <thead>
          <tr style={{ color: 'var(--muted)', textAlign: 'left' }}>
            {['Stage', 'n', 'p50', 'p95', 'p99', 'avg', 'max', 'share'].map((h) => (
              <th key={h} style={{ padding: '4px 8px', fontSize: 10, textTransform: 'uppercase' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const meta = STAGE_META[s.stage]
            return (
              <tr key={s.stage} style={{ borderTop: '1px solid var(--line)' }}>
                <td style={{ padding: '6px 8px', paddingLeft: s.isSubStage ? 26 : 8, fontWeight: s.isSubStage ? 500 : 700 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                    <span style={{ width: 9, height: 9, borderRadius: 2, background: meta?.color ?? '#94a3b8', opacity: s.isSubStage ? 0.7 : 1 }} />
                    {s.isSubStage ? '↳ ' : ''}{meta?.label ?? s.stage}
                  </span>
                  {meta?.note && <div style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 16 }}>{meta.note}</div>}
                </td>
                <td style={{ padding: '6px 8px' }}>{s.count}</td>
                <td style={{ padding: '6px 8px' }}>{ms(s.p50)}</td>
                <td style={{ padding: '6px 8px', fontWeight: 700 }}>{ms(s.p95)}</td>
                <td style={{ padding: '6px 8px' }}>{ms(s.p99)}</td>
                <td style={{ padding: '6px 8px' }}>{ms(s.avgMs)}</td>
                <td style={{ padding: '6px 8px' }}>{ms(s.maxMs)}</td>
                <td style={{ padding: '6px 8px', color: 'var(--muted)' }}>{s.isSubStage ? '—' : `${s.shareOfTotalPct}%`}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function SlowestTable({ rows }: { rows: SlowTrace[] }) {
  if (!rows.length) return <div style={{ fontSize: 12, color: 'var(--muted)' }}>No runs recorded yet.</div>
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 520 }}>
        <thead>
          <tr style={{ color: 'var(--muted)', textAlign: 'left' }}>
            {['Run', 'Booking', 'Status', 'Total', 'Breakdown'].map((h) => (
              <th key={h} style={{ padding: '4px 8px', fontSize: 10, textTransform: 'uppercase' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ borderTop: '1px solid var(--line)' }}>
              <td style={{ padding: '6px 8px', fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>{r.id}{r.attempt ? ` ·a${r.attempt}` : ''}</td>
              <td style={{ padding: '6px 8px', fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>{r.bookingId ? r.bookingId.slice(0, 8) : '—'}</td>
              <td style={{ padding: '6px 8px' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: STATUS_COLOR[r.status ?? 'unknown'] ?? '#94a3b8' }} />
                  {(r.status ?? 'unknown').replace(/_/g, ' ')}
                </span>
              </td>
              <td style={{ padding: '6px 8px', fontWeight: 700 }}>{ms(r.durationMs)}</td>
              <td style={{ padding: '6px 8px' }}><MiniBreakdown stages={r.stages} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MiniBreakdown({ stages }: { stages: Record<string, number> }) {
  // Non-overlapping top-level stages only (skip provider/image_preprocess — nested in AI).
  const order = ['queue', 'ai', 'pricing', 'database', 'notification']
  const entries = order.map((k) => [k, stages[k]] as const).filter(([, v]) => typeof v === 'number' && v > 0)
  const total = entries.reduce((sum, [, v]) => sum + (v as number), 0)
  if (!total) return <span style={{ fontSize: 11, color: 'var(--muted)' }}>—</span>
  return (
    <div style={{ display: 'flex', height: 12, borderRadius: 3, overflow: 'hidden', gap: 1, minWidth: 120 }}>
      {entries.map(([k, v]) => (
        <div key={k} title={`${STAGE_META[k]?.label ?? k}: ${ms(v as number)}`}
          style={{ width: `${((v as number) / total) * 100}%`, background: STAGE_META[k]?.color ?? '#94a3b8' }} />
      ))}
    </div>
  )
}
