'use client'

// ── Operion — AI Shadow Analytics (executive command center) ─────────────────
// Owner-only. Reads the deployed GET /api/admin/shadow-analytics (SHADOW_ANALYTICS_ENABLED-
// gated; all numbers are pure-derived from persisted V2ShadowJob[]). This page NEVER re-derives
// model math — it renders the API. No external chart lib (self-contained inline SVG), theme-aware
// via the admin CSS vars, mobile-responsive (grids collapse, table → cards). No customer impact.

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import OperationsShell from '../../OperationsShell'
import AICommandShell from '../AICommandShell'
import type { TrendMetric } from './TrendChart'

// Heavy chart code is lazy-loaded (own chunk, no SSR) so it never weighs on first paint.
const TrendChart = dynamic(() => import('./TrendChart'), {
  ssr: false,
  loading: () => <div style={{ height: 200, display: 'grid', placeItems: 'center', color: 'var(--muted)', fontSize: 12 }}>Loading chart…</div>,
})

// ── shared style tokens (same admin theme vars the rest of Operion uses) ─────
const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 16 }
const lab: React.CSSProperties = { display: 'block', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', marginBottom: 4 }
const btn: React.CSSProperties = { fontSize: 12.5, fontWeight: 700, padding: '7px 13px', borderRadius: 9, cursor: 'pointer', border: '1px solid var(--line)', background: 'transparent', color: 'var(--text)' }
const seg: React.CSSProperties = { fontSize: 11.5, fontWeight: 700, padding: '6px 12px', cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--muted)' }
const segOn: React.CSSProperties = { background: 'var(--text)', color: 'var(--card)' }
const dateInput: React.CSSProperties = { padding: '5px 8px', background: 'transparent', border: '1px solid var(--line)', borderRadius: 8, color: 'var(--text)', fontSize: 11.5, colorScheme: 'light dark' }
const selectStyle: React.CSSProperties = { padding: '6px 9px', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, color: 'var(--text)', fontSize: 11.5, maxWidth: 220 }
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
type FacetOption = { value: string; label: string; count: number }
type Facets = { models: FacetOption[]; deployments: FacetOption[]; businesses: FacetOption[] }
type Bucket = { start: number; end: number; count: number; groundTruthCount: number; agreementPct: number; autoQuotePct: number; avgConfidence: number | null; avgLatencyMs: number | null }
type Usage = { totalEvaluations: number; totalInferenceAttempts: number; totalRetries: number; estTotalCostUsd: number; withCost: number; missingCost: number; byFailureCategory: Record<string, number>; today: { day: string; evaluations: number; estCostUsd: number } }
type SpendToday = { day: string; evals: number; costUsd: number; retries: number; preventedRetries: number; budgetBlocked: number }
type Budget = { killed: boolean; maxEvalsPerDay: number; maxEvalsPerBooking: number; maxEstDailyCostUsd: number; maxAttempts: number }
type Payload = { enabled: boolean; reason?: string; sampled?: number; matched?: number; facets?: Facets; analytics?: Analytics; disagreements?: Disagreement[]; scorecards?: Scorecard[]; readiness?: Readiness; metrics?: Metrics; usage?: Usage; spendToday?: SpendToday; budget?: Budget; killOverride?: boolean | null; window?: string; rollup?: Bucket[] }

const WINDOWS: { k: string; label: string }[] = [{ k: '24h', label: '24h' }, { k: '7d', label: '7d' }, { k: '30d', label: '30d' }, { k: '90d', label: '90d' }]
const METRIC_OPTS: { k: TrendMetric; label: string }[] = [{ k: 'agreement', label: 'Agreement' }, { k: 'autoQuote', label: 'Auto-quote' }, { k: 'confidence', label: 'Confidence' }, { k: 'latency', label: 'Latency' }]
const isWindow = (s: string | null): s is string => !!s && WINDOWS.some((w) => w.k === s)
const isMetric = (s: string | null): s is TrendMetric => !!s && METRIC_OPTS.some((m) => m.k === s)
const dayToMs = (d: string, end = false): number | undefined => { const t = Date.parse(end ? `${d}T23:59:59` : `${d}T00:00:00`); return Number.isFinite(t) ? t : undefined }

// useSearchParams needs a Suspense boundary during prerender — wrap the real page in one.
export default function ShadowAnalyticsPage() {
  return <Suspense fallback={null}><ShadowAnalyticsInner /></Suspense>
}

function ShadowAnalyticsInner() {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()

  // View state seeded from the URL so refresh / a shared link restores the exact view.
  const [win, setWin] = useState<string>(isWindow(sp.get('window')) ? sp.get('window')! : '7d')
  const [metric, setMetric] = useState<TrendMetric>(isMetric(sp.get('metric')) ? (sp.get('metric') as TrendMetric) : 'agreement')
  const [model, setModel] = useState<string>(sp.get('model') ?? '')
  const [deployment, setDeployment] = useState<string>(sp.get('deployment') ?? '')
  const [business, setBusiness] = useState<string>(sp.get('business') ?? '')
  const [fromD, setFromD] = useState<string>(sp.get('fromD') ?? '')   // YYYY-MM-DD draft
  const [toD, setToD] = useState<string>(sp.get('toD') ?? '')

  const [data, setData] = useState<Payload | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)

  // Debounce the custom date inputs so typing a range doesn't fire a request per keystroke.
  const [range, setRange] = useState<{ fromD: string; toD: string }>({ fromD, toD })
  useEffect(() => { const id = setTimeout(() => setRange({ fromD, toD }), 400); return () => clearTimeout(id) }, [fromD, toD])

  // The API query string — the single source both the fetch and the URL derive from.
  const query = useMemo(() => {
    const q = new URLSearchParams({ window: win })
    if (model) q.set('model', model)
    if (deployment) q.set('deployment', deployment)
    if (business) q.set('business', business)
    const from = range.fromD ? dayToMs(range.fromD) : undefined
    const to = range.toD ? dayToMs(range.toD, true) : undefined
    if (from != null) q.set('from', String(from))
    if (to != null) q.set('to', String(to))
    return q.toString()
  }, [win, model, deployment, business, range.fromD, range.toD])

  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true); setErr('')
    return fetch(`/api/admin/shadow-analytics?${query}`, { credentials: 'same-origin', signal })
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) { setErr('Owner access required.'); setData(null); return }
        setData(await res.json())
      })
      .catch((e) => { if ((e as { name?: string })?.name !== 'AbortError') setErr('Could not load analytics.') })
      .finally(() => { if (!signal?.aborted) setLoading(false) })
  }, [query])

  // Fetch when the query changes; abort any now-stale in-flight request.
  useEffect(() => { const c = new AbortController(); load(c.signal); return () => c.abort() }, [load])

  // Mirror the view into the URL (replace, no scroll) so refresh/back restore it.
  useEffect(() => {
    const q = new URLSearchParams(query)
    if (metric !== 'agreement') q.set('metric', metric)
    if (fromD) q.set('fromD', fromD)
    if (toD) q.set('toD', toD)
    router.replace(`${pathname}?${q.toString()}`, { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, metric, fromD, toD])

  const resetFilters = () => { setModel(''); setDeployment(''); setBusiness(''); setFromD(''); setToD('') }
  const hasFilters = !!(model || deployment || business || fromD || toD)
  const filterSummary = useMemo(() => {
    const p: string[] = []
    if (model) p.push(`model ${model.split('/').pop()}`)
    if (deployment) p.push('1 deployment')
    if (business) p.push(`business ${business}`)
    if (range.fromD || range.toD) p.push(`${range.fromD || '…'} → ${range.toD || '…'}`)
    return p.length ? p.join(' · ') : 'all evaluations'
  }, [model, deployment, business, range.fromD, range.toD])

  const fns = (data?.disagreements ?? []).filter((d) => d.kind === 'possible_false_negative').length
  const fps = (data?.disagreements ?? []).filter((d) => d.kind === 'possible_false_positive').length
  const a = data?.analytics
  const r = data?.readiness
  const facets = data?.facets

  return (
    <OperationsShell><AICommandShell section="performance" title="Performance">
      <div style={{ display: 'grid', gap: 14, maxWidth: 1120, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: 22, fontWeight: 800 }}>🧪 AI Shadow Analytics</h1>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>V2 evaluated against V1 on real traffic — V1 stays customer-facing.</span>
          <Link href="/admin/operations/ai/shadow/eligible" style={{ ...btn, marginLeft: 'auto', textDecoration: 'none' }}>Select / run jobs →</Link>
          <button style={btn} disabled={loading} onClick={() => load()}>{loading ? 'Loading…' : 'Refresh'}</button>
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
            {/* ── Controls: window · filters · reset ── */}
            <div style={{ ...card, display: 'grid', gap: 10 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={lab}>Window</span>
                <div style={{ display: 'inline-flex', border: '1px solid var(--line)', borderRadius: 9, overflow: 'hidden' }}>
                  {WINDOWS.map((wi) => (
                    <button key={wi.k} onClick={() => setWin(wi.k)}
                      style={{ ...seg, ...(win === wi.k ? segOn : null) }}>{wi.label}</button>
                  ))}
                </div>
                <span style={{ ...lab, marginLeft: 8 }}>Metric</span>
                <div style={{ display: 'inline-flex', border: '1px solid var(--line)', borderRadius: 9, overflow: 'hidden' }}>
                  {METRIC_OPTS.map((mo) => (
                    <button key={mo.k} onClick={() => setMetric(mo.k)}
                      style={{ ...seg, ...(metric === mo.k ? segOn : null) }}>{mo.label}</button>
                  ))}
                </div>
                {loading && <span style={{ fontSize: 11, color: 'var(--muted)' }}>updating…</span>}
                {hasFilters && <button style={{ ...btn, marginLeft: 'auto', fontSize: 11.5, padding: '5px 11px' }} onClick={resetFilters}>Reset filters</button>}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {(facets?.models.length ?? 0) > 1 && (
                  <Picker label="Model" value={model} onChange={setModel} opts={facets!.models} allLabel="All models" />
                )}
                {(facets?.deployments.length ?? 0) > 1 && (
                  <Picker label="Deployment" value={deployment} onChange={setDeployment} opts={facets!.deployments} allLabel="All deployments" />
                )}
                {(facets?.businesses.length ?? 0) > 1 && (
                  <Picker label="Business" value={business} onChange={setBusiness} opts={facets!.businesses} allLabel="All businesses" />
                )}
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--muted)' }}>
                  From <input type="date" value={fromD} max={toD || undefined} onChange={(e) => setFromD(e.target.value)} style={dateInput} />
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--muted)' }}>
                  To <input type="date" value={toD} min={fromD || undefined} onChange={(e) => setToD(e.target.value)} style={dateInput} />
                </label>
                {typeof data.matched === 'number' && data.matched !== data.sampled && (
                  <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 'auto' }}>Showing {data.matched} of {data.sampled}</span>
                )}
              </div>
            </div>

            {/* ── Time-series trend (lazy chart, reads the rollup API) ── */}
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                <span style={lab}>{METRIC_OPTS.find((mo) => mo.k === metric)?.label} trend</span>
                <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 'auto' }}>{win} · {filterSummary}</span>
              </div>
              <TrendChart buckets={data.rollup ?? []} metric={metric} window={win} filterSummary={filterSummary} />
            </div>

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

            {data.usage && data.budget && data.spendToday && (
              <CreditProtection usage={data.usage} spend={data.spendToday} budget={data.budget} killOverride={data.killOverride ?? null} onReload={() => load()} />
            )}

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
    </AICommandShell></OperationsShell>
  )
}

// ── Filter dropdown (renders only when a facet has ≥2 values) ────────────────
function Picker({ label, value, onChange, opts, allLabel }: { label: string; value: string; onChange: (v: string) => void; opts: { value: string; label: string; count: number }[]; allLabel: string }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--muted)' }}>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} style={selectStyle}>
        <option value="">{allLabel}</option>
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label} ({o.count})</option>)}
      </select>
    </label>
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
        <a key={i} href={`/admin/operations/ai/shadow/${encodeURIComponent(d.bookingId)}`} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '9px 11px', border: '1px solid var(--line)', borderRadius: 10, flexWrap: 'wrap', textDecoration: 'none', color: 'inherit' }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: SEV[d.severity] ?? 'var(--muted)', flexShrink: 0 }} />
          <span style={{ fontSize: 11.5, fontWeight: 700, color: SEV[d.severity] ?? 'var(--text)', textTransform: 'uppercase', letterSpacing: '.03em', minWidth: 130 }}>{nice(d.kind)}</span>
          <span style={{ fontSize: 12.5, color: 'var(--text)', flex: 1, minWidth: 180 }}>{d.detail}</span>
          {typeof d.quoteDeltaUsd === 'number' && <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>Δ {usd(d.quoteDeltaUsd)}</span>}
          <code style={{ fontSize: 10.5, color: 'var(--muted)' }}>{d.bookingId.slice(0, 10)}</code>
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>›</span>
        </a>
      ))}
    </div>
  )
}


// ── AI credit-protection panel ───────────────────────────────────────────────
function CreditProtection({ usage, spend, budget, killOverride, onReload }: { usage: Usage; spend: SpendToday; budget: Budget; killOverride: boolean | null; onReload: () => void }) {
  const [busy, setBusy] = useState(false)
  const effectiveKilled = budget.killed || killOverride === true
  const dayPct = Math.min(100, Math.round((spend.evals / Math.max(1, budget.maxEvalsPerDay)) * 100))
  const costPct = Math.min(100, Math.round((spend.costUsd / Math.max(0.0001, budget.maxEstDailyCostUsd)) * 100))
  const toggleKill = async (on: boolean) => {
    setBusy(true)
    try {
      await fetch('/api/admin/shadow-kill-switch', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on }) })
      onReload()
    } finally { setBusy(false) }
  }
  const barStyle: React.CSSProperties = { height: 6, borderRadius: 3, background: 'var(--line)', overflow: 'hidden', marginTop: 4 }
  const fill = (pct: number): React.CSSProperties => ({ height: '100%', width: `${pct}%`, background: pct >= 100 ? '#f87171' : pct > 80 ? '#fbbf24' : '#34d399' })
  return (
    <div style={{ ...card, borderColor: effectiveKilled ? '#f87171' : 'var(--line)', display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <strong style={{ fontSize: 13 }}>AI credit protection</strong>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>V2 inference only — V1, analytics, and ground truth are never affected.</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11.5, fontWeight: 800, color: effectiveKilled ? '#f87171' : '#34d399' }}>
            {effectiveKilled ? '● HALTED' : '● Running'}
          </span>
          <button disabled={busy || budget.killed} onClick={() => toggleKill(!effectiveKilled)}
            title={budget.killed ? 'Forced off by SHADOW_V2_KILL_SWITCH env — cannot override up' : ''}
            style={{ ...seg, border: `1px solid ${effectiveKilled ? '#34d399' : '#f87171'}`, borderRadius: 9, color: effectiveKilled ? '#34d399' : '#f87171' }}>
            {effectiveKilled ? 'Resume V2' : 'Emergency stop'}
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        <div style={{ ...card, padding: 12 }}>
          <span style={lab}>Today — evaluations</span>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{spend.evals} <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>/ {budget.maxEvalsPerDay}</span></div>
          <div style={barStyle}><div style={fill(dayPct)} /></div>
        </div>
        <div style={{ ...card, padding: 12 }}>
          <span style={lab}>Today — est. cost</span>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{usd(spend.costUsd)} <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>/ ${budget.maxEstDailyCostUsd}</span></div>
          <div style={barStyle}><div style={fill(costPct)} /></div>
        </div>
        <Stat label="Retries today" value={`${spend.retries}`} />
        <Stat label="Retries prevented" value={`${spend.preventedRetries}`} good={spend.preventedRetries > 0} />
        <Stat label="Budget-blocked" value={`${spend.budgetBlocked}`} />
        <Stat label="All-time calls" value={`${usage.totalInferenceAttempts}`} sub={`${usd(usage.estTotalCostUsd)} total`} />
      </div>

      {usage.missingCost > 0 && (
        <p style={{ fontSize: 10.5, color: 'var(--muted)', margin: 0 }}>
          {usage.missingCost} completed evaluation(s) reported no token usage — their cost is recorded as unknown, never guessed.
        </p>
      )}
      {Object.keys(usage.byFailureCategory).length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {Object.entries(usage.byFailureCategory).map(([k, v]) => (
            <span key={k} style={{ fontSize: 10.5, padding: '2px 7px', borderRadius: 6, border: '1px solid var(--line)', color: 'var(--muted)' }}>{nice(k)}: {v}</span>
          ))}
        </div>
      )}
      {budget.killed && <p style={{ fontSize: 10.5, color: '#f87171', margin: 0 }}>Forced off by the SHADOW_V2_KILL_SWITCH environment flag — the runtime toggle cannot re-enable it.</p>}
    </div>
  )
}
