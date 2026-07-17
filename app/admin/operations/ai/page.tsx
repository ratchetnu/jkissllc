'use client'

// ── AI Command Center — Overview (the calm landing) ──────────────────────────
// The one screen that answers: how healthy is my AI, what needs attention, what next, what's
// it costing, is V2 improving, is production safe. Deliberately NARROW — it reuses the
// consolidated /api/admin/ai-overview (one request, zero AI) and links into the deep sections
// rather than reproducing them. No dashboard wall.

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import OperationsShell from '../OperationsShell'
import AICommandShell, { aiCard, aiLabel, AIStat, AISkeleton, AIError } from './AICommandShell'

const READINESS: Record<string, { c: string; label: string }> = {
  NOT_READY: { c: '#f87171', label: 'Not ready' },
  PILOT_READY: { c: '#fbbf24', label: 'Pilot ready' },
  LIMITED_PRODUCTION: { c: '#a3e635', label: 'Limited production' },
  PRODUCTION_READY: { c: '#34d399', label: 'Production ready' },
}
const REC_COLOR: Record<string, string> = { action: '#f87171', watch: '#fbbf24', info: '#93c5fd' }
const usd = (n?: number | null) => (typeof n === 'number' ? `$${n.toFixed(n % 1 ? 2 : 0)}` : '—')
const pct = (n?: number | null) => (typeof n === 'number' ? `${n}%` : '—')

type Payload = {
  enabled: boolean; reason?: string
  customerFacing?: string; shadowMode?: string
  readiness?: { tier: string; score: number; sampleSize: number; reasons: string[]; blockers: string[] }
  groundTruth?: { recorded: number; completed: number; coveragePct: number; avgImprovementPct: number | null; v2WinPct: number | null }
  usage?: { evalsToday: number; costTodayUsd: number; budget: { maxEvalsPerDay: number; maxEstDailyCostUsd: number; killed: boolean }; killed: boolean; spendAllowed: boolean; spendBlockReason: string | null }
  attention?: { jobsWaiting: number; jobsProcessing: number; needingReview: number; awaitingGroundTruth: number; failed: number }
  recommendation?: { severity: string; message: string; evidence: string } | null
  health?: { shadowWorker: boolean; selectedOnly: boolean; shadowAlerting: boolean; inferenceHalted: boolean; spendAllowed: boolean }
}

export default function AIOverviewPage() {
  return <Suspense fallback={null}><OperationsShell><AICommandShell section="overview" title="Overview"><Overview /></AICommandShell></OperationsShell></Suspense>
}

function Overview() {
  const [res, setRes] = useState<{ payload: Payload | null; err: string } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const c = new AbortController()
    const done = (payload: Payload | null, err: string) => setRes({ payload, err })
    fetch('/api/admin/ai-overview', { credentials: 'same-origin', signal: c.signal })
      .then(async (r) => {
        if (r.status === 401 || r.status === 403) return done(null, 'Owner access required.')
        done(await r.json(), '')
      })
      .catch((e) => { if ((e as { name?: string })?.name !== 'AbortError') done(null, 'Could not load the AI overview.') })
    return () => c.abort()
  }, [reloadKey])

  if (!res) return <AISkeleton rows={4} />
  if (res.err) return <AIError message={res.err} onRetry={() => setReloadKey((k) => k + 1)} />
  const d = res.payload
  if (d && !d.enabled) return (
    <div style={{ ...aiCard, display: 'grid', gap: 6 }}>
      <strong style={{ fontSize: 15 }}>AI evaluation is off</strong>
      <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>{d.reason ?? 'SHADOW_ANALYTICS_ENABLED is off'}. Enable it to populate the Command Center.</p>
    </div>
  )
  if (!d?.readiness || !d.groundTruth || !d.usage || !d.attention || !d.health) return <AISkeleton rows={4} />

  const rd = READINESS[d.readiness.tier] ?? { c: 'var(--muted)', label: d.readiness.tier }
  const attn = d.attention
  const actionCount = attn.awaitingGroundTruth + attn.needingReview + attn.failed

  return (
    <>
      {/* Row 1 — the safety truth + readiness, stated plainly */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <div style={{ ...aiCard, display: 'grid', gap: 8 }}>
          <span style={aiLabel}>Customer-facing model</span>
          <div style={{ fontSize: 22, fontWeight: 800 }}>V1 <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)' }}>production</span></div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>V2 runs in shadow only. No customer sees V2.</div>
        </div>
        <div style={{ ...aiCard, display: 'grid', gap: 8, borderColor: `${rd.c}44` }}>
          <span style={aiLabel}>Model readiness</span>
          <div style={{ fontSize: 20, fontWeight: 800, color: rd.c }}>{rd.label}</div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>score {d.readiness.score} · {d.readiness.sampleSize} verified evaluations</div>
        </div>
        <div style={{ ...aiCard, display: 'grid', gap: 8 }}>
          <span style={aiLabel}>System</span>
          <div style={{ fontSize: 15, fontWeight: 700, color: d.health.inferenceHalted ? '#f87171' : d.usage.spendAllowed ? '#34d399' : '#fbbf24' }}>
            {d.health.inferenceHalted ? 'Inference halted' : d.usage.spendAllowed ? 'Healthy' : 'Budget reached'}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Flag on={d.health.selectedOnly} label="Selected-only" />
            <Flag on={!d.health.shadowAlerting} label="Alerting off" muted />
            <Flag on={d.health.shadowWorker} label="Worker" />
          </div>
        </div>
      </div>

      {/* Row 2 — what needs attention, with one guided entry point */}
      <div style={{ ...aiCard, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14 }}>
        <div style={{ flex: '1 1 220px' }}>
          <span style={aiLabel}>Needs your attention</span>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            {actionCount === 0 ? 'Nothing waiting — the model is caught up.' : `${actionCount} item(s) waiting on you.`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          <Mini label="Awaiting ground truth" value={attn.awaitingGroundTruth} tone={attn.awaitingGroundTruth > 0 ? '#a3e635' : undefined} />
          <Mini label="Needs review" value={attn.needingReview} tone={attn.needingReview > 0 ? '#fbbf24' : undefined} />
          <Mini label="Failed" value={attn.failed} tone={attn.failed > 0 ? '#f87171' : undefined} />
          <Mini label="Waiting / running" value={attn.jobsWaiting + attn.jobsProcessing} />
        </div>
        <Link href="/admin/operations/ai/queue" style={{ fontSize: 12.5, fontWeight: 700, padding: '9px 15px', borderRadius: 11, border: '1px solid var(--line)', textDecoration: 'none', color: 'var(--text)', background: 'color-mix(in srgb, var(--text) 6%, transparent)' }}>
          Review next →
        </Link>
      </div>

      {/* Row 3 — progress + cost, the two numbers that trend */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <AIStat label="Ground truth" value={`${d.groundTruth.recorded}/${d.groundTruth.completed}`} sub={`${pct(d.groundTruth.coveragePct)} coverage`} />
        <AIStat label="V2 improvement" value={pct(d.groundTruth.avgImprovementPct)} tone={(d.groundTruth.avgImprovementPct ?? 0) >= 0 ? '#34d399' : '#f87171'} sub={`V2 wins ${pct(d.groundTruth.v2WinPct)}`} />
        <AIStat label="Today — evaluations" value={`${d.usage.evalsToday}`} sub={`of ${d.usage.budget.maxEvalsPerDay} cap`} />
        <AIStat label="Today — cost" value={usd(d.usage.costTodayUsd)} sub={`of ${usd(d.usage.budget.maxEstDailyCostUsd)} cap`} />
      </div>

      {/* Row 4 — the single most important recommendation, and where to act */}
      {d.recommendation && (
        <div style={{ ...aiCard, display: 'grid', gap: 8 }}>
          <span style={aiLabel}>Recommended next step</span>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span style={{ fontSize: 9.5, fontWeight: 800, padding: '2px 7px', borderRadius: 5, marginTop: 2, color: REC_COLOR[d.recommendation.severity], background: `color-mix(in srgb, ${REC_COLOR[d.recommendation.severity]} 15%, transparent)`, border: `1px solid color-mix(in srgb, ${REC_COLOR[d.recommendation.severity]} 35%, transparent)` }}>{d.recommendation.severity.toUpperCase()}</span>
            <div>
              <div style={{ fontSize: 13.5 }}>{d.recommendation.message}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{d.recommendation.evidence}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
            <Link href="/admin/operations/ai/performance" style={sectionLink}>See performance →</Link>
            <Link href="/admin/operations/ai/alerts" style={sectionLink}>Readiness detail →</Link>
          </div>
        </div>
      )}

      {d.readiness.blockers.length > 0 && (
        <div style={{ ...aiCard, borderColor: '#f8717155' }}>
          <span style={aiLabel}>Blocking promotion</span>
          {d.readiness.blockers.map((b, i) => <div key={i} style={{ fontSize: 12.5, color: '#f87171' }}>⚠ {b}</div>)}
        </div>
      )}
    </>
  )
}

const sectionLink: React.CSSProperties = { fontSize: 11.5, fontWeight: 600, color: '#93c5fd', textDecoration: 'none' }

function Mini({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div>
      <div style={{ fontSize: 9.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: tone ?? 'var(--text)' }}>{value}</div>
    </div>
  )
}
function Flag({ on, label, muted }: { on: boolean; label: string; muted?: boolean }) {
  const c = muted ? '#94a3b8' : on ? '#34d399' : '#f87171'
  return <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 999, color: c, background: `color-mix(in srgb, ${c} 14%, transparent)` }}>{label}</span>
}
