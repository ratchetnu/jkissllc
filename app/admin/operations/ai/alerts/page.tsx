'use client'

// ── AI Command Center — Alerts & Readiness (canonical) ───────────────────────
// A LIVE, deterministic "what needs attention right now + is V2 ready" view. Reads
// /api/admin/ai-alerts, which derives alerts from CURRENT metrics via the pure deriveAiAlerts
// engine (ZERO AI, no persistence, no cron) and reuses learningReadiness. Distinct from the
// background alerting subsystem (dormant until SHADOW_ALERTING_ENABLED). Alerts link straight
// to the section that resolves them.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import OperationsShell from '../../OperationsShell'
import AICommandShell, { aiCard, aiLabel, AIStat, AISkeleton, AIError, AIEmpty } from '../AICommandShell'

const SEV: Record<string, { c: string; label: string }> = {
  critical: { c: '#f87171', label: 'Critical' }, warning: { c: '#fb923c', label: 'Warning' },
  attention: { c: '#fbbf24', label: 'Attention' }, informational: { c: '#93c5fd', label: 'Info' },
}
const READINESS: Record<string, { c: string; label: string }> = {
  NOT_READY: { c: '#f87171', label: 'Not ready' }, PILOT_READY: { c: '#fbbf24', label: 'Pilot ready' },
  LIMITED_PRODUCTION: { c: '#a3e635', label: 'Limited production' }, PRODUCTION_READY: { c: '#34d399', label: 'Production ready' },
}
const pct = (n?: number | null) => (typeof n === 'number' ? `${n}%` : '—')

type Alert = { key: string; severity: string; title: string; reason: string; system: string; action: string; href: string }
type Readiness = { tier: string; score: number; sampleSize: number; groundTruthCoverage: number; avgImprovementPct: number | null; failureRatePct: number; reasons: string[]; blockers: string[]; completedEvaluations: number; groundTruthCount: number; reviewedCount: number; v2WinPct: number | null; avgV1ErrorPct: number | null; avgV2ErrorPct: number | null }
type Payload = { enabled: boolean; alerts?: Alert[]; counts?: Record<string, number>; readiness?: Readiness; backgroundAlerting?: boolean }

export default function AlertsPage() {
  return <OperationsShell><AICommandShell section="alerts" title="Alerts & Readiness"><Alerts /></AICommandShell></OperationsShell>
}

function Alerts() {
  const [res, setRes] = useState<{ payload: Payload | null; err: string } | null>(null)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    const c = new AbortController()
    fetch('/api/admin/ai-alerts', { credentials: 'same-origin', signal: c.signal })
      .then(async (r) => { if (r.status === 401 || r.status === 403) return setRes({ payload: null, err: 'Owner access required.' }); setRes({ payload: await r.json(), err: '' }) })
      .catch((e) => { if ((e as { name?: string })?.name !== 'AbortError') setRes({ payload: null, err: 'Could not load alerts.' }) })
    return () => c.abort()
  }, [reload])

  if (!res) return <AISkeleton rows={4} />
  if (res.err) return <AIError message={res.err} onRetry={() => setReload((k) => k + 1)} />
  const d = res.payload
  if (d && !d.enabled) return <AIEmpty title="AI evaluation is off" detail="Enable SHADOW_ANALYTICS_ENABLED to see alerts & readiness." />
  if (!d?.readiness) return <AISkeleton rows={4} />
  const r = d.readiness
  const rd = READINESS[r.tier] ?? { c: 'var(--muted)', label: r.tier }
  const alerts = d.alerts ?? []
  const counts = d.counts ?? {}

  return (
    <>
      {/* Severity summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12 }}>
        {(['critical', 'warning', 'attention', 'informational'] as const).map((s) => (
          <AIStat key={s} label={SEV[s].label} value={String(counts[s] ?? 0)} tone={(counts[s] ?? 0) > 0 ? SEV[s].c : undefined} />
        ))}
      </div>

      {/* Alerts list — each links to where it is resolved */}
      {alerts.length === 0 ? (
        <AIEmpty title="No active alerts" detail="Nothing needs attention right now." />
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {alerts.map((a) => {
            const c = SEV[a.severity]?.c ?? 'var(--muted)'
            return (
              <Link key={a.key} href={a.href} style={{ textDecoration: 'none', color: 'inherit' }}>
                <div style={{ ...aiCard, padding: 14, borderLeft: `3px solid ${c}` }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 9.5, fontWeight: 800, padding: '2px 7px', borderRadius: 5, color: c, background: `color-mix(in srgb, ${c} 15%, transparent)`, border: `1px solid color-mix(in srgb, ${c} 35%, transparent)` }}>{SEV[a.severity]?.label ?? a.severity}</span>
                    <strong style={{ fontSize: 13.5 }}>{a.title}</strong>
                    <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{a.system}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: '#93c5fd' }}>Resolve →</span>
                  </div>
                  <p style={{ margin: '6px 0 3px', fontSize: 12.5, lineHeight: 1.45 }}>{a.reason}</p>
                  <p style={{ margin: 0, fontSize: 11.5, color: 'var(--muted)' }}>{a.action}</p>
                </div>
              </Link>
            )
          })}
        </div>
      )}

      {/* Readiness */}
      <div style={{ ...aiCard, display: 'grid', gap: 10, borderColor: `${rd.c}44` }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <div>
            <span style={aiLabel}>Model readiness</span>
            <div style={{ fontSize: 18, fontWeight: 800, color: rd.c }}>{rd.label}</div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>score {r.score} · {r.sampleSize} verified · {pct(r.groundTruthCoverage)} coverage</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
          <Mini k="Completed" v={r.completedEvaluations} />
          <Mini k="Reviewed" v={r.reviewedCount} />
          <Mini k="Ground truth" v={r.groundTruthCount} />
          <Mini k="V2 win rate" v={pct(r.v2WinPct)} />
          <Mini k="V1 / V2 error" v={`${pct(r.avgV1ErrorPct)} / ${pct(r.avgV2ErrorPct)}`} />
          <Mini k="Improvement" v={pct(r.avgImprovementPct)} tone={(r.avgImprovementPct ?? 0) >= 0 ? '#34d399' : '#f87171'} />
        </div>
        {r.blockers.length > 0 && <div style={{ display: 'grid', gap: 3 }}>{r.blockers.map((b, i) => <div key={i} style={{ fontSize: 12, color: '#f87171' }}>⚠ {b}</div>)}</div>}
        {r.reasons.length > 0 && <div style={{ display: 'grid', gap: 2 }}>{r.reasons.map((x, i) => <div key={i} style={{ fontSize: 11.5, color: 'var(--muted)' }}>{x}</div>)}</div>}
        <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>Readiness is a recommendation only — V2 is never promoted automatically. See <Link href="/admin/operations/ai/performance" style={{ color: '#93c5fd', textDecoration: 'none' }}>Performance</Link> for the full accuracy picture.</p>
      </div>

      <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>
        Alerts are derived live and deterministically from current metrics — no AI is run.
        {d.backgroundAlerting ? ' Background alerting is on.' : ' Background email/in-app alerting is off (SHADOW_ALERTING_ENABLED).'}
      </p>
    </>
  )
}

function Mini({ k, v, tone }: { k: string; v: string | number; tone?: string }) {
  return <div><div style={{ fontSize: 9.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{k}</div><div style={{ fontSize: 17, fontWeight: 800, color: tone ?? 'var(--text)' }}>{v}</div></div>
}
