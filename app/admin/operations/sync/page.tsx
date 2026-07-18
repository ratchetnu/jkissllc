'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  RefreshCw, Boxes, CheckCircle2, AlertTriangle, GitCompareArrows, XCircle, Clock, GitFork, Server,
  ChevronRight, Rocket, GitBranch, ShieldCheck, HelpCircle, MinusCircle,
} from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { osLabel } from '../ui'
import type {
  SyncDashboardSummary, ProductStatusSnapshot, SignalState, PlatformSyncStatus, DeploymentStatus, ReconciliationRecord,
} from '../../../lib/platform/sync/types'

type Detail = {
  product: {
    id: string; displayName: string; productType: string; status: string
    githubOwner?: string; githubRepo?: string; defaultBranch: string
    deploymentProvider: string; vercelProject?: string; productionUrl?: string
    platformSourceId?: string | null; supportsPlatformSync: boolean; supportsDeploymentTracking: boolean
  }
  source?: { id: string; displayName: string } | null
  latest: ReconciliationRecord | null
  history: ReconciliationRecord[]
  recommendedActions: string[]
}

const card: React.CSSProperties = { padding: 18 }

function Chip({ children, fg, bg }: { children: React.ReactNode; fg: string; bg: string }) {
  return <span style={{ fontSize: 11, fontWeight: 800, padding: '3px 9px', borderRadius: 99, background: bg, color: fg, whiteSpace: 'nowrap' }}>{children}</span>
}

const STATE_CHIP: Record<SignalState, { fg: string; bg: string; label: string }> = {
  ok: { fg: '#86efac', bg: 'rgba(34,197,94,.16)', label: 'OK' },
  attention: { fg: '#fcd34d', bg: 'rgba(245,158,11,.15)', label: 'Attention' },
  unknown: { fg: '#94a3b8', bg: 'rgba(255,255,255,.06)', label: 'Unknown' },
  not_applicable: { fg: '#94a3b8', bg: 'rgba(255,255,255,.05)', label: 'N/A' },
}

function StateChip({ state, label }: { state: SignalState; label?: string }) {
  const c = STATE_CHIP[state]
  return <Chip fg={c.fg} bg={c.bg}>{label ?? c.label}</Chip>
}

function Tile({ icon: Icon, label, value, tone }: { icon: typeof Boxes; label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="os-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Icon size={15} style={{ color: 'var(--muted)' }} />
        <span style={{ ...osLabel, fontSize: 10.5 }}>{label}</span>
      </div>
      <span style={{ fontSize: 22, fontWeight: 900, color: tone ?? 'var(--text)' }}>{value}</span>
    </div>
  )
}

function Section({ title, icon: Icon, children, right }: { title: string; icon: typeof Boxes; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="os-card os-rise" style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <Icon size={17} style={{ color: 'var(--muted)' }} />
        <h2 className="jkos-h" style={{ fontSize: 16, margin: 0 }}>{title}</h2>
        {right && <div style={{ marginLeft: 'auto' }}>{right}</div>}
      </div>
      {children}
    </div>
  )
}

function Row({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--hair,rgba(255,255,255,.06))' }}>
      <span style={{ fontSize: 12.5, color: 'var(--muted)', minWidth: 150 }}>{k}</span>
      <span style={{ fontSize: 12.5, color: 'var(--text)', fontFamily: mono ? 'monospace' : undefined, marginLeft: 'auto', textAlign: 'right' }}>{v}</span>
    </div>
  )
}

const dash = '—'
function ts(n?: number): string { return n ? new Date(n).toLocaleString() : dash }
function yesno(b: boolean): React.ReactNode {
  return b ? <span style={{ color: '#86efac', fontWeight: 700 }}>Yes</span> : <span style={{ color: 'var(--muted)' }}>No</span>
}

function ProviderChip({ label, view }: { label: string; view: { configured: boolean; ok: boolean } }) {
  const c = !view.configured ? { fg: '#94a3b8', bg: 'rgba(255,255,255,.06)', t: 'Not configured' }
    : view.ok ? { fg: '#86efac', bg: 'rgba(34,197,94,.16)', t: 'Connected' }
    : { fg: '#fca5a5', bg: 'rgba(239,68,68,.16)', t: 'Error' }
  return <Tile icon={label === 'GitHub' ? GitFork : Server} label={`${label} Status`} value={<Chip fg={c.fg} bg={c.bg}>{c.t}</Chip>} />
}

// ── Platform Status panel ─────────────────────────────────────────────────────
function PlatformPanel({ ps, sourceName }: { ps: PlatformSyncStatus; sourceName?: string }) {
  if (!ps.applicable) return <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>Platform sync not tracked for this product.</p>
  return (
    <div>
      <Row k="Current baseline" v={ps.currentBaselineVersion ? `${ps.currentBaselineVersion} · ${(ps.currentBaselineCommit ?? '').slice(0, 7) || dash}` : dash} />
      <Row k="Latest available" v={ps.latestBaselineVersion ? `${ps.latestBaselineVersion} · ${(ps.latestBaselineCommit ?? '').slice(0, 7) || dash}` : (ps.latestBaselineCommit ?? '').slice(0, 7) || dash} />
      <Row k="Commits behind" v={ps.commitsBehind != null ? String(ps.commitsBehind) : dash} />
      <Row k="Compatibility" v={ps.compatibility} />
      <Row k="Update available" v={yesno(ps.updateAvailable)} />
      <Row k="Safe to sync" v={yesno(ps.safeToSync)} />
      <Row k="Source" v={sourceName ?? dash} />
      {(ps.detail || ps.error) && <p style={{ fontSize: 12, color: ps.error ? '#fca5a5' : 'var(--muted)', margin: '10px 0 0' }}>{ps.error ?? ps.detail}</p>}
    </div>
  )
}

// ── Deployment Status panel ───────────────────────────────────────────────────
function DeploymentPanel({ d }: { d: DeploymentStatus }) {
  if (!d.applicable) return <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>Deployment tracking not enabled for this product.</p>
  return (
    <div>
      <Row k="Deployment commit" v={d.commitLabel} mono={d.gitConnected} />
      <Row k="Latest commit on main" v={d.mainCommit ? d.mainCommit.slice(0, 7) : (d.gitConnected ? dash : 'N/A (CLI Deployment)')} mono={!!d.mainCommit} />
      <Row k="Deployment timestamp" v={ts(d.deployedAt)} />
      <Row k="Deployment health" v={d.health} />
      <Row k="Environment" v={d.environment} />
      <Row k="Up to date" v={d.gitConnected ? yesno(d.upToDate) : <span style={{ color: '#86efac', fontWeight: 700 }}>Verified</span>} />
      {(d.detail || d.error) && <p style={{ fontSize: 12, color: d.error ? '#fca5a5' : 'var(--muted)', margin: '10px 0 0' }}>{d.error ?? d.detail}</p>}
    </div>
  )
}

// ── Product roster row ────────────────────────────────────────────────────────
function ProductRow({ p, onOpen }: { p: ProductStatusSnapshot; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="os-card" style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', cursor: 'pointer', background: 'var(--card,rgba(255,255,255,.03))', border: '1px solid var(--hair,rgba(255,255,255,.08))' }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>{p.displayName}</div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{p.productType.replace(/_/g, ' ')} · {p.productId}{p.failed ? ' · reconcile failed' : ''}</div>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}><span style={{ fontSize: 10, color: 'var(--muted)' }}>Platform</span><StateChip state={p.platformSync.state} label={p.platformSync.applicable ? (p.platformSync.updateAvailable ? `${p.platformSync.commitsBehind ?? ''} behind`.trim() : STATE_CHIP[p.platformSync.state].label) : 'N/A'} /></div>
          <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}><span style={{ fontSize: 10, color: 'var(--muted)' }}>Deploy</span><StateChip state={p.deployment.state} label={p.deployment.applicable ? p.deployment.statusLabel : 'N/A'} /></div>
        </div>
        <ChevronRight size={16} style={{ color: 'var(--muted)' }} />
      </div>
    </button>
  )
}

// ── Drill-down ────────────────────────────────────────────────────────────────
function Drilldown({ id, flagEnabled, onClose, onChanged }: { id: string; flagEnabled: boolean; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setState('loading')
    try {
      const res = await fetch(`/api/admin/platform/sync/products/${id}`, { credentials: 'same-origin' })
      if (!res.ok) { setState('error'); return }
      setDetail(await res.json()); setState('ok')
    } catch { setState('error') }
  }, [id])
  useEffect(() => { load() }, [load])

  const reconcile = async () => {
    setBusy(true)
    try {
      await fetch(`/api/admin/platform/sync/products/${id}/reconcile`, { method: 'POST', credentials: 'same-origin' })
      await load(); onChanged()
    } finally { setBusy(false) }
  }

  if (state === 'loading') return <Section title="Loading…" icon={Clock}><div /></Section>
  if (state === 'error' || !detail) return <Section title="Product" icon={AlertTriangle}><p style={{ color: '#fca5a5' }}>Could not load product detail.</p></Section>

  const rec = detail.latest
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 className="jkos-h" style={{ fontSize: 20, margin: 0 }}>{detail.product.displayName}</h2>
        <Chip fg="#93c5fd" bg="rgba(59,130,246,.15)">{detail.product.productType.replace(/_/g, ' ')}</Chip>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={reconcile} disabled={busy || !flagEnabled} title={flagEnabled ? 'Reconcile now (read-only)' : 'Enable OPERION_SYNC_STATUS_ENABLED to reconcile'} style={btn(flagEnabled ? 'primary' : 'ghost')}>
            <RefreshCw size={14} style={{ animation: busy ? 'spin 1s linear infinite' : undefined }} /> Reconcile now
          </button>
          <button onClick={onClose} style={btn('ghost')}>Close</button>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))' }}>
        <Section title="Platform Status" icon={GitCompareArrows}>
          {rec ? <PlatformPanel ps={rec.platformSync} sourceName={detail.source?.displayName} /> : <NoRec />}
        </Section>
        <Section title="Deployment Status" icon={Rocket}>
          {rec ? <DeploymentPanel d={rec.deployment} /> : <NoRec />}
        </Section>
      </div>

      <Section title="Compatibility Analysis" icon={ShieldCheck}>
        {rec && rec.platformSync.applicable ? (
          <div>
            <Row k="Compatibility" v={rec.platformSync.compatibility} />
            <Row k="Update available" v={yesno(rec.platformSync.updateAvailable)} />
            <Row k="Safe to sync" v={yesno(rec.platformSync.safeToSync)} />
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '10px 0 0' }}>
              Compatibility is derived from baseline drift; a behind-but-uncompared product reads “unknown” until a compatibility review runs. Nothing here triggers a sync.
            </p>
          </div>
        ) : <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>Platform sync is not applicable for this product.</p>}
      </Section>

      <Section title="Recommended Actions" icon={AlertTriangle}>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
          {detail.recommendedActions.map((a, i) => <li key={i} style={{ fontSize: 13, color: 'var(--text)' }}>{a}</li>)}
        </ul>
      </Section>

      <Section title="Recent Sync History" icon={Clock}>
        {detail.history.length === 0 ? <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>No reconciliations recorded yet.</p> : (
          <div style={{ display: 'grid', gap: 8 }}>
            {detail.history.map((h) => (
              <div key={h.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--hair,rgba(255,255,255,.06))' }}>
                <span style={{ fontSize: 12, color: 'var(--muted)', minWidth: 160 }}>{ts(h.checkedAt)}</span>
                <Chip fg="#cbd5e1" bg="rgba(255,255,255,.06)">{h.trigger}</Chip>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  <StateChip state={h.platformSync.state} label={`P:${STATE_CHIP[h.platformSync.state].label}`} />
                  <StateChip state={h.deployment.state} label={`D:${STATE_CHIP[h.deployment.state].label}`} />
                  {h.failed && <Chip fg="#fca5a5" bg="rgba(239,68,68,.16)">failed</Chip>}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}

function NoRec() { return <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0, display: 'flex', gap: 6, alignItems: 'center' }}><HelpCircle size={15} /> Not yet reconciled.</p> }

function btn(variant: 'primary' | 'ghost'): React.CSSProperties {
  const base: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 700, padding: '7px 12px', borderRadius: 8, cursor: 'pointer', border: '1px solid var(--hair,rgba(255,255,255,.12))' }
  return variant === 'primary'
    ? { ...base, background: 'var(--red,#E0002A)', color: '#fff', borderColor: 'transparent' }
    : { ...base, background: 'transparent', color: 'var(--text)' }
}

// ── Page ──────────────────────────────────────────────────────────────────────
function SyncStatus() {
  const [dash_, setDash] = useState<SyncDashboardSummary | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'error' | 'forbidden'>('loading')
  const [busy, setBusy] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/admin/platform/sync', { credentials: 'same-origin' })
      if (res.status === 401 || res.status === 403) { setState('forbidden'); return }
      if (!res.ok) { setState('error'); return }
      const body = await res.json()
      setDash(body.dashboard); setState('ok')
    } catch { setState('error') }
    finally { setBusy(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const action = async (action: 'seed' | 'reconcile-all') => {
    setBusy(true)
    try {
      await fetch('/api/admin/platform/sync', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) })
      await load()
    } finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 className="jkos-h" style={{ fontSize: 24, margin: 0 }}>Sync Status</h1>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: '4px 0 0' }}>Live platform-sync + deployment status for every product Operion runs. Read-only — no repository writes, no deployment automation.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => action('reconcile-all')} disabled={busy || !dash_?.flagEnabled} title={dash_?.flagEnabled ? 'Reconcile all products (read-only)' : 'Enable OPERION_SYNC_STATUS_ENABLED to reconcile'} style={btn(dash_?.flagEnabled ? 'primary' : 'ghost')}>
            <GitCompareArrows size={14} /> Reconcile all
          </button>
          <button onClick={load} disabled={busy} style={btn('ghost')}><RefreshCw size={14} style={{ animation: busy ? 'spin 1s linear infinite' : undefined }} /> Refresh</button>
        </div>
      </div>

      {state === 'forbidden' && <div className="os-card" style={{ ...card, color: '#fca5a5' }}>Platform-owner access required.</div>}
      {state === 'error' && <div className="os-card" style={{ ...card, color: '#fca5a5' }}>Could not load the Sync Status dashboard.</div>}

      {state === 'ok' && dash_ && (
        <>
          {!dash_.flagEnabled && (
            <div className="os-card" style={{ ...card, display: 'flex', gap: 10, alignItems: 'center' }}>
              <MinusCircle size={18} style={{ color: '#fcd34d' }} />
              <span style={{ fontSize: 13, color: 'var(--text)' }}>Reconciliation is <b>disabled</b> (<code>OPERION_SYNC_STATUS_ENABLED</code> is off). The registry and last-known status are shown; live GitHub/Vercel checks are inert until the flag is enabled.</span>
            </div>
          )}

          {/* Global summary */}
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}>
            <Tile icon={Boxes} label="Products Registered" value={dash_.productsRegistered} />
            <Tile icon={CheckCircle2} label="Products Current" value={dash_.productsCurrent} tone="#86efac" />
            <Tile icon={GitBranch} label="Products Behind" value={dash_.productsBehind} tone={dash_.productsBehind ? '#fcd34d' : undefined} />
            <Tile icon={GitCompareArrows} label="Syncs Available" value={dash_.syncsAvailable} tone={dash_.syncsAvailable ? '#fcd34d' : undefined} />
            <Tile icon={XCircle} label="Failed Reconciliations" value={dash_.failedReconciliations} tone={dash_.failedReconciliations ? '#fca5a5' : undefined} />
            <Tile icon={Clock} label="Last Global Sync" value={<span style={{ fontSize: 13 }}>{dash_.lastGlobalSyncAt ? new Date(dash_.lastGlobalSyncAt).toLocaleString() : 'Never'}</span>} />
            <ProviderChip label="GitHub" view={dash_.github} />
            <ProviderChip label="Vercel" view={dash_.vercel} />
          </div>

          {/* Roster */}
          <Section title="Products" icon={Boxes} right={dash_.products.length === 0 ? <button onClick={() => action('seed')} disabled={busy} style={btn('primary')}>Seed products</button> : undefined}>
            {dash_.products.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>No products registered yet. Seed the initial roster or register one via the API.</p>
            ) : (
              <div style={{ display: 'grid', gap: 10 }}>
                {dash_.products.map((p) => <ProductRow key={p.productId} p={p} onOpen={() => setOpenId(p.productId)} />)}
              </div>
            )}
          </Section>

          {openId && (
            <div className="os-card" style={{ ...card }}>
              <Drilldown id={openId} flagEnabled={dash_.flagEnabled} onClose={() => setOpenId(null)} onChanged={load} />
            </div>
          )}

          <p style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', margin: '4px 0 0' }}>Read-only · reconciles by reading GitHub + Vercel · writes nothing to any repository or deployment.</p>
        </>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}

export default function SyncStatusPage() {
  return <OperationsShell><SyncStatus /></OperationsShell>
}
