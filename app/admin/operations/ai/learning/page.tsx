'use client'

// ── Operion — AI Learning platform (owner-only) ──────────────────────────────
// Reads GET /api/admin/shadow-learning (SHADOW_ANALYTICS_ENABLED-gated). EVERYTHING here is
// derived from stored evaluations by the pure learning engine — this page triggers ZERO AI,
// no inference, and changes no customer behavior. Self-contained inline SVG, admin CSS vars,
// theme-aware, responsive. Colors follow polarity (V2-better = green, V1-better = red) and are
// always paired with a label, never color alone.

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import OperationsShell from '../../OperationsShell'

const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 16 }
const lab: React.CSSProperties = { display: 'block', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', marginBottom: 4 }
const seg: React.CSSProperties = { fontSize: 11.5, fontWeight: 700, padding: '6px 12px', cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--muted)' }
const selectStyle: React.CSSProperties = { padding: '6px 9px', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, color: 'var(--text)', fontSize: 11.5 }
const inputStyle: React.CSSProperties = { padding: '6px 9px', background: 'transparent', border: '1px solid var(--line)', borderRadius: 8, color: 'var(--text)', fontSize: 11.5 }

const V2C = '#34d399', V1C = '#f87171', TIEC = '#94a3b8', NEUTRAL = '#93c5fd'
const nice = (s: string) => s.replace(/_/g, ' ')
const pct = (n?: number | null) => (typeof n === 'number' ? `${n}%` : '—')
const usd = (n?: number | null) => (typeof n === 'number' ? `$${n.toFixed(n % 1 ? 2 : 0)}` : '—')

const READINESS: Record<string, { c: string; label: string }> = {
  NOT_READY: { c: '#f87171', label: 'Not ready' },
  PILOT_READY: { c: '#fbbf24', label: 'Pilot ready' },
  LIMITED_PRODUCTION: { c: '#a3e635', label: 'Limited production' },
  PRODUCTION_READY: { c: '#34d399', label: 'Production ready' },
}
const REC_COLOR: Record<string, string> = { action: '#f87171', watch: '#fbbf24', info: '#93c5fd' }

type Overview = { totalEvaluations: number; groundTruthsRecorded: number; groundTruthCoverage: number; avgV1ErrorPct: number | null; avgV2ErrorPct: number | null; avgImprovementPct: number | null; v2WinPct: number | null; v1WinPct: number | null; tiePct: number | null; avgErrorUsd: number | null; avgErrorPct: number | null; medianErrorPct: number | null; confidenceDistribution: { high: number; medium: number; low: number } }
type Row = { key: string; label: string; sampleSize: number; avgErrorPct: number | null; medianErrorPct: number | null; avgImprovementPct: number | null; winRatePct: number | null; avgConfidence: number | null }
type Cat = { category: string; label: string; count: number; avgErrorPct: number | null; v2WinPct: number | null; v1WinPct: number | null }
type Readiness = { tier: string; score: number; sampleSize: number; groundTruthCoverage: number; avgImprovementPct: number | null; avgConfidence: number | null; failureRatePct: number; retryRatePct: number; evaluationCoverage: number; reasons: string[]; blockers: string[] }
type Rec = { severity: string; message: string; evidence: string }
type TB = { label: string; count: number; avgV1ErrorPct: number | null; avgV2ErrorPct: number | null; avgImprovementPct: number | null; v2WinPct: number | null }
type ExplorerRow = { bookingId: string; bookingNumber?: string; at: number; model: string; promptVersion?: number; groundTruthUsd: number; v1Usd: number | null; v2Usd: number; v1ErrorPct: number | null; v2ErrorPct: number; improvementPct: number | null; winner: string; confidence: number | null; categories: string[] }
type Payload = {
  enabled: boolean; reason?: string; sampled?: number; categories?: string[]
  facets?: { models: { value: string; label: string; count: number }[]; deployments: { value: string; label: string; count: number }[] }
  overview?: Overview; leaderboards?: { byDeployment: Row[]; byPromptVersion: Row[]; byModel: Row[]; byEstimatorVersion: Row[] }
  heatmap?: Cat[]; readiness?: Readiness; recommendations?: Rec[]
  trends?: { weekly: TB[]; monthly: TB[]; rolling30d: { label: string; count: number; avgImprovementPct: number | null }[] }
  explorer?: { matched: number; rows: ExplorerRow[] }
}

const BOARDS = [{ k: 'byPromptVersion', label: 'Prompt version' }, { k: 'byModel', label: 'Model' }, { k: 'byDeployment', label: 'Deployment' }, { k: 'byEstimatorVersion', label: 'Estimator' }] as const

export default function LearningPage() {
  return <Suspense fallback={null}><Inner /></Suspense>
}

function Inner() {
  const router = useRouter(); const pathname = usePathname(); const sp = useSearchParams()
  const [model, setModel] = useState(sp.get('model') ?? '')
  const [promptVersion, setPromptVersion] = useState(sp.get('promptVersion') ?? '')
  const [category, setCategory] = useState(sp.get('category') ?? '')
  const [outcome, setOutcome] = useState(sp.get('outcome') ?? '')
  const [qDraft, setQDraft] = useState(sp.get('q') ?? '')
  const [board, setBoard] = useState<typeof BOARDS[number]['k']>('byPromptVersion')
  const [trend, setTrend] = useState<'weekly' | 'monthly'>('weekly')

  const [q, setQ] = useState(qDraft)
  useEffect(() => { const t = setTimeout(() => setQ(qDraft), 400); return () => clearTimeout(t) }, [qDraft])

  // One keyed result for the whole request; loading is DERIVED from the key, so the fetch
  // effect never calls setState synchronously (which would cascade renders) and a stale
  // response can't be mistaken for the current one.
  const [res, setRes] = useState<{ key: string; payload: Payload | null; err: string } | null>(null)

  const query = useMemo(() => {
    const p = new URLSearchParams()
    if (model) p.set('model', model)
    if (promptVersion) p.set('promptVersion', promptVersion)
    if (category) p.set('category', category)
    if (outcome) p.set('outcome', outcome)
    if (q) p.set('q', q)
    return p.toString()
  }, [model, promptVersion, category, outcome, q])

  useEffect(() => {
    const c = new AbortController()
    const done = (payload: Payload | null, err: string) => setRes({ key: query, payload, err })
    fetch(`/api/admin/shadow-learning?${query}`, { credentials: 'same-origin', signal: c.signal })
      .then(async (r) => {
        if (r.status === 401 || r.status === 403) return done(null, 'Owner access required.')
        done(await r.json(), '')
      })
      .catch((e) => { if ((e as { name?: string })?.name !== 'AbortError') done(null, 'Could not load AI Learning.') })
    return () => c.abort()
  }, [query])
  useEffect(() => { router.replace(`${pathname}${query ? `?${query}` : ''}`, { scroll: false }) }, [query, pathname, router])

  const loading = res?.key !== query
  const data = res?.payload ?? null
  const err = res?.err ?? ''
  const o = data?.overview
  const r = data?.readiness

  return (
    <OperationsShell>
      <div style={{ display: 'grid', gap: 14, paddingBottom: 40 }}>
        <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>🎓 AI Learning</h1>
            <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--muted)' }}>Why estimates differ, and whether V2 is improving. Derived entirely from recorded evaluations — no AI is run here.</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <a href={`/api/admin/shadow-learning?${query}${query ? '&' : ''}format=csv`} style={{ ...seg, border: '1px solid var(--line)', borderRadius: 9, textDecoration: 'none', color: 'var(--text)' }}>Export CSV</a>
            <Link href="/admin/operations/ai/shadow" style={{ ...seg, border: '1px solid var(--line)', borderRadius: 9, textDecoration: 'none', color: 'var(--text)' }}>Shadow Analytics →</Link>
          </div>
        </header>

        {err && <div style={{ ...card, borderColor: '#f87171', color: '#f87171', fontSize: 13 }}>{err}</div>}
        {data && !data.enabled && <div style={{ ...card, fontSize: 13, color: 'var(--muted)' }}>{data.reason ?? 'SHADOW_ANALYTICS_ENABLED is off'}. Enable it to populate AI Learning.</div>}

        {data?.enabled && o && r && (
          <>
            {/* Readiness hero */}
            <div style={{ ...card, borderColor: READINESS[r.tier]?.c ?? 'var(--line)', display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
              <div>
                <span style={lab}>AI readiness</span>
                <div style={{ fontSize: 18, fontWeight: 800, color: READINESS[r.tier]?.c }}>{READINESS[r.tier]?.label ?? r.tier}</div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                score {r.score} · {r.sampleSize} verified · {pct(r.groundTruthCoverage)} coverage · improvement {pct(r.avgImprovementPct)} · failure {pct(r.failureRatePct)}
              </div>
              {(r.blockers.length > 0 || r.reasons.length > 0) && (
                <div style={{ flex: '1 1 260px', fontSize: 11.5 }}>
                  {r.blockers.map((b, i) => <div key={i} style={{ color: '#f87171' }}>⚠ {b}</div>)}
                  {r.reasons.map((x, i) => <div key={i} style={{ color: 'var(--muted)' }}>{x}</div>)}
                </div>
              )}
            </div>

            {/* Overview stat grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
              <Stat label="Evaluations" value={String(o.totalEvaluations)} sub={`${o.groundTruthsRecorded} benchmarked`} />
              <Stat label="Ground-truth coverage" value={pct(o.groundTruthCoverage)} />
              <Stat label="Avg V1 error" value={pct(o.avgV1ErrorPct)} tone={V1C} />
              <Stat label="Avg V2 error" value={pct(o.avgV2ErrorPct)} tone={V2C} />
              <Stat label="Avg improvement" value={pct(o.avgImprovementPct)} tone={(o.avgImprovementPct ?? 0) >= 0 ? V2C : V1C} sub="V1 err − V2 err" />
              <Stat label="Median error" value={pct(o.medianErrorPct)} />
              <Stat label="Avg $ error" value={usd(o.avgErrorUsd)} />
            </div>

            {/* Win/loss/tie bar — polarity, always labeled */}
            <div style={card}>
              <span style={lab}>Head-to-head vs ground truth</span>
              <WinBar v2={o.v2WinPct} v1={o.v1WinPct} tie={o.tiePct} />
              <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11.5, flexWrap: 'wrap' }}>
                <Legend c={V2C} label={`V2 wins ${pct(o.v2WinPct)}`} />
                <Legend c={TIEC} label={`Tie ${pct(o.tiePct)}`} />
                <Legend c={V1C} label={`V1 wins ${pct(o.v1WinPct)}`} />
              </div>
            </div>

            {/* Recommendations */}
            {(data.recommendations?.length ?? 0) > 0 && (
              <div style={{ ...card, display: 'grid', gap: 8 }}>
                <span style={lab}>Recommendations (deterministic — no AI)</span>
                {data.recommendations!.map((rec, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5 }}>
                    <span style={{ fontSize: 9.5, fontWeight: 800, padding: '2px 6px', borderRadius: 5, marginTop: 1, color: REC_COLOR[rec.severity], background: `color-mix(in srgb, ${REC_COLOR[rec.severity]} 15%, transparent)`, border: `1px solid color-mix(in srgb, ${REC_COLOR[rec.severity]} 35%, transparent)` }}>{rec.severity.toUpperCase()}</span>
                    <div><div>{rec.message}</div><div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{rec.evidence}</div></div>
                  </div>
                ))}
              </div>
            )}

            {/* Trends */}
            <div style={{ ...card, display: 'grid', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={lab}>Accuracy trend</span>
                <div style={{ display: 'inline-flex', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
                  {(['weekly', 'monthly'] as const).map((t) => (
                    <button key={t} onClick={() => setTrend(t)} style={{ ...seg, ...(trend === t ? { background: 'var(--text)', color: 'var(--card)' } : {}) }}>{t}</button>
                  ))}
                </div>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 14, fontSize: 11 }}>
                  <Legend c={V1C} label="V1 error" /><Legend c={V2C} label="V2 error" />
                </div>
              </div>
              <TrendChart buckets={data.trends?.[trend] ?? []} />
            </div>

            {/* Leaderboard */}
            <div style={{ ...card, display: 'grid', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={lab}>Performance leaderboard</span>
                <select value={board} onChange={(e) => setBoard(e.target.value as typeof board)} style={selectStyle}>
                  {BOARDS.map((b) => <option key={b.k} value={b.k}>{b.label}</option>)}
                </select>
              </div>
              <Leaderboard rows={data.leaderboards?.[board] ?? []} />
            </div>

            {/* Category heatmap */}
            {(data.heatmap?.length ?? 0) > 0 && (
              <div style={{ ...card, display: 'grid', gap: 8 }}>
                <span style={lab}>Problem areas by category (worst first)</span>
                <Heatmap cats={data.heatmap!} />
              </div>
            )}

            {/* Accuracy explorer */}
            <div style={{ ...card, display: 'grid', gap: 10 }}>
              <span style={lab}>Accuracy explorer</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <input value={qDraft} onChange={(e) => setQDraft(e.target.value)} placeholder="Search booking, note, category…" style={{ ...inputStyle, flex: '1 1 180px' }} />
                <select value={outcome} onChange={(e) => setOutcome(e.target.value)} style={selectStyle}>
                  <option value="">Outcome: all</option><option value="v2">V2 wins</option><option value="v1">V1 wins</option><option value="tie">Tie</option>
                </select>
                <select value={category} onChange={(e) => setCategory(e.target.value)} style={selectStyle}>
                  <option value="">Category: all</option>
                  {(data.categories ?? []).map((c) => <option key={c} value={c}>{nice(c)}</option>)}
                </select>
                {(data.facets?.models.length ?? 0) > 1 && (
                  <select value={model} onChange={(e) => setModel(e.target.value)} style={selectStyle}>
                    <option value="">Model: all</option>
                    {data.facets!.models.map((m) => <option key={m.value} value={m.value}>{m.label} ({m.count})</option>)}
                  </select>
                )}
                <input value={promptVersion} onChange={(e) => setPromptVersion(e.target.value.replace(/\D/g, ''))} placeholder="Prompt v#" style={{ ...inputStyle, width: 90 }} />
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>{loading ? 'Loading…' : `${data.explorer?.matched ?? 0} evaluation(s).`}</div>
              <ExplorerTable rows={data.explorer?.rows ?? []} />
            </div>
          </>
        )}
      </div>
    </OperationsShell>
  )
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return <div style={card}><span style={lab}>{label}</span><div style={{ fontSize: 20, fontWeight: 800, color: tone ?? 'var(--text)' }}>{value}</div>{sub && <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>}</div>
}
function Legend({ c, label }: { c: string; label: string }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--muted)' }}><span style={{ width: 9, height: 9, borderRadius: 2, background: c }} />{label}</span>
}
function WinBar({ v2, v1, tie }: { v2: number | null; v1: number | null; tie: number | null }) {
  const a = v2 ?? 0, t = tie ?? 0, b = v1 ?? 0
  if (a + t + b === 0) return <div style={{ fontSize: 12, color: 'var(--muted)' }}>No head-to-head evaluations yet.</div>
  return (
    <div style={{ display: 'flex', height: 22, borderRadius: 6, overflow: 'hidden', gap: 2 }}>
      {a > 0 && <div style={{ width: `${a}%`, background: V2C }} title={`V2 wins ${a}%`} />}
      {t > 0 && <div style={{ width: `${t}%`, background: TIEC }} title={`Tie ${t}%`} />}
      {b > 0 && <div style={{ width: `${b}%`, background: V1C }} title={`V1 wins ${b}%`} />}
    </div>
  )
}

// A twin-line trend: V1 error and V2 error per bucket (one y-axis, % error, lower is better).
function TrendChart({ buckets }: { buckets: TB[] }) {
  const W = 640, H = 150, PAD = 24
  const withData = buckets.filter((b) => b.count > 0)
  if (withData.length < 2) return <div style={{ fontSize: 12, color: 'var(--muted)' }}>Not enough dated evaluations to chart a trend yet.</div>
  const all = buckets.flatMap((b) => [b.avgV1ErrorPct, b.avgV2ErrorPct]).filter((x): x is number => typeof x === 'number')
  const max = Math.max(10, ...all)
  const x = (i: number) => PAD + (i / Math.max(1, buckets.length - 1)) * (W - 2 * PAD)
  const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD)
  // Build a polyline over the points that HAVE a value, so a gap (no evaluations that period)
  // doesn't yank the line to zero. First plotted point is a moveto, the rest lineto.
  const path = (key: 'avgV1ErrorPct' | 'avgV2ErrorPct') => {
    const pts = buckets.map((b, i) => ({ i, v: b[key] })).filter((p): p is { i: number; v: number } => typeof p.v === 'number')
    return pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i)},${y(p.v)}`).join(' ')
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 420 }} role="img" aria-label="Accuracy trend: V1 and V2 error per period">
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="var(--line)" />
        <path d={path('avgV1ErrorPct')} fill="none" stroke={V1C} strokeWidth={2} />
        <path d={path('avgV2ErrorPct')} fill="none" stroke={V2C} strokeWidth={2} />
        {buckets.map((b, i) => <text key={i} x={x(i)} y={H - 6} fontSize={8} fill="var(--muted)" textAnchor="middle">{b.label}</text>)}
        <text x={PAD} y={12} fontSize={8} fill="var(--muted)">{max}% err</text>
      </svg>
    </div>
  )
}

function Leaderboard({ rows }: { rows: Row[] }) {
  if (!rows.length) return <div style={{ fontSize: 12, color: 'var(--muted)' }}>No benchmarked evaluations to rank yet.</div>
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 460 }}>
        <thead><tr style={{ color: 'var(--muted)', textAlign: 'left' }}>
          {['Version', 'n', 'Avg err', 'Median', 'Improvement', 'Win rate', 'Confidence'].map((h) => <th key={h} style={{ padding: '4px 8px', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.04em' }}>{h}</th>)}
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} style={{ borderTop: '1px solid var(--line)' }}>
              <td style={{ padding: '6px 8px', fontWeight: 700 }}>{r.label}</td>
              <td style={{ padding: '6px 8px' }}>{r.sampleSize}</td>
              <td style={{ padding: '6px 8px' }}>{pct(r.avgErrorPct)}</td>
              <td style={{ padding: '6px 8px' }}>{pct(r.medianErrorPct)}</td>
              <td style={{ padding: '6px 8px', color: (r.avgImprovementPct ?? 0) >= 0 ? V2C : V1C }}>{pct(r.avgImprovementPct)}</td>
              <td style={{ padding: '6px 8px' }}>{pct(r.winRatePct)}</td>
              <td style={{ padding: '6px 8px' }}>{r.avgConfidence != null ? `${Math.round(r.avgConfidence * 100)}%` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Heatmap({ cats }: { cats: Cat[] }) {
  const max = Math.max(1, ...cats.map((c) => c.avgErrorPct ?? 0))
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {cats.map((c) => {
        const w = ((c.avgErrorPct ?? 0) / max) * 100
        const heat = (c.avgErrorPct ?? 0) >= 20 ? V1C : (c.avgErrorPct ?? 0) >= 10 ? '#fbbf24' : V2C
        return (
          <div key={c.category} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5 }}>
            <span style={{ width: 130, flexShrink: 0 }}>{c.label}</span>
            <div style={{ flex: 1, height: 16, background: 'var(--line)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${w}%`, height: '100%', background: heat }} title={`${c.label}: ${pct(c.avgErrorPct)} avg error`} />
            </div>
            <span style={{ width: 52, textAlign: 'right' }}>{pct(c.avgErrorPct)}</span>
            <span style={{ width: 90, textAlign: 'right', color: 'var(--muted)' }}>{c.count} eval · V2 {pct(c.v2WinPct)}</span>
          </div>
        )
      })}
    </div>
  )
}

function ExplorerTable({ rows }: { rows: ExplorerRow[] }) {
  if (!rows.length) return <div style={{ fontSize: 12, color: 'var(--muted)' }}>No evaluations match.</div>
  const WIN: Record<string, { c: string; t: string }> = { v2: { c: V2C, t: 'V2' }, v1: { c: V1C, t: 'V1' }, tie: { c: TIEC, t: 'Tie' } }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 620 }}>
        <thead><tr style={{ color: 'var(--muted)', textAlign: 'left' }}>
          {['Booking', 'GT', 'V1', 'V2', 'V1 err', 'V2 err', 'Winner', 'Conf', 'Categories'].map((h) => <th key={h} style={{ padding: '4px 8px', fontSize: 10, textTransform: 'uppercase' }}>{h}</th>)}
        </tr></thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.bookingId} style={{ borderTop: '1px solid var(--line)' }}>
              <td style={{ padding: '6px 8px' }}><Link href={`/admin/operations/ai/shadow/${e.bookingId}`} style={{ color: NEUTRAL, textDecoration: 'none' }}>{e.bookingNumber ?? e.bookingId.slice(0, 8)}</Link></td>
              <td style={{ padding: '6px 8px' }}>{usd(e.groundTruthUsd)}</td>
              <td style={{ padding: '6px 8px' }}>{usd(e.v1Usd)}</td>
              <td style={{ padding: '6px 8px' }}>{usd(e.v2Usd)}</td>
              <td style={{ padding: '6px 8px' }}>{pct(e.v1ErrorPct)}</td>
              <td style={{ padding: '6px 8px' }}>{pct(e.v2ErrorPct)}</td>
              <td style={{ padding: '6px 8px', color: WIN[e.winner]?.c, fontWeight: 700 }}>{WIN[e.winner]?.t ?? e.winner}</td>
              <td style={{ padding: '6px 8px' }}>{e.confidence != null ? `${Math.round(e.confidence * 100)}%` : '—'}</td>
              <td style={{ padding: '6px 8px', color: 'var(--muted)' }}>{e.categories.map(nice).join(', ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
