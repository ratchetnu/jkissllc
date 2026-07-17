'use client'

// ── Operion — AI Shadow Analytics (executive command center) ─────────────────
// Owner-only. Reads the deployed GET /api/admin/shadow-analytics (SHADOW_ANALYTICS_ENABLED-
// gated; all numbers are pure-derived from persisted V2ShadowJob[]). This page NEVER re-derives
// model math — it renders the API. No external chart lib (self-contained inline SVG), theme-aware
// via the admin CSS vars, mobile-responsive (grids collapse, table → cards). No customer impact.

import { useCallback, useEffect, useState } from 'react'
import OperationsShell from '../../OperationsShell'

// ── shared style tokens (same admin theme vars the rest of Operion uses) ─────
const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 16 }
const lab: React.CSSProperties = { display: 'block', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', marginBottom: 4 }
const btn: React.CSSProperties = { fontSize: 12.5, fontWeight: 700, padding: '7px 13px', borderRadius: 9, cursor: 'pointer', border: '1px solid var(--line)', background: 'transparent', color: 'var(--text)' }
const nice = (s: string) => s.replace(/_/g, ' ')
const usd = (n?: number | null) => (typeof n === 'number' ? `$${n.toFixed(n % 1 ? 2 : 0)}` : '—')
const pctS = (n?: number | null) => (typeof n === 'number' ? `${n}%` : '—')

// Readiness tier → color + friendly label.
const TIER: Record<string, { c: string; label: string }> = {
  BLOCKED: { c: '#f87171', label: 'Blocked' },
  NEEDS_MORE_DATA: { c: '#93c5fd', label: 'Needs more data' },
  READY_FOR_EXPANDED_SHADOW: { c: '#fbbf24', label: 'Ready for expanded shadow' },
  READY_FOR_LIMITED_ROLLOUT: { c: '#a3e635', label: 'Ready for limited rollout' },
  READY_FOR_CUSTOMER_ROLLOUT: { c: '#34d399', label: 'Ready for customer rollout' },
}
const SEV: Record<string, string> = { high: '#f87171', medium: '#fbbf24', low: '#93c5fd' }

type Analytics = {
  total: number; evaluated: number; agreementPct: number; disagreementPct: number
  autoQuoteRate: number; manualReviewRate: number; avgConfidence: number | null
  confidenceDistribution: { high: number; medium: number; low: number }
  avgQuoteDeltaUsd: number | null; avgAbsQuoteDeltaUsd: number | null
  manualReviewDiffers: number; reviewReasonFrequency: Record<string, number>
}
type Disagreement = { bookingId: string; kind: string; severity: string; detail: string; quoteDeltaUsd?: number; at: number }
type Scorecard = { model: string; promptVersion?: number; estimatorVersion?: number; count: number; agreementPct: number; autoQuotePct: number; manualReviewPct: number; avgConfidence: number | null; avgLatencyMs: number | null; avgCostUsd: number | null; falseNegatives: number }
type Readiness = { tier: string; score: number; reasons: string[]; blockers: string[] }
type Metrics = { total: number; queued: number; processing: number; completed: number; failed: number; timedOut: number; retries: number; awaitingReview: number; avgRuntimeMs: number | null; totalEstCostUsd: number }
type Payload = { enabled: boolean; reason?: string; sampled?: number; analytics?: Analytics; disagreements?: Disagreement[]; scorecards?: Scorecard[]; readiness?: Readiness; metrics?: Metrics }

export default function ShadowAnalyticsPage() {
  const [data, setData] = useState<Payload | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const res = await fetch('/api/admin/shadow-analytics', { credentials: 'same-origin' })
      if (res.status === 401 || res.status === 403) { setErr('Owner access required.'); setData(null); return }
      setData(await res.json())
    } catch { setErr('Could not load analytics.') } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const fns = (data?.disagreements ?? []).filter((d) => d.kind === 'possible_false_negative').length
  const fps = (data?.disagreements ?? []).filter((d) => d.kind === 'possible_false_positive').length
  const a = data?.analytics
  const r = data?.readiness

  return (
    <OperationsShell>
      <div style={{ display: 'grid', gap: 14, maxWidth: 1120, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: 22, fontWeight: 800 }}>🧪 AI Shadow Analytics</h1>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>V2 evaluated against V1 on real traffic — V1 stays customer-facing.</span>
          <button style={{ ...btn, marginLeft: 'auto' }} disabled={loading} onClick={load}>{loading ? 'Loading…' : 'Refresh'}</button>
        </div>

        {err && <div style={{ ...card, color: '#f87171', fontSize: 13 }}>{err}</div>}

        {data && data.enabled === false && (
          <div style={{ ...card, display: 'grid', gap: 6 }}>
            <p style={{ fontSize: 14, fontWeight: 700 }}>Shadow Analytics is off</p>
            <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>The evaluation engine + API are deployed. Set <code>SHADOW_ANALYTICS_ENABLED=true</code> to turn on this control center. It reads persisted shadow jobs only — no customer impact, and it does not enable any shadow processing.</p>
          </div>
        )}

        {data?.enabled && a && (
          <>
            {/* ── Readiness hero ── */}
            {r && <ReadinessHero r={r} a={a} fns={fns} fps={fps} />}

            {/* ── Executive overview cards ── */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
              <Stat label="Evaluations" value={`${a.evaluated}`} sub={`${data.sampled ?? a.total} sampled`} />
              <Stat label="Agreement" value={pctS(a.agreementPct)} good={a.agreementPct >= 85} />
              <Stat label="Auto-quote rate" value={pctS(a.autoQuoteRate)} />
              <Stat label="Manual review" value={pctS(a.manualReviewRate)} />
              <Stat label="Avg confidence" value={a.avgConfidence != null ? `${Math.round(a.avgConfidence * 100)}%` : '—'} />
              <Stat label="Avg latency" value={data.metrics?.avgRuntimeMs != null ? `${(data.metrics.avgRuntimeMs / 1000).toFixed(1)}s` : '—'} />
              <Stat label="Avg cost / eval" value={data.metrics && data.metrics.completed > 0 ? usd(data.metrics.totalEstCostUsd / Math.max(1, data.metrics.completed)) : '—'} />
              <Stat label="False negatives" value={`${fns}`} good={fns === 0} bad={fns > 0} />
              <Stat label="False positives" value={`${fps}`} />
              <Stat label="Awaiting review" value={`${data.metrics?.awaitingReview ?? 0}`} />
            </div>

            {/* ── Charts row: confidence distribution + agreement donut ── */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
              <div style={card}>
                <span style={lab}>Confidence distribution</span>
                <ConfBars d={a.confidenceDistribution} />
              </div>
              <div style={card}>
                <span style={lab}>Agreement</span>
                <Donut pct={a.agreementPct} />
              </div>
              <div style={card}>
                <span style={lab}>Top review reasons</span>
                <ReasonBars freq={a.reviewReasonFrequency} />
              </div>
            </div>

            {/* ── Model scorecard ── */}
            {(data.scorecards?.length ?? 0) > 0 && (
              <div style={card}>
                <span style={lab}>Model scorecard</span>
                <Scorecards cards={data.scorecards!} />
              </div>
            )}

            {/* ── Disagreement explorer (list) ── */}
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={lab}>Disagreements</span>
                <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 'auto' }}>{data.disagreements?.length ?? 0} shown · ranked by severity</span>
              </div>
              <Disagreements items={data.disagreements ?? []} />
            </div>
          </>
        )}

        {data?.enabled && a && a.evaluated === 0 && (
          <div style={{ ...card, fontSize: 12.5, color: 'var(--muted)' }}>No shadow evaluations yet. Enable the <code>VISION_SHADOW_*</code> flags (a separate, deliberate step) to start collecting real comparisons.</div>
        )}
      </div>
    </OperationsShell>
  )
}

// ── Readiness hero ───────────────────────────────────────────────────────────
function ReadinessHero({ r, a, fns, fps }: { r: Readiness; a: Analytics; fns: number; fps: number }) {
  const t = TIER[r.tier] ?? { c: 'var(--muted)', label: nice(r.tier) }
  return (
    <div style={{ ...card, display: 'grid', gap: 12, gridTemplateColumns: 'auto 1fr', alignItems: 'center' }}>
      <div style={{ display: 'grid', placeItems: 'center', minWidth: 96 }}>
        <Gauge pct={Math.round(r.score * 100)} color={t.c} />
        <span style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>AI readiness</span>
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: t.c, padding: '4px 10px', borderRadius: 999, background: `color-mix(in srgb, ${t.c} 16%, transparent)` }}>{t.label}</span>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>agreement {pctS(a.agreementPct)} · FN {fns} · FP {fps}</span>
        </div>
        {r.blockers.map((b, i) => <p key={i} style={{ fontSize: 12.5, color: '#f87171' }}>⛔ {b}</p>)}
        {r.reasons.map((x, i) => <p key={i} style={{ fontSize: 12.5, color: 'var(--muted)' }}>• {x}</p>)}
      </div>
    </div>
  )
}

// ── Stat card ────────────────────────────────────────────────────────────────
function Stat({ label, value, sub, good, bad }: { label: string; value: string; sub?: string; good?: boolean; bad?: boolean }) {
  return (
    <div style={card}>
      <span style={lab}>{label}</span>
      <div style={{ fontSize: 22, fontWeight: 800, color: bad ? '#f87171' : good ? '#34d399' : 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

// ── Inline SVG: readiness gauge ──────────────────────────────────────────────
function Gauge({ pct, color }: { pct: number; color: string }) {
  const R = 34, C = 2 * Math.PI * R, off = C * (1 - Math.max(0, Math.min(100, pct)) / 100)
  return (
    <svg width="84" height="84" viewBox="0 0 84 84" role="img" aria-label={`Readiness ${pct}%`}>
      <circle cx="42" cy="42" r={R} fill="none" stroke="var(--line)" strokeWidth="8" />
      <circle cx="42" cy="42" r={R} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round"
        strokeDasharray={C} strokeDashoffset={off} transform="rotate(-90 42 42)" />
      <text x="42" y="47" textAnchor="middle" fontSize="20" fontWeight="800" fill="var(--text)">{pct}%</text>
    </svg>
  )
}

// ── Inline SVG: agreement donut ──────────────────────────────────────────────
function Donut({ pct }: { pct: number }) {
  const R = 30, C = 2 * Math.PI * R, off = C * (1 - pct / 100)
  const col = pct >= 85 ? '#34d399' : pct >= 70 ? '#fbbf24' : '#f87171'
  return (
    <div style={{ display: 'grid', placeItems: 'center', paddingTop: 6 }}>
      <svg width="120" height="120" viewBox="0 0 84 84">
        <circle cx="42" cy="42" r={R} fill="none" stroke="var(--line)" strokeWidth="10" />
        <circle cx="42" cy="42" r={R} fill="none" stroke={col} strokeWidth="10" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={off} transform="rotate(-90 42 42)" />
        <text x="42" y="47" textAnchor="middle" fontSize="17" fontWeight="800" fill="var(--text)">{pct}%</text>
      </svg>
    </div>
  )
}

// ── Confidence distribution bars ─────────────────────────────────────────────
function ConfBars({ d }: { d: { high: number; medium: number; low: number } }) {
  const total = d.high + d.medium + d.low || 1
  const rows: [string, number, string][] = [['High', d.high, '#34d399'], ['Medium', d.medium, '#fbbf24'], ['Low', d.low, '#f87171']]
  return (
    <div style={{ display: 'grid', gap: 8, marginTop: 6 }}>
      {rows.map(([k, v, c]) => (
        <div key={k} style={{ display: 'grid', gridTemplateColumns: '58px 1fr 34px', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{k}</span>
          <div style={{ height: 10, borderRadius: 999, background: 'var(--line)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(v / total) * 100}%`, background: c, borderRadius: 999 }} />
          </div>
          <span style={{ fontSize: 12, fontWeight: 700, textAlign: 'right' }}>{v}</span>
        </div>
      ))}
    </div>
  )
}

// ── Review-reason frequency bars ─────────────────────────────────────────────
function ReasonBars({ freq }: { freq: Record<string, number> }) {
  const rows = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5)
  const max = rows.length ? rows[0][1] : 1
  if (!rows.length) return <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>No review reasons recorded.</p>
  return (
    <div style={{ display: 'grid', gap: 7, marginTop: 6 }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'grid', gap: 3 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 11.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k}</span>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}>{v}</span>
          </div>
          <div style={{ height: 6, borderRadius: 999, background: 'var(--line)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(v / max) * 100}%`, background: '#93c5fd', borderRadius: 999 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Model scorecard (table → stacked on mobile via minmax grid) ──────────────
function Scorecards({ cards }: { cards: Scorecard[] }) {
  return (
    <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
      {cards.map((c, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))', gap: 8, padding: 10, border: '1px solid var(--line)', borderRadius: 10 }}>
          <Mini label="Model" value={c.model.split('/').pop() ?? c.model} />
          <Mini label="Prompt" value={`v${c.promptVersion ?? '?'}`} />
          <Mini label="Evals" value={`${c.count}`} />
          <Mini label="Agree" value={pctS(c.agreementPct)} />
          <Mini label="Auto-quote" value={pctS(c.autoQuotePct)} />
          <Mini label="Conf" value={c.avgConfidence != null ? `${Math.round(c.avgConfidence * 100)}%` : '—'} />
          <Mini label="Latency" value={c.avgLatencyMs != null ? `${(c.avgLatencyMs / 1000).toFixed(1)}s` : '—'} />
          <Mini label="Cost" value={usd(c.avgCostUsd)} />
          <Mini label="FN" value={`${c.falseNegatives}`} color={c.falseNegatives > 0 ? '#f87171' : undefined} />
        </div>
      ))}
    </div>
  )
}
function Mini({ label, value, color }: { label: string; value: string; color?: string }) {
  return <div><div style={{ fontSize: 9.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div><div style={{ fontSize: 13, fontWeight: 700, color: color ?? 'var(--text)' }}>{value}</div></div>
}

// ── Disagreement list ────────────────────────────────────────────────────────
function Disagreements({ items }: { items: Disagreement[] }) {
  if (!items.length) return <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 8 }}>No disagreements — V2 matches V1 on every evaluated job. 🎉</p>
  return (
    <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
      {items.map((d, i) => (
        <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '9px 11px', border: '1px solid var(--line)', borderRadius: 10, flexWrap: 'wrap' }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: SEV[d.severity] ?? 'var(--muted)', flexShrink: 0 }} />
          <span style={{ fontSize: 11.5, fontWeight: 700, color: SEV[d.severity] ?? 'var(--text)', textTransform: 'uppercase', letterSpacing: '.03em', minWidth: 130 }}>{nice(d.kind)}</span>
          <span style={{ fontSize: 12.5, color: 'var(--text)', flex: 1, minWidth: 180 }}>{d.detail}</span>
          {typeof d.quoteDeltaUsd === 'number' && <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>Δ {usd(d.quoteDeltaUsd)}</span>}
          <code style={{ fontSize: 10.5, color: 'var(--muted)' }}>{d.bookingId.slice(0, 10)}</code>
        </div>
      ))}
    </div>
  )
}
