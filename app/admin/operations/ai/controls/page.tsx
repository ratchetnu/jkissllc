'use client'

import { useEffect, useState } from 'react'
import { Sparkles, RefreshCw, AlertTriangle, Gauge, Activity, LayoutGrid, FileText, DollarSign, TerminalSquare, FlaskConical, Check, X, RotateCcw, Play } from 'lucide-react'
import OperationsShell from '../../OperationsShell'
import AICommandShell from '../AICommandShell'
import { Stat, fmtTs } from '../../ui'

// ── shared formatters ────────────────────────────────────────────────────────
const usd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${(n ?? 0).toFixed(4)}`)
const pct = (n: number) => `${Math.round((n ?? 0) * 100)}%`
const card = { padding: 20, marginBottom: 16 } as const
const OUTCOME_LABEL: Record<string, string> = { success: 'Success', invalid_response: 'Invalid response', provider_error: 'Provider error', forbidden: 'Blocked (RBAC)', budget_exceeded: 'Budget reached' }
const TONE: Record<string, string> = { success: '#86efac', invalid_response: '#fcd34d', provider_error: '#fca5a5', forbidden: '#94a3b8', budget_exceeded: '#fdba74' }
const qColor = (s: number) => (s >= 85 ? '#86efac' : s >= 60 ? '#fcd34d' : '#fca5a5')

type Tab = 'overview' | 'registry' | 'prompts' | 'quality' | 'cost' | 'observability'
const TABS: { id: Tab; label: string; Icon: typeof Activity }[] = [
  { id: 'overview', label: 'Overview', Icon: Activity },
  { id: 'registry', label: 'Registry', Icon: LayoutGrid },
  { id: 'prompts', label: 'Prompts', Icon: FileText },
  { id: 'quality', label: 'Quality', Icon: FlaskConical },
  { id: 'cost', label: 'Cost', Icon: DollarSign },
  { id: 'observability', label: 'Observability', Icon: TerminalSquare },
]

function useJson<T>(url: string | null): { data: T | null; err: string; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!url) return
    let live = true
    // All state mutation happens inside the async runner (never synchronously in the
    // effect body) to avoid cascading-render churn.
    const run = async () => {
      setLoading(true)
      try {
        const d = await fetch(url, { credentials: 'same-origin' }).then(r => r.json())
        if (!live) return
        if (d.ok) { setData(d); setErr('') } else setErr(d.error || 'Failed to load.')
      } catch { if (live) setErr('Failed to load.') }
      finally { if (live) setLoading(false) }
    }
    void run()
    return () => { live = false }
  }, [url, tick])
  return { data, err, loading, reload: () => setTick(t => t + 1) }
}

function Section({ title, Icon, children, sub }: { title: string; Icon?: typeof Activity; children: React.ReactNode; sub?: string }) {
  return (
    <div className="os-card os-rise" style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: sub ? 4 : 14 }}>
        {Icon && <Icon size={17} style={{ color: 'var(--red-glow)' }} />}
        <h2 className="jkos-h" style={{ fontSize: 17 }}>{title}</h2>
      </div>
      {sub && <p style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14 }}>{sub}</p>}
      {children}
    </div>
  )
}

function Skeleton() { return <div className="skeleton" style={{ width: '100%', height: 120, borderRadius: 16 }} /> }
function ErrBox({ msg }: { msg: string }) {
  return <div className="os-card os-rise" style={{ padding: 20, display: 'flex', gap: 10, alignItems: 'center', color: '#fca5a5' }}><AlertTriangle size={18} /> {msg}</div>
}
function scrollX(children: React.ReactNode) { return <div style={{ overflowX: 'auto' }}>{children}</div> }

// ═══════════════════════════ OVERVIEW / QUALITY / OBSERVABILITY (analytics) ═══
type Analytics = {
  generatedAt: number
  window: { count: number }
  totals: { calls: number; ok: number; errors: number; successRate: number; avgLatencyMs: number; latency: { p50: number; p95: number; p99: number }; totalTokens: number; estCostUsd: number; actualCostUsd: number; avgQuality: number; lowQuality: number; retries: number; helpful: number; notHelpful: number; feedbackRate: number }
  outcomes: Record<string, number>
  errorClasses: Record<string, number>
  qualityFlags: Record<string, number>
  today: { estCostUsd: number; capUsd: number; overBudget: boolean }
  features: { feature: string; calls: number; successRate: number; avgLatencyMs: number; p95LatencyMs: number; estCostUsd: number; avgQuality: number; helpful: number; notHelpful: number }[]
  models: { model: string; calls: number; successRate: number; avgLatencyMs: number; p95LatencyMs: number; totalTokens: number; estCostUsd: number; actualCostUsd: number; costSource: string }[]
  recent: { id: string; at: number; feature: string; promptVersion: number; promptVariant?: string; model: string; role: string; outcome: string; latencyMs: number; totalTokens: number; estCostUsd: number; qualityScore?: number; attempts?: number; feedback?: string }[]
}

function OverviewTab({ a }: { a: Analytics }) {
  return (
    <>
      {a.today.capUsd > 0 && (
        <div className="os-card os-rise" style={{ padding: '14px 18px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, borderColor: a.today.overBudget ? '#fca5a5' : 'var(--line)' }}>
          <Gauge size={18} style={{ color: a.today.overBudget ? '#fca5a5' : 'var(--red-glow)' }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Today&rsquo;s AI spend (estimated)</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{usd(a.today.estCostUsd)} of {usd(a.today.capUsd)} daily cap{a.today.overBudget && ' — cap reached; AI pauses until tomorrow'}</div>
          </div>
          <div style={{ minWidth: 120 }}><div style={{ height: 8, borderRadius: 999, background: 'rgba(255,255,255,.1)', overflow: 'hidden' }}><div style={{ height: '100%', width: `${Math.min(100, (a.today.estCostUsd / a.today.capUsd) * 100)}%`, background: a.today.overBudget ? '#fca5a5' : 'var(--red)' }} /></div></div>
        </div>
      )}
      <div className="os-rise" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: 12, marginBottom: 18 }}>
        <Stat label="Total AI calls" value={String(a.totals.calls)} sub={`${a.window.count} recent`} />
        <Stat label="Success rate" value={pct(a.totals.successRate)} sub={`${a.totals.errors} errors`} tone={a.totals.successRate >= 0.9 ? '#86efac' : '#fcd34d'} />
        <Stat label="Latency p50 / p95" value={`${a.totals.latency.p50} / ${a.totals.latency.p95}ms`} sub={`p99 ${a.totals.latency.p99}ms`} />
        <Stat label="Avg quality" value={a.totals.avgQuality ? String(a.totals.avgQuality) : '—'} sub={`${a.totals.lowQuality} low`} tone={qColor(a.totals.avgQuality)} />
        <Stat label="Est. cost (window)" value={usd(a.totals.estCostUsd)} sub={a.totals.actualCostUsd > 0 ? `${usd(a.totals.actualCostUsd)} actual` : `${(a.totals.totalTokens / 1000).toFixed(1)}k tok`} />
        <Stat label="Feedback" value={a.totals.helpful + a.totals.notHelpful > 0 ? pct(a.totals.feedbackRate) : '—'} sub={`👍 ${a.totals.helpful} · 👎 ${a.totals.notHelpful}`} />
      </div>
      <Section title="Outcomes" Icon={Activity}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {Object.entries(a.outcomes).filter(([, n]) => n > 0).map(([k, n]) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 13px', borderRadius: 10, background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)' }}>
              <span style={{ width: 9, height: 9, borderRadius: 999, background: TONE[k] || '#94a3b8' }} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>{OUTCOME_LABEL[k] || k}</span>
              <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--muted)' }}>{n}</span>
            </div>
          ))}
          {Object.values(a.outcomes).every(n => n === 0) && <span style={{ fontSize: 13, color: 'var(--muted)' }}>No AI calls recorded yet.</span>}
        </div>
      </Section>
      <FeatureTable features={a.features} />
    </>
  )
}

function FeatureTable({ features }: { features: Analytics['features'] }) {
  return (
    <Section title="By feature" Icon={LayoutGrid}>
      {features.length === 0 ? <span style={{ fontSize: 13, color: 'var(--muted)' }}>No activity yet.</span> : scrollX(
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 560 }}>
          <thead><tr style={{ color: 'var(--muted)', textAlign: 'left' }}>{['Feature', 'Calls', 'Success', 'Latency p95', 'Quality', 'Cost', '👍/👎'].map(h => <th key={h} style={{ padding: '5px 8px', fontWeight: 700 }}>{h}</th>)}</tr></thead>
          <tbody>{features.map(f => (
            <tr key={f.feature} style={{ borderTop: '1px solid var(--line)' }}>
              <td style={{ padding: '6px 8px', fontFamily: 'var(--mono, ui-monospace)' }}>{f.feature}</td>
              <td style={{ padding: '6px 8px' }}>{f.calls}</td>
              <td style={{ padding: '6px 8px', color: f.successRate >= 0.9 ? '#86efac' : '#fcd34d' }}>{pct(f.successRate)}</td>
              <td style={{ padding: '6px 8px' }}>{f.p95LatencyMs}ms</td>
              <td style={{ padding: '6px 8px', color: qColor(f.avgQuality) }}>{f.avgQuality || '—'}</td>
              <td style={{ padding: '6px 8px' }}>{usd(f.estCostUsd)}</td>
              <td style={{ padding: '6px 8px' }}>{f.helpful}/{f.notHelpful}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </Section>
  )
}

function QualityTab({ a }: { a: Analytics }) {
  const [evalReport, setEvalReport] = useState<EvalReport | null>(null)
  const [running, setRunning] = useState(false)
  async function runEval() {
    setRunning(true)
    try { const r = await fetch('/api/admin/ai/evaluate', { method: 'POST', credentials: 'same-origin' }).then(r => r.json()); if (r.ok) setEvalReport(r.report) } finally { setRunning(false) }
  }
  const flags = Object.entries(a.qualityFlags).sort((x, y) => y[1] - x[1])
  return (
    <>
      <div className="os-rise" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: 12, marginBottom: 18 }}>
        <Stat label="Avg quality score" value={a.totals.avgQuality ? String(a.totals.avgQuality) : '—'} tone={qColor(a.totals.avgQuality)} />
        <Stat label="Low-quality responses" value={String(a.totals.lowQuality)} sub="score < 60" tone={a.totals.lowQuality > 0 ? '#fca5a5' : undefined} />
        <Stat label="Feedback rate" value={a.totals.helpful + a.totals.notHelpful > 0 ? pct(a.totals.feedbackRate) : '—'} sub={`👍 ${a.totals.helpful} · 👎 ${a.totals.notHelpful}`} />
      </div>
      <Section title="Quality flags (in window)" Icon={FlaskConical} sub="How often each heuristic issue appeared across scored responses.">
        {flags.length === 0 ? <span style={{ fontSize: 13, color: 'var(--muted)' }}>No flags — responses look clean.</span> : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{flags.map(([f, n]) => (
            <span key={f} style={{ fontSize: 12.5, padding: '6px 11px', borderRadius: 9, background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)' }}>{f} <b style={{ color: 'var(--muted)' }}>{n}</b></span>
          ))}</div>
        )}
      </Section>
      <Section title="Regression evaluation" Icon={Play} sub="Run the deterministic golden-fixture suite (no model calls) that gates deployment.">
        <button onClick={runEval} disabled={running} className="btn os-tap" style={{ borderRadius: 11, height: 42, padding: '0 16px' }}>
          {running ? 'Running…' : <><Play size={15} /> Run evaluation</>}
        </button>
        {evalReport && (
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontWeight: 700 }}>
              {evalReport.pass ? <Check size={16} style={{ color: '#86efac' }} /> : <X size={16} style={{ color: '#fca5a5' }} />}
              {evalReport.totals.casesPassed}/{evalReport.totals.cases} cases passed · {evalReport.totals.passed}/{evalReport.totals.features} features
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{evalReport.features.map(f => (
              <div key={f.taskId} style={{ fontSize: 12.5, padding: '8px 11px', borderRadius: 9, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
                <b style={{ fontFamily: 'var(--mono, ui-monospace)' }}>{f.taskId}</b> {f.pass ? '✓' : '✗'}
                <span style={{ color: 'var(--muted)' }}> — {f.cases.map(c => `${c.name} ${c.pass ? '✓' : '✗'}`).join(', ')}</span>
              </div>
            ))}</div>
          </div>
        )}
      </Section>
    </>
  )
}

function ObservabilityTab({ a }: { a: Analytics }) {
  const errs = Object.entries(a.errorClasses).sort((x, y) => y[1] - x[1])
  return (
    <>
      <div className="os-rise" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: 12, marginBottom: 18 }}>
        <Stat label="Latency p50 / p95 / p99" value={`${a.totals.latency.p50}/${a.totals.latency.p95}/${a.totals.latency.p99}`} sub="ms" />
        <Stat label="Retries" value={String(a.totals.retries)} sub="transient recoveries" />
        <Stat label="Errors" value={String(a.totals.errors)} tone={a.totals.errors > 0 ? '#fca5a5' : undefined} />
      </div>
      <Section title="Per-model metrics" Icon={TerminalSquare}>
        {a.models.length === 0 ? <span style={{ fontSize: 13, color: 'var(--muted)' }}>No model calls yet.</span> : scrollX(
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 620 }}>
            <thead><tr style={{ color: 'var(--muted)', textAlign: 'left' }}>{['Model', 'Calls', 'Success', 'Latency p95', 'Tokens', 'Cost', 'Source'].map(h => <th key={h} style={{ padding: '5px 8px', fontWeight: 700 }}>{h}</th>)}</tr></thead>
            <tbody>{a.models.map(m => (
              <tr key={m.model} style={{ borderTop: '1px solid var(--line)' }}>
                <td style={{ padding: '6px 8px', fontFamily: 'var(--mono, ui-monospace)' }}>{m.model.replace('anthropic/', '')}</td>
                <td style={{ padding: '6px 8px' }}>{m.calls}</td>
                <td style={{ padding: '6px 8px', color: m.successRate >= 0.9 ? '#86efac' : '#fcd34d' }}>{pct(m.successRate)}</td>
                <td style={{ padding: '6px 8px' }}>{m.p95LatencyMs}ms</td>
                <td style={{ padding: '6px 8px' }}>{(m.totalTokens / 1000).toFixed(1)}k</td>
                <td style={{ padding: '6px 8px' }}>{usd(m.actualCostUsd > 0 ? m.actualCostUsd : m.estCostUsd)}</td>
                <td style={{ padding: '6px 8px', color: m.costSource === 'actual' ? '#86efac' : m.costSource === 'mixed' ? '#fcd34d' : 'var(--muted)' }}>{m.costSource}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Section>
      {errs.length > 0 && (
        <Section title="Failure classes" Icon={AlertTriangle}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{errs.map(([e, n]) => (
            <span key={e} style={{ fontSize: 12.5, padding: '6px 11px', borderRadius: 9, background: 'rgba(252,165,165,.1)', border: '1px solid var(--line)' }}>{e} <b>{n}</b></span>
          ))}</div>
        </Section>
      )}
      <Section title="Recent traces" Icon={Activity}>
        {a.recent.length === 0 ? <span style={{ fontSize: 13, color: 'var(--muted)' }}>No recent activity.</span> : scrollX(
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 720 }}>
            <thead><tr style={{ color: 'var(--muted)', textAlign: 'left' }}>{['When', 'Feature', 'Ver', 'Arm', 'Outcome', 'Latency', 'Try', 'Qual', 'Cost'].map(h => <th key={h} style={{ padding: '5px 8px', fontWeight: 700 }}>{h}</th>)}</tr></thead>
            <tbody>{a.recent.map(r => (
              <tr key={r.id} style={{ borderTop: '1px solid var(--line)' }}>
                <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{fmtTs(r.at)}</td>
                <td style={{ padding: '6px 8px', fontFamily: 'var(--mono, ui-monospace)' }}>{r.feature}</td>
                <td style={{ padding: '6px 8px' }}>v{r.promptVersion}</td>
                <td style={{ padding: '6px 8px', color: 'var(--muted)' }}>{r.promptVariant || '—'}</td>
                <td style={{ padding: '6px 8px' }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: 999, background: TONE[r.outcome] || '#94a3b8' }} />{OUTCOME_LABEL[r.outcome] || r.outcome}</span></td>
                <td style={{ padding: '6px 8px' }}>{r.latencyMs}ms</td>
                <td style={{ padding: '6px 8px', color: (r.attempts ?? 1) > 1 ? '#fcd34d' : 'var(--muted)' }}>{r.attempts ?? 1}</td>
                <td style={{ padding: '6px 8px', color: r.qualityScore != null ? qColor(r.qualityScore) : 'var(--muted)' }}>{r.qualityScore ?? '—'}</td>
                <td style={{ padding: '6px 8px' }}>{usd(r.estCostUsd)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Section>
    </>
  )
}

// ═══════════════════════════ REGISTRY ════════════════════════════════════════
type RegistryResp = { features: { taskId: string; name: string; description: string; surface: string; owner: string; access: string; permission?: string; input: string; structured: boolean; status: string; model: string; modelKnownRate: boolean; promptVersion: number; metrics: { calls: number; successRate: number; p95LatencyMs: number; estCostUsd: number; avgQuality: number } }[] }
function RegistryTab() {
  const { data, err, loading } = useJson<RegistryResp>('/api/admin/ai/registry')
  if (loading) return <Skeleton />
  if (err) return <ErrBox msg={err} />
  return (
    <Section title="AI Feature Registry" Icon={LayoutGrid} sub="Every AI capability: model, prompt version, owner, access, status — joined with live usage. No feature writes authoritative business data.">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{data?.features.map(f => (
        <div key={f.taskId} style={{ padding: 14, borderRadius: 13, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
            <span style={{ fontWeight: 800, fontSize: 15 }}>{f.name}</span>
            <span style={{ fontSize: 11, fontFamily: 'var(--mono, ui-monospace)', color: 'var(--muted)' }}>{f.taskId}</span>
            <span style={{ fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 999, background: f.status === 'ga' ? 'rgba(134,239,172,.15)' : 'rgba(252,211,77,.15)', color: f.status === 'ga' ? '#86efac' : '#fcd34d' }}>{f.status.toUpperCase()}</span>
            <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: f.access === 'public' ? 'rgba(253,186,116,.15)' : 'rgba(148,163,184,.15)', color: f.access === 'public' ? '#fdba74' : '#cbd5e1' }}>{f.access === 'public' ? 'PUBLIC' : f.permission}</span>
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10 }}>{f.description}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 12 }}>
            <span>🧠 <b style={{ fontFamily: 'var(--mono, ui-monospace)' }}>{f.model.replace('anthropic/', '')}</b>{!f.modelKnownRate && <span title="No published rate — cost is a fallback estimate" style={{ color: '#fcd34d' }}> ⚠︎</span>}</span>
            <span style={{ color: 'var(--muted)' }}>prompt v{f.promptVersion}</span>
            <span style={{ color: 'var(--muted)' }}>{f.input}{f.structured ? ' · structured' : ''}</span>
            <span style={{ color: 'var(--muted)' }}>owner: {f.owner}</span>
            <span style={{ color: 'var(--muted)' }}>{f.metrics.calls} calls · {pct(f.metrics.successRate)} ok · {f.metrics.avgQuality || '—'} qual · {usd(f.metrics.estCostUsd)}</span>
          </div>
        </div>
      ))}</div>
    </Section>
  )
}

// ═══════════════════════════ PROMPTS (edit / rollback / A/B) ══════════════════
type Version = { id: string; version: number; system: string; prompt: string; source: string; note?: string; editedBy?: string; at?: number }
type PromptRow = { id: string; description: string; builtinVersion: number; activeVersion: number; versions: Version[]; ab: { enabled: boolean; variant: number; split: number } | null }
type PromptsResp = { prompts: PromptRow[] }

function PromptsTab() {
  const { data, err, loading, reload } = useJson<PromptsResp>('/api/admin/ai/prompts')
  const [busy, setBusy] = useState('')
  const [editing, setEditing] = useState<{ id: string; system: string; prompt: string } | null>(null)
  const [note, setNote] = useState('')

  async function mutate(payload: Record<string, unknown>) {
    setBusy(String(payload.id))
    try {
      const r = await fetch('/api/admin/ai/prompts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(payload) }).then(r => r.json())
      if (!r.ok) alert(r.error || 'Failed'); else { setEditing(null); setNote(''); reload() }
    } finally { setBusy('') }
  }

  if (loading) return <Skeleton />
  if (err) return <ErrBox msg={err} />
  return (
    <Section title="Prompt Management" Icon={FileText} sub="Version, edit, activate, and roll back the prompt each AI feature runs — and configure A/B tests. Config only; fully reversible to the built-in version. Requires admin.">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>{data?.prompts.map(p => {
        const active = p.versions.find(v => v.version === p.activeVersion) ?? p.versions[0]
        return (
          <div key={p.id} style={{ padding: 14, borderRadius: 13, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
              <span style={{ fontWeight: 800, fontSize: 14, fontFamily: 'var(--mono, ui-monospace)' }}>{p.id}</span>
              <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--red-glow)' }}>active v{p.activeVersion}</span>
              {p.ab?.enabled && <span style={{ fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 999, background: 'rgba(96,165,250,.15)', color: '#93c5fd' }}>A/B → v{p.ab.variant} @ {p.ab.split}%</span>}
              <span style={{ flex: 1 }} />
              <button onClick={() => setEditing({ id: p.id, system: active.system, prompt: active.prompt })} disabled={busy === p.id} className="os-tap" style={miniBtn}>Edit → new version</button>
            </div>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>{p.description}</p>
            {/* versions */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{p.versions.map(v => (
              <div key={v.version} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, padding: '7px 10px', borderRadius: 9, background: v.version === p.activeVersion ? 'rgba(134,239,172,.08)' : 'rgba(255,255,255,.02)', border: '1px solid var(--line)' }}>
                <b>v{v.version}</b>
                <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{v.source}{v.editedBy ? ` · ${v.editedBy}` : ''}{v.at ? ` · ${fmtTs(v.at)}` : ''}{v.note ? ` · ${v.note}` : ''}</span>
                <span style={{ flex: 1 }} />
                {v.version !== p.activeVersion && <button onClick={() => mutate({ id: p.id, action: 'activate', version: v.version })} className="os-tap" style={miniBtn} title={v.version < p.activeVersion ? 'Roll back' : 'Activate'}>{v.version < p.activeVersion ? <><RotateCcw size={12} /> Roll back</> : 'Activate'}</button>}
                {v.source === 'stored' && v.version !== p.builtinVersion && <button onClick={() => mutate({ id: p.id, action: 'ab', variant: v.version, split: 50 })} className="os-tap" style={miniBtn}>A/B 50%</button>}
              </div>
            ))}</div>
            {p.ab?.enabled && <button onClick={() => mutate({ id: p.id, action: 'clearAb' })} className="os-tap" style={{ ...miniBtn, marginTop: 8 }}>Stop A/B test</button>}
            <AbPanel taskId={p.id} />
          </div>
        )
      })}</div>

      {editing && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 50 }} onClick={() => setEditing(null)}>
          <div className="os-card" style={{ padding: 20, maxWidth: 680, width: '100%', maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
            <h3 className="jkos-h" style={{ fontSize: 17, marginBottom: 4 }}>Edit {editing.id}</h3>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>Templates use {'{{var}}'} placeholders and {'{{#var}}…{{/var}}'} sections. Saving creates a new active version; roll back anytime.</p>
            <label style={lbl}>System</label>
            <textarea value={editing.system} onChange={e => setEditing({ ...editing, system: e.target.value })} style={ta} rows={5} />
            <label style={lbl}>Prompt</label>
            <textarea value={editing.prompt} onChange={e => setEditing({ ...editing, prompt: e.target.value })} style={ta} rows={5} />
            <label style={lbl}>Note (optional)</label>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="What changed & why" style={{ ...ta, minHeight: 0 }} />
            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button onClick={() => mutate({ id: editing.id, action: 'edit', system: editing.system, prompt: editing.prompt, note })} disabled={busy === editing.id} className="btn os-tap" style={{ borderRadius: 11, height: 42, padding: '0 16px' }}><Check size={15} /> Save new version</button>
              <button onClick={() => setEditing(null)} className="os-tap" style={{ ...miniBtn, height: 42 }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </Section>
  )
}

type AbResp = { config: { enabled: boolean; variant: number; split: number } | null; analysis: { control: { calls: number; successRate: number; avgQuality: number }; variant: { calls: number; successRate: number; avgQuality: number }; zScore: number; pValue: number; significant: boolean; winner: string } | null }
function AbPanel({ taskId }: { taskId: string }) {
  const { data } = useJson<AbResp>(`/api/admin/ai/ab?taskId=${encodeURIComponent(taskId)}`)
  const an = data?.analysis
  if (!an || (an.control.calls === 0 && an.variant.calls === 0)) return null
  return (
    <div style={{ marginTop: 10, padding: 12, borderRadius: 10, background: 'rgba(96,165,250,.06)', border: '1px solid var(--line)', fontSize: 12 }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>A/B result — {an.significant ? <span style={{ color: '#86efac' }}>{an.winner} wins (95%)</span> : <span style={{ color: 'var(--muted)' }}>inconclusive</span>}</div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', color: 'var(--muted)' }}>
        <span>control: {an.control.calls} calls · {pct(an.control.successRate)} ok · {an.control.avgQuality} qual</span>
        <span>variant: {an.variant.calls} calls · {pct(an.variant.successRate)} ok · {an.variant.avgQuality} qual</span>
        <span>z={an.zScore} · p={an.pValue}</span>
      </div>
    </div>
  )
}

// ═══════════════════════════ COST ════════════════════════════════════════════
type CostResp = { forecast: { series: { day: string; usd: number }[]; mtdUsd: number; avgDailyUsd: number; projectedMonthUsd: number; capUsd: number; capRisk: boolean; trendPct: number }; hints: { feature: string; kind: string; detail: string; estMonthlyUsd: number }[]; models: Analytics['models']; totals: { estCostUsd: number; actualCostUsd: number } }
function CostTab() {
  const { data, err, loading } = useJson<CostResp>('/api/admin/ai/cost')
  if (loading) return <Skeleton />
  if (err) return <ErrBox msg={err} />
  const f = data!.forecast
  const max = Math.max(...f.series.map(s => s.usd), 0.0001)
  return (
    <>
      <div className="os-rise" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: 12, marginBottom: 18 }}>
        <Stat label="Month-to-date" value={usd(f.mtdUsd)} sub="estimated" />
        <Stat label="Avg / day" value={usd(f.avgDailyUsd)} sub={`trend ${f.trendPct >= 0 ? '+' : ''}${f.trendPct}%`} tone={f.trendPct > 25 ? '#fca5a5' : undefined} />
        <Stat label="Projected month" value={usd(f.projectedMonthUsd)} sub={f.capUsd > 0 ? `daily cap ${usd(f.capUsd)}` : 'no cap'} tone={f.capRisk ? '#fca5a5' : undefined} />
        <Stat label="Actual reconciled" value={data!.totals.actualCostUsd > 0 ? usd(data!.totals.actualCostUsd) : '—'} sub={data!.totals.actualCostUsd > 0 ? 'provider-reported' : 'gateway est.'} />
      </div>
      <Section title="Daily spend (30d)" Icon={DollarSign} sub="Estimated AI spend per day. Reconciles to provider-reported cost where the Gateway supplies it.">
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 90 }}>
          {f.series.map(s => (
            <div key={s.day} title={`${s.day}: ${usd(s.usd)}`} style={{ flex: 1, height: `${Math.max(2, (s.usd / max) * 100)}%`, background: s.usd > 0 ? 'var(--red)' : 'rgba(255,255,255,.06)', borderRadius: 3, minWidth: 4 }} />
          ))}
        </div>
      </Section>
      {data!.hints.length > 0 && (
        <Section title="Optimization" Icon={Gauge} sub="Explainable, non-destructive suggestions — you decide.">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{data!.hints.map((h, i) => (
            <div key={i} style={{ fontSize: 12.5, padding: '10px 12px', borderRadius: 10, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
              <b style={{ fontFamily: 'var(--mono, ui-monospace)' }}>{h.feature}</b> <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{h.kind}</span>
              {h.estMonthlyUsd > 0 && <span style={{ float: 'right', color: '#fcd34d' }}>~{usd(h.estMonthlyUsd)}/mo</span>}
              <div style={{ color: 'var(--muted)', marginTop: 3 }}>{h.detail}</div>
            </div>
          ))}</div>
        </Section>
      )}
    </>
  )
}

const miniBtn = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px', fontSize: 11.5, fontWeight: 700, borderRadius: 8, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--text)', cursor: 'pointer' } as const
const lbl = { display: 'block', fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6, marginTop: 10 } as const
const ta = { width: '100%', padding: '10px 12px', background: 'rgba(0,0,0,.25)', border: '1px solid var(--line)', borderRadius: 10, color: 'var(--text)', fontSize: 13, fontFamily: 'var(--mono, ui-monospace)', minHeight: 44, resize: 'vertical' } as const

type EvalReport = { pass: boolean; totals: { features: number; passed: number; cases: number; casesPassed: number }; features: { taskId: string; pass: boolean; cases: { name: string; pass: boolean }[] }[] }

// ═══════════════════════════ SHELL ═══════════════════════════════════════════
function AiControlCenter() {
  const [tab, setTab] = useState<Tab>('overview')
  const needsAnalytics = tab === 'overview' || tab === 'quality' || tab === 'observability'
  const { data: a, err, loading, reload } = useJson<Analytics>(needsAnalytics ? '/api/admin/ai/analytics' : null)

  return (
    <div style={{ maxWidth: 940, margin: '0 auto' }}>
      <div className="os-rise" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
        <Sparkles size={26} style={{ color: 'var(--red-glow)' }} />
        <h1 className="jkos-h" style={{ fontSize: 'clamp(26px,6vw,38px)', flex: 1 }}>AI Control Center</h1>
        {needsAnalytics && <button onClick={reload} className="os-tap" aria-label="Refresh" style={{ ...miniBtn, height: 36 }}><RefreshCw size={15} /> Refresh</button>}
      </div>
      <p className="os-rise" style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>Enterprise AI operations: observability, cost, quality, prompt management, and A/B — all read-only/draft-only. AI never changes bookings, pay, or claims.</p>

      <div className="os-rise" style={{ display: 'flex', gap: 6, marginBottom: 18, overflowX: 'auto', paddingBottom: 4 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 11, whiteSpace: 'nowrap', border: '1px solid var(--line)', cursor: 'pointer', fontWeight: 700, fontSize: 13, background: tab === t.id ? 'var(--red)' : 'rgba(255,255,255,.04)', color: tab === t.id ? '#fff' : 'var(--muted)' }}>
            <t.Icon size={15} /> {t.label}
          </button>
        ))}
      </div>

      {needsAnalytics ? (
        loading ? <Skeleton /> : err ? <ErrBox msg={err} /> : a ? (
          tab === 'overview' ? <OverviewTab a={a} /> : tab === 'quality' ? <QualityTab a={a} /> : <ObservabilityTab a={a} />
        ) : null
      ) : tab === 'registry' ? <RegistryTab /> : tab === 'prompts' ? <PromptsTab /> : tab === 'cost' ? <CostTab /> : null}

      <p className="os-rise" style={{ fontSize: 11.5, color: 'var(--muted)', textAlign: 'center', marginTop: 18 }}>
        Costs are list-price estimates unless marked “actual” — the AI Gateway is the source of truth.{a && <> Generated {fmtTs(a.generatedAt)}.</>}
      </p>
    </div>
  )
}

// Interim home for the live-V1 AI observability (usage, cost, quality, registry, prompts),
// now a section of the AI Command Center. Increment 3 splits the version registry out into
// Models and reorganizes the operational controls; until then it renders here intact so no
// capability is lost during the consolidation.
export default function AiControlsSectionPage() {
  return (
    <OperationsShell>
      <AICommandShell section="controls" title="Production AI telemetry">
        <AiControlCenter />
      </AICommandShell>
    </OperationsShell>
  )
}
