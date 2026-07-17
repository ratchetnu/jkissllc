'use client'

// ── AI Command Center — Performance (canonical) ──────────────────────────────
// The calm accuracy story: is V2 improving, is it beating V1, how often, by how much, where is
// it weak, is there enough recent evidence, is readiness improving. Reuses the pure
// /api/admin/shadow-learning payload (ZERO AI). Progressive disclosure — a health summary up
// top, deeper analytics behind <details>. Every rate carries its denominator.

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import OperationsShell from '../../OperationsShell'
import AICommandShell, { aiCard, aiLabel, AIStat, AISkeleton, AIError, AIEmpty } from '../AICommandShell'

const V2C = '#34d399', V1C = '#f87171', TIEC = '#94a3b8'
const pct = (n?: number | null) => (typeof n === 'number' ? `${n}%` : '—')
const usd = (n?: number | null) => (typeof n === 'number' ? `$${n.toFixed(n % 1 ? 2 : 0)}` : '—')
const READINESS: Record<string, { c: string; label: string }> = {
  NOT_READY: { c: '#f87171', label: 'Not ready' }, PILOT_READY: { c: '#fbbf24', label: 'Pilot ready' },
  LIMITED_PRODUCTION: { c: '#a3e635', label: 'Limited production' }, PRODUCTION_READY: { c: '#34d399', label: 'Production ready' },
}

type Overview = { totalEvaluations: number; groundTruthsRecorded: number; groundTruthCoverage: number; avgV1ErrorPct: number | null; avgV2ErrorPct: number | null; avgImprovementPct: number | null; v2WinPct: number | null; v1WinPct: number | null; tiePct: number | null; avgErrorUsd: number | null; medianErrorPct: number | null }
type Row = { key: string; label: string; sampleSize: number; avgErrorPct: number | null; medianErrorPct: number | null; avgImprovementPct: number | null; winRatePct: number | null }
type Cat = { category: string; label: string; count: number; avgErrorPct: number | null; v2WinPct: number | null }
type Readiness = { tier: string; score: number; sampleSize: number; groundTruthCoverage: number; failureRatePct: number; avgImprovementPct: number | null; reasons: string[]; blockers: string[] }
type TB = { label: string; count: number; avgV1ErrorPct: number | null; avgV2ErrorPct: number | null }
type Facet = { value: string; label: string; count: number }
type Payload = {
  enabled: boolean; reason?: string; sampled?: number; matched?: number
  overview?: Overview; readiness?: Readiness; categories?: string[]
  facets?: { models: Facet[] }
  leaderboards?: { byPromptVersion: Row[]; byModel: Row[] }
  heatmap?: Cat[]; trends?: { weekly: TB[]; monthly: TB[] }
}

const BOARDS = [{ k: 'byPromptVersion', label: 'Prompt version' }, { k: 'byModel', label: 'Model' }] as const

export default function PerformancePage() {
  return <Suspense fallback={null}><OperationsShell><AICommandShell section="performance" title="Performance"><Perf /></AICommandShell></OperationsShell></Suspense>
}

function Perf() {
  const router = useRouter(); const pathname = usePathname(); const sp = useSearchParams()
  const [board, setBoard] = useState<typeof BOARDS[number]['k']>('byPromptVersion')
  const [trend, setTrend] = useState<'weekly' | 'monthly'>('weekly')
  // Performance filters — every one reshapes the aggregates (API narrows jobs), zero AI.
  const [category, setCategory] = useState(sp.get('category') ?? '')
  const [model, setModel] = useState(sp.get('model') ?? '')
  const [reviewed, setReviewed] = useState(sp.get('reviewed') ?? '')
  const [gt, setGt] = useState(sp.get('gt') ?? '')
  const [fromD, setFromD] = useState(sp.get('fromD') ?? '')
  const [toD, setToD] = useState(sp.get('toD') ?? '')

  const dayMs = (d: string, end = false) => { const t = Date.parse(end ? `${d}T23:59:59` : `${d}T00:00:00`); return Number.isFinite(t) ? t : undefined }
  const query = useMemo(() => {
    const p = new URLSearchParams()
    if (category) p.set('category', category)
    if (model) p.set('model', model)
    if (reviewed) p.set('reviewed', reviewed)
    if (gt) p.set('gt', gt)
    const f = fromD ? dayMs(fromD) : undefined, t = toD ? dayMs(toD, true) : undefined
    if (f != null) p.set('from', String(f))
    if (t != null) p.set('to', String(t))
    const q = p.toString()
    return q ? `?${q}` : ''
  }, [category, model, reviewed, gt, fromD, toD])

  const hasFilter = !!(category || model || reviewed || gt || fromD || toD)
  const resetFilters = () => { setCategory(''); setModel(''); setReviewed(''); setGt(''); setFromD(''); setToD('') }
  const [res, setRes] = useState<{ key: string; payload: Payload | null; err: string } | null>(null)
  useEffect(() => {
    const c = new AbortController()
    const done = (payload: Payload | null, err: string) => setRes({ key: query, payload, err })
    fetch(`/api/admin/shadow-learning${query}`, { credentials: 'same-origin', signal: c.signal })
      .then(async (r) => { if (r.status === 401 || r.status === 403) return done(null, 'Owner access required.'); done(await r.json(), '') })
      .catch((e) => { if ((e as { name?: string })?.name !== 'AbortError') done(null, 'Could not load performance.') })
    return () => c.abort()
  }, [query])
  useEffect(() => {
    const p = new URLSearchParams(query.replace(/^\?/, ''))
    if (fromD) p.set('fromD', fromD); if (toD) p.set('toD', toD)
    router.replace(`${pathname}${p.toString() ? `?${p}` : ''}`, { scroll: false })
  }, [query, fromD, toD, pathname, router])

  const loading = res?.key !== query
  const data = res?.payload ?? null
  const err = res?.err ?? ''

  if (err) return <AIError message={err} />
  if (!res || loading) return <AISkeleton rows={4} />
  if (data && !data.enabled) return <AIEmpty title="AI evaluation is off" detail={data.reason ?? 'Enable SHADOW_ANALYTICS_ENABLED to see performance.'} />
  const o = data?.overview; const r = data?.readiness
  if (!o || !r) return <AISkeleton rows={4} />
  const verified = o.groundTruthsRecorded

  const inputStyle: React.CSSProperties = { padding: '6px 9px', background: 'transparent', border: '1px solid var(--line)', borderRadius: 8, color: 'var(--text)', fontSize: 11.5 }
  const selectStyle: React.CSSProperties = { padding: '6px 9px', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, color: 'var(--text)', fontSize: 11.5 }
  return (
    <>
      {/* Filters — reshape every aggregate below; zero AI */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={selectStyle} aria-label="Category">
          <option value="">Category: all</option>
          {(data?.categories ?? []).map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
        </select>
        {(data?.facets?.models?.length ?? 0) > 1 && (
          <select value={model} onChange={(e) => setModel(e.target.value)} style={selectStyle} aria-label="Model version">
            <option value="">Model: all</option>
            {data?.facets?.models.map((m) => <option key={m.value} value={m.value}>{m.label} ({m.count})</option>)}
          </select>
        )}
        <select value={reviewed} onChange={(e) => setReviewed(e.target.value)} style={selectStyle} aria-label="Reviewed">
          <option value="">Reviewed: any</option><option value="1">Reviewed</option><option value="0">Unreviewed</option>
        </select>
        <select value={gt} onChange={(e) => setGt(e.target.value)} style={selectStyle} aria-label="Ground truth">
          <option value="">Ground truth: any</option><option value="1">Has ground truth</option><option value="0">Missing</option>
        </select>
        <label style={{ fontSize: 11, color: 'var(--muted)' }}>From <input type="date" value={fromD} onChange={(e) => setFromD(e.target.value)} style={{ ...inputStyle, colorScheme: 'light dark' }} /></label>
        <label style={{ fontSize: 11, color: 'var(--muted)' }}>To <input type="date" value={toD} onChange={(e) => setToD(e.target.value)} style={{ ...inputStyle, colorScheme: 'light dark' }} /></label>
        {hasFilter && <button onClick={resetFilters} style={{ ...inputStyle, cursor: 'pointer', fontWeight: 700 }}>Reset</button>}
        {hasFilter && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{data?.matched ?? 0} of {data?.sampled ?? 0} shown</span>}
      </div>

      {/* Health summary — the decision line, calm */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <div style={{ ...aiCard, borderColor: `${(READINESS[r.tier]?.c ?? 'var(--line)')}44` }}>
          <span style={aiLabel}>Readiness</span>
          <div style={{ fontSize: 18, fontWeight: 800, color: READINESS[r.tier]?.c }}>{READINESS[r.tier]?.label ?? r.tier}</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>score {r.score}</div>
        </div>
        <AIStat label="V2 improvement" value={pct(o.avgImprovementPct)} tone={(o.avgImprovementPct ?? 0) >= 0 ? V2C : V1C} sub={`over ${verified} verified`} />
        <AIStat label="V2 win rate" value={pct(o.v2WinPct)} sub={`of ${verified} judged`} />
        <AIStat label="Evidence" value={`${verified}`} sub={`${pct(o.groundTruthCoverage)} of ${o.totalEvaluations} completed`} />
        <AIStat label="Failure rate" value={pct(r.failureRatePct)} tone={r.failureRatePct > 10 ? V1C : undefined} />
      </div>

      {verified === 0 ? (
        <AIEmpty title="No benchmarked evaluations yet" detail="Record ground truth in the Evaluation Queue to unlock the accuracy comparison." />
      ) : (
        <>
          {/* V2 vs V1 head-to-head */}
          <div style={aiCard}>
            <span style={aiLabel}>V2 vs V1 — head-to-head vs ground truth</span>
            <WinBar v2={o.v2WinPct} v1={o.v1WinPct} tie={o.tiePct} />
            <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11.5, flexWrap: 'wrap' }}>
              <Leg c={V2C} label={`V2 wins ${pct(o.v2WinPct)}`} /><Leg c={TIEC} label={`Tie ${pct(o.tiePct)}`} /><Leg c={V1C} label={`V1 wins ${pct(o.v1WinPct)}`} />
              <span style={{ marginLeft: 'auto', color: 'var(--muted)' }}>V1 avg error {pct(o.avgV1ErrorPct)} · V2 avg error {pct(o.avgV2ErrorPct)} · median {pct(o.medianErrorPct)} · {usd(o.avgErrorUsd)} avg $</span>
            </div>
          </div>

          {/* Recent trend */}
          <div style={{ ...aiCard, display: 'grid', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={aiLabel}>Error trend (lower is better)</span>
              <div style={{ display: 'inline-flex', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
                {(['weekly', 'monthly'] as const).map((t) => <button key={t} onClick={() => setTrend(t)} style={{ fontSize: 11.5, fontWeight: 700, padding: '5px 11px', border: 'none', cursor: 'pointer', background: trend === t ? 'var(--text)' : 'transparent', color: trend === t ? 'var(--card)' : 'var(--muted)' }}>{t}</button>)}
              </div>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 12, fontSize: 11 }}><Leg c={V1C} label="V1" /><Leg c={V2C} label="V2" /></span>
            </div>
            <TrendChart buckets={data?.trends?.[trend] ?? []} />
          </div>

          {/* Drill-down — collapsed by default */}
          <Details summary="Version leaderboard">
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              {BOARDS.map((b) => <button key={b.k} onClick={() => setBoard(b.k)} style={{ fontSize: 11.5, fontWeight: 700, padding: '5px 11px', borderRadius: 8, cursor: 'pointer', border: `1px solid ${board === b.k ? 'var(--text)' : 'var(--line)'}`, background: board === b.k ? 'var(--text)' : 'transparent', color: board === b.k ? 'var(--card)' : 'var(--muted)' }}>{b.label}</button>)}
            </div>
            <Leaderboard rows={data?.leaderboards?.[board] ?? []} />
          </Details>

          <Details summary="Error by category (where V2 is weak)">
            <Heatmap cats={data?.heatmap ?? []} />
          </Details>
        </>
      )}

      {r.blockers.length > 0 && (
        <div style={{ ...aiCard, borderColor: '#f8717155' }}>
          <span style={aiLabel}>Blocking promotion</span>
          {r.blockers.map((b, i) => <div key={i} style={{ fontSize: 12.5, color: '#f87171' }}>⚠ {b}</div>)}
        </div>
      )}
      <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>
        Analytics only — this page runs no AI. Detailed reviewed examples live in <Link href="/admin/operations/ai/learning" style={{ color: '#93c5fd', textDecoration: 'none' }}>Review &amp; Learning</Link>.
      </p>
    </>
  )
}

function Details({ summary, children }: { summary: string; children: React.ReactNode }) {
  return (
    <details style={{ ...aiCard }}>
      <summary style={{ cursor: 'pointer', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', listStyle: 'revert' }}>{summary}</summary>
      <div style={{ marginTop: 12 }}>{children}</div>
    </details>
  )
}
function Leg({ c, label }: { c: string; label: string }) { return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--muted)' }}><span style={{ width: 9, height: 9, borderRadius: 2, background: c }} />{label}</span> }
function WinBar({ v2, v1, tie }: { v2: number | null; v1: number | null; tie: number | null }) {
  const a = v2 ?? 0, t = tie ?? 0, b = v1 ?? 0
  if (a + t + b === 0) return <div style={{ fontSize: 12, color: 'var(--muted)' }}>No head-to-head yet.</div>
  return <div style={{ display: 'flex', height: 22, borderRadius: 6, overflow: 'hidden', gap: 2 }}>{a > 0 && <div style={{ width: `${a}%`, background: V2C }} title={`V2 ${a}%`} />}{t > 0 && <div style={{ width: `${t}%`, background: TIEC }} />}{b > 0 && <div style={{ width: `${b}%`, background: V1C }} />}</div>
}
function TrendChart({ buckets }: { buckets: TB[] }) {
  const W = 640, H = 140, PAD = 24
  if (buckets.filter((b) => b.count > 0).length < 2) return <div style={{ fontSize: 12, color: 'var(--muted)' }}>Not enough dated evaluations to chart a trend.</div>
  const all = buckets.flatMap((b) => [b.avgV1ErrorPct, b.avgV2ErrorPct]).filter((x): x is number => typeof x === 'number')
  const max = Math.max(10, ...all)
  const x = (i: number) => PAD + (i / Math.max(1, buckets.length - 1)) * (W - 2 * PAD)
  const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD)
  const path = (key: 'avgV1ErrorPct' | 'avgV2ErrorPct') => buckets.map((b, i) => ({ i, v: b[key] })).filter((p): p is { i: number; v: number } => typeof p.v === 'number').map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i)},${y(p.v)}`).join(' ')
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 420 }} role="img" aria-label="V1 and V2 error trend">
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
  if (!rows.length) return <div style={{ fontSize: 12, color: 'var(--muted)' }}>No benchmarked evaluations to rank.</div>
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 420 }}>
        <thead><tr style={{ color: 'var(--muted)', textAlign: 'left' }}>{['Version', 'n', 'Avg err', 'Median', 'Improvement', 'Win rate'].map((h) => <th key={h} style={{ padding: '4px 8px', fontSize: 10, textTransform: 'uppercase' }}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r) => <tr key={r.key} style={{ borderTop: '1px solid var(--line)' }}><td style={{ padding: '6px 8px', fontWeight: 700 }}>{r.label}</td><td style={{ padding: '6px 8px' }}>{r.sampleSize}</td><td style={{ padding: '6px 8px' }}>{pct(r.avgErrorPct)}</td><td style={{ padding: '6px 8px' }}>{pct(r.medianErrorPct)}</td><td style={{ padding: '6px 8px', color: (r.avgImprovementPct ?? 0) >= 0 ? V2C : V1C }}>{pct(r.avgImprovementPct)}</td><td style={{ padding: '6px 8px' }}>{pct(r.winRatePct)}</td></tr>)}</tbody>
      </table>
    </div>
  )
}
function Heatmap({ cats }: { cats: Cat[] }) {
  if (!cats.length) return <div style={{ fontSize: 12, color: 'var(--muted)' }}>No categorized evaluations yet.</div>
  const max = Math.max(1, ...cats.map((c) => c.avgErrorPct ?? 0))
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {cats.map((c) => {
        const heat = (c.avgErrorPct ?? 0) >= 20 ? V1C : (c.avgErrorPct ?? 0) >= 10 ? '#fbbf24' : V2C
        return (
          <div key={c.category} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5 }}>
            <span style={{ width: 130, flexShrink: 0 }}>{c.label}</span>
            <div style={{ flex: 1, height: 15, background: 'var(--line)', borderRadius: 4, overflow: 'hidden' }}><div style={{ width: `${((c.avgErrorPct ?? 0) / max) * 100}%`, height: '100%', background: heat }} title={`${c.label}: ${pct(c.avgErrorPct)}`} /></div>
            <span style={{ width: 50, textAlign: 'right' }}>{pct(c.avgErrorPct)}</span>
            <span style={{ width: 80, textAlign: 'right', color: 'var(--muted)' }}>{c.count} eval</span>
          </div>
        )
      })}
    </div>
  )
}
