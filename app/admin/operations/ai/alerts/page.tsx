'use client'

// ── Operion — AI Alerts (the owner's notification center) ────────────────────
// Owner-only. Reads the deployed GET /api/admin/shadow-alerts (SHADOW_ALERTING_ENABLED-gated).
// This page NEVER re-derives alert math and never evaluates a policy — it renders what the
// scheduled evaluator already decided, so opening it cannot create or change an alert. No
// external chart lib, theme-aware via the admin CSS vars, mobile-responsive (table → cards).
// No customer impact.

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import OperationsShell from '../../OperationsShell'
import AICommandShell from '../AICommandShell'

// ── shared style tokens (same admin theme vars the rest of Operion uses) ─────
const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 16 }
const lab: React.CSSProperties = { display: 'block', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', marginBottom: 4 }
const seg: React.CSSProperties = { fontSize: 11.5, fontWeight: 700, padding: '6px 12px', cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--muted)' }
const segOn: React.CSSProperties = { background: 'var(--text)', color: 'var(--card)' }
const selectStyle: React.CSSProperties = { padding: '6px 9px', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, color: 'var(--text)', fontSize: 11.5, maxWidth: 220 }
const inputStyle: React.CSSProperties = { padding: '6px 9px', background: 'transparent', border: '1px solid var(--line)', borderRadius: 8, color: 'var(--text)', fontSize: 11.5 }

export const SEV_COLOR: Record<string, string> = { CRITICAL: '#f87171', ERROR: '#fb923c', WARNING: '#fbbf24', INFO: '#93c5fd' }
const STATUS_COLOR: Record<string, string> = { OPEN: '#f87171', ACKNOWLEDGED: '#fbbf24', MUTED: '#94a3b8', RESOLVED: '#34d399', EXPIRED: '#64748b' }
const nice = (s: string) => s.replace(/_/g, ' ')
// `now` is always the time the data was fetched, never Date.now() read during render —
// a render must be pure, and a relative time is only honest against the data's own age.
const ago = (t: number, now: number) => {
  const m = Math.round((now - t) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

export type Alert = {
  id: string; policyId: string; policyType: string; severity: string; status: string
  scopeKey: string; reason: string; observed: number; threshold: number; comparison: number | null
  sampleSize: number; model?: string; deployment?: string; business?: string
  firstDetectedAt: number; lastDetectedAt: number; occurrences: number
  acknowledgedAt?: number; acknowledgedBy?: string; resolvedAt?: number; resolvedBy?: string; resolvedReason?: string
  mutedUntil?: number; mutedBy?: string; escalatedAt?: number
  relatedBookingIds: string[]; relatedTraceIds: string[]
  readiness: { tier: string; score: number; evaluated: number; agreementPct: number; blockers: string[] } | null
  notes: { note: string; by: string; at: number }[]
  deliveredChannels?: string[]; unread: boolean
}
type FacetOption = { value: string; label: string; count: number }
type Summary = {
  total: number; open: number; acknowledged: number; resolved: number; muted: number; expired: number
  active: number; unread: number; openCritical: number; escalated: number
  bySeverity: Record<string, number>; byPolicyType: Record<string, number>; lastDetectedAt: number | null
}
type LastRun = { ok: boolean; at: number; durationMs: number; skipped?: string; jobsRead: number; signals: number; opened: number; resolved: number; suppressed: number; readinessTier?: string; error?: string }
type Payload = {
  enabled: boolean; reason?: string; sampled?: number; matched?: number
  facets?: { severities: FacetOption[]; policyTypes: FacetOption[]; statuses: FacetOption[]; models: FacetOption[]; deployments: FacetOption[]; businesses: FacetOption[] }
  summary?: Summary; filteredSummary?: Summary; alerts?: Alert[]
  readiness?: { tier: string; score: number; evaluated: number; agreementPct: number; blockers: string[] } | null
  lastRun?: LastRun | null
}

const STATUS_TABS = [
  { k: '', label: 'All' }, { k: 'OPEN', label: 'Open' }, { k: 'ACKNOWLEDGED', label: 'Acknowledged' },
  { k: 'MUTED', label: 'Muted' }, { k: 'RESOLVED', label: 'Resolved' }, { k: 'EXPIRED', label: 'Expired' },
]
const dayToMs = (d: string, end = false): number | undefined => { const t = Date.parse(end ? `${d}T23:59:59` : `${d}T00:00:00`); return Number.isFinite(t) ? t : undefined }

// useSearchParams needs a Suspense boundary during prerender — wrap the real page in one.
export default function AlertsPage() {
  return <Suspense fallback={null}><AlertsInner /></Suspense>
}

function AlertsInner() {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()

  // View state seeded from the URL so refresh / a shared link restores the exact view.
  const [status, setStatus] = useState(sp.get('status') ?? '')
  const [severity, setSeverity] = useState(sp.get('severity') ?? '')
  const [policyType, setPolicyType] = useState(sp.get('policyType') ?? '')
  const [model, setModel] = useState(sp.get('model') ?? '')
  const [deployment, setDeployment] = useState(sp.get('deployment') ?? '')
  const [business, setBusiness] = useState(sp.get('business') ?? '')
  const [qDraft, setQDraft] = useState(sp.get('q') ?? '')
  const [fromD, setFromD] = useState(sp.get('fromD') ?? '')
  const [toD, setToD] = useState(sp.get('toD') ?? '')

  // One piece of state for the whole request result, keyed by the query it answered. Loading
  // is DERIVED from that key rather than tracked separately, so the effect never has to call
  // setState synchronously (which would cascade renders), and a stale response can never be
  // mistaken for the current one.
  const [res, setRes] = useState<{ key: string; at: number; payload: Payload | null; err: string } | null>(null)

  // Debounce the search + date inputs so typing doesn't fire a request per keystroke.
  const [q, setQ] = useState(qDraft)
  const [range, setRange] = useState({ fromD, toD })
  useEffect(() => { const id = setTimeout(() => setQ(qDraft), 400); return () => clearTimeout(id) }, [qDraft])
  useEffect(() => { const id = setTimeout(() => setRange({ fromD, toD }), 400); return () => clearTimeout(id) }, [fromD, toD])

  // The API query string — the single source both the fetch and the URL derive from.
  const query = useMemo(() => {
    const p = new URLSearchParams()
    if (status) p.set('status', status)
    if (severity) p.set('severity', severity)
    if (policyType) p.set('policyType', policyType)
    if (model) p.set('model', model)
    if (deployment) p.set('deployment', deployment)
    if (business) p.set('business', business)
    if (q) p.set('q', q)
    const from = range.fromD ? dayToMs(range.fromD) : undefined
    const to = range.toD ? dayToMs(range.toD, true) : undefined
    if (from != null) p.set('from', String(from))
    if (to != null) p.set('to', String(to))
    return p.toString()
  }, [status, severity, policyType, model, deployment, business, q, range.fromD, range.toD])

  // Fetch when the query changes; abort any now-stale in-flight request. Every setState here
  // happens in a promise callback (the external system reporting back), never in the effect body.
  useEffect(() => {
    const c = new AbortController()
    const done = (payload: Payload | null, err: string) => setRes({ key: query, at: Date.now(), payload, err })
    fetch(`/api/admin/shadow-alerts?${query}`, { credentials: 'same-origin', signal: c.signal })
      .then(async (r) => {
        if (r.status === 401 || r.status === 403) return done(null, 'Owner access required.')
        done(await r.json(), '')
      })
      .catch((e) => { if ((e as { name?: string })?.name !== 'AbortError') done(null, 'Could not load alerts.') })
    return () => c.abort()
  }, [query])

  const loading = res?.key !== query
  const data = res?.payload ?? null
  const err = res?.err ?? ''
  const now = res?.at ?? 0

  // Mirror the view into the URL (replace, no scroll) so refresh/back restore it.
  useEffect(() => {
    const p = new URLSearchParams(query)
    if (fromD) p.set('fromD', fromD)
    if (toD) p.set('toD', toD)
    router.replace(`${pathname}${p.toString() ? `?${p}` : ''}`, { scroll: false })
  }, [query, fromD, toD, pathname, router])

  const clearAll = () => {
    setStatus(''); setSeverity(''); setPolicyType(''); setModel(''); setDeployment(''); setBusiness('')
    setQDraft(''); setFromD(''); setToD('')
  }
  const hasFilter = !!(status || severity || policyType || model || deployment || business || q || fromD || toD)

  const s = data?.summary
  const alerts = data?.alerts ?? []

  return (
    <OperationsShell><AICommandShell section="alerts" title="Alerts & Readiness">
      <div style={{ display: 'grid', gap: 14, paddingBottom: 40 }}>
        <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>AI Alerts</h1>
            <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--muted)' }}>
              Proactive notifications about the V2 shadow model. Read-only — no model is promoted automatically.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <a href={`/api/admin/shadow-alerts?${query}${query ? '&' : ''}format=csv`}
               style={{ ...seg, border: '1px solid var(--line)', borderRadius: 9, textDecoration: 'none', color: 'var(--text)' }}>
              Export CSV
            </a>
            <Link href="/admin/operations/ai/shadow" style={{ ...seg, border: '1px solid var(--line)', borderRadius: 9, textDecoration: 'none', color: 'var(--text)' }}>
              Shadow Analytics →
            </Link>
          </div>
        </header>

        {err && <div style={{ ...card, borderColor: '#f87171', color: '#f87171', fontSize: 13 }}>{err}</div>}

        {data && !data.enabled && (
          <div style={{ ...card, display: 'grid', gap: 6 }}>
            <strong style={{ fontSize: 14 }}>Alerting is off</strong>
            <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>
              {data.reason ?? 'SHADOW_ALERTING_ENABLED is off'}. Nothing is being evaluated and no alerts are being
              created. Set <code>SHADOW_ALERTING_ENABLED=true</code> in the environment to turn the evaluator on.
            </p>
          </div>
        )}

        {data?.enabled && (
          <>
            {/* Scheduler health — an empty list means "nothing wrong" only if the last run succeeded. */}
            <RunHealth run={data.lastRun ?? null} now={now} />

            {/* Severity summary — always over the FULL set, so a filter can never hide a CRITICAL. */}
            {s && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
                <Stat label="Open" value={String(s.open)} tone={s.open > 0 ? '#f87171' : undefined} />
                <Stat label="Open critical" value={String(s.openCritical)} tone={s.openCritical > 0 ? '#f87171' : '#34d399'} sub={s.openCritical > 0 ? 'needs review' : 'all clear'} />
                <Stat label="Unread" value={String(s.unread)} tone={s.unread > 0 ? '#fbbf24' : undefined} />
                <Stat label="Acknowledged" value={String(s.acknowledged)} />
                <Stat label="Escalated" value={String(s.escalated)} tone={s.escalated > 0 ? '#fb923c' : undefined} sub={s.escalated > 0 ? 'unacked too long' : undefined} />
                <Stat label="Resolved" value={String(s.resolved)} tone="#34d399" />
              </div>
            )}

            {data.readiness && <ReadinessCard r={data.readiness} />}

            {/* Filters */}
            <div style={{ ...card, display: 'grid', gap: 10 }}>
              <div style={{ display: 'inline-flex', background: 'color-mix(in srgb, var(--card) 60%, transparent)', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden', width: 'fit-content', flexWrap: 'wrap' }}>
                {STATUS_TABS.map((t) => (
                  <button key={t.k || 'all'} onClick={() => setStatus(t.k)} style={{ ...seg, ...(status === t.k ? segOn : {}) }}>
                    {t.label}{t.k && s ? ` ${statusCount(s, t.k)}` : ''}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <input value={qDraft} onChange={(e) => setQDraft(e.target.value)} placeholder="Search reason, id, booking…" style={{ ...inputStyle, flex: '1 1 200px', minWidth: 160 }} />
                <Facet label="Severity" value={severity} onChange={setSeverity} options={data.facets?.severities ?? []} />
                <Facet label="Policy" value={policyType} onChange={setPolicyType} options={data.facets?.policyTypes ?? []} />
                <Facet label="Model" value={model} onChange={setModel} options={data.facets?.models ?? []} />
                <Facet label="Deployment" value={deployment} onChange={setDeployment} options={data.facets?.deployments ?? []} />
                {(data.facets?.businesses.length ?? 0) > 0 && <Facet label="Business" value={business} onChange={setBusiness} options={data.facets?.businesses ?? []} />}
                <label style={{ fontSize: 11, color: 'var(--muted)' }}>From <input type="date" value={fromD} onChange={(e) => setFromD(e.target.value)} style={{ ...inputStyle, colorScheme: 'light dark' }} /></label>
                <label style={{ fontSize: 11, color: 'var(--muted)' }}>To <input type="date" value={toD} onChange={(e) => setToD(e.target.value)} style={{ ...inputStyle, colorScheme: 'light dark' }} /></label>
                {hasFilter && <button onClick={clearAll} style={{ ...seg, border: '1px solid var(--line)', borderRadius: 9, color: 'var(--text)' }}>Clear</button>}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                {loading ? 'Loading…' : `Showing ${data.matched ?? 0} of ${data.sampled ?? 0} alert(s).`}
              </div>
            </div>

            {/* List */}
            {alerts.length === 0 && !loading ? (
              <div style={{ ...card, textAlign: 'center', color: 'var(--muted)', fontSize: 13, padding: 30 }}>
                {hasFilter ? 'No alerts match this filter.' : 'No alerts. The evaluator has not found anything worth reporting.'}
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                {alerts.map((a) => <AlertRow key={a.id} a={a} now={now} />)}
              </div>
            )}
          </>
        )}
      </div>
    </AICommandShell></OperationsShell>
  )
}

const statusCount = (s: Summary, k: string) =>
  k === 'OPEN' ? s.open : k === 'ACKNOWLEDGED' ? s.acknowledged : k === 'MUTED' ? s.muted : k === 'RESOLVED' ? s.resolved : k === 'EXPIRED' ? s.expired : s.total

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div style={card}>
      <span style={lab}>{label}</span>
      <div style={{ fontSize: 22, fontWeight: 800, color: tone ?? 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function Facet({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: FacetOption[] }) {
  if (!options.length) return null
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} style={selectStyle}>
      <option value="">{label}: all</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label} ({o.count})</option>)}
    </select>
  )
}

function RunHealth({ run, now }: { run: LastRun | null; now: number }) {
  if (!run) {
    return (
      <div style={{ ...card, borderColor: '#fbbf24', fontSize: 12.5, color: 'var(--muted)' }}>
        The alert evaluator has not completed a run yet. An empty list here does not yet mean “nothing is wrong”.
      </div>
    )
  }
  const stale = now - run.at > 60 * 60 * 1000
  const bad = !run.ok || stale
  return (
    <div style={{ ...card, borderColor: bad ? '#fbbf24' : 'var(--line)', display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', fontSize: 11.5, color: 'var(--muted)' }}>
      <span style={{ fontWeight: 700, color: run.ok ? '#34d399' : '#f87171' }}>{run.ok ? 'Evaluator healthy' : `Last run failed (${run.error ?? 'unknown'})`}</span>
      <span>Last run {ago(run.at, now)} ({run.durationMs}ms)</span>
      <span>{run.jobsRead} evaluations read</span>
      <span>{run.signals} signal(s) → {run.opened} opened, {run.resolved} resolved, {run.suppressed} suppressed</span>
      {run.skipped === 'locked' && <span>Skipped — another run held the lock</span>}
      {stale && <span style={{ color: '#fbbf24' }}>Stale — expected every 15 minutes</span>}
    </div>
  )
}

function ReadinessCard({ r }: { r: { tier: string; score: number; evaluated: number; agreementPct: number; blockers: string[] } }) {
  return (
    <div style={{ ...card, display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
      <div>
        <span style={lab}>Model readiness</span>
        <div style={{ fontSize: 15, fontWeight: 800 }}>{nice(r.tier)}</div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
        Score {r.score} · {r.evaluated} evaluated · {r.agreementPct}% agreement
      </div>
      {r.blockers.length > 0 && (
        <div style={{ fontSize: 12, color: '#f87171', flex: '1 1 240px' }}>Blockers: {r.blockers.join(' ')}</div>
      )}
      <Link href="/admin/operations/ai/shadow" style={{ ...seg, marginLeft: 'auto', border: '1px solid var(--line)', borderRadius: 9, textDecoration: 'none', color: 'var(--text)' }}>
        Readiness detail →
      </Link>
    </div>
  )
}

function AlertRow({ a, now }: { a: Alert; now: number }) {
  return (
    <Link href={`/admin/operations/ai/alerts/${a.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
      <div style={{ ...card, padding: 13, display: 'grid', gap: 6, borderLeft: `3px solid ${SEV_COLOR[a.severity] ?? 'var(--line)'}`, opacity: a.status === 'RESOLVED' || a.status === 'EXPIRED' ? 0.6 : 1 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          {a.unread && <span aria-label="unread" style={{ width: 7, height: 7, borderRadius: 999, background: SEV_COLOR[a.severity] ?? 'var(--muted)' }} />}
          <Chip text={a.severity} color={SEV_COLOR[a.severity]} />
          <Chip text={a.status} color={STATUS_COLOR[a.status]} />
          <strong style={{ fontSize: 13 }}>{nice(a.policyType)}</strong>
          {a.escalatedAt && <Chip text="ESCALATED" color="#fb923c" />}
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)' }}>{a.id} · {ago(a.lastDetectedAt, now)}</span>
        </div>
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text)', lineHeight: 1.45 }}>{a.reason}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 11, color: 'var(--muted)' }}>
          <span>Observed <strong style={{ color: 'var(--text)' }}>{a.observed}</strong> vs threshold {a.threshold}</span>
          {a.comparison !== null && <span>Baseline {a.comparison}</span>}
          <span>Sample {a.sampleSize}</span>
          {a.occurrences > 1 && <span>Seen {a.occurrences}×</span>}
          {a.model && <span>{a.model.split('/').pop()}</span>}
        </div>
      </div>
    </Link>
  )
}

export function Chip({ text, color }: { text: string; color?: string }) {
  const c = color ?? 'var(--muted)'
  return (
    <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.05em', padding: '2px 6px', borderRadius: 5, color: c, background: `color-mix(in srgb, ${c} 15%, transparent)`, border: `1px solid color-mix(in srgb, ${c} 35%, transparent)` }}>
      {text}
    </span>
  )
}
