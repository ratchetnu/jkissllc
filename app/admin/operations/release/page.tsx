'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, GitCommitHorizontal, Server, CalendarClock, Flag, AlertTriangle, CheckCircle2, XCircle, MinusCircle, Clock, Rocket, ShieldCheck, ChevronDown } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { osLabel, osMiniBtn } from '../ui'
import { Tabs } from '../../../components/ui'
import { PublishReviewDrawer } from './PublishReviewDrawer'
import { ReleaseHistoryPanel } from './ReleaseHistoryPanel'
import { ActivationReadinessPanel } from './ActivationReadinessPanel'
import { sandboxHealth, SANDBOX_HEALTH_LABEL, SANDBOX_HEALTH_TONE } from '../../../lib/platform/sandbox/health'

// ── Release Center ───────────────────────────────────────────────────────────
// The build/flags snapshot and activation-readiness views are read-only. Deliberate
// publish/rollback controls live in their separately owner-gated, typed-confirmed panels.

type CheckState = 'passed' | 'failed' | 'skipped' | 'pending' | 'not_applicable'
type VerificationLine = { label: string; state: CheckState; note?: string }
type ReleaseEntry = {
  version: string; date: string; environment: string; summary: string
  highlights: string[]; flagChanges: string[]; migrations: string
  knownIssues: string[]; rollback: string; verification: VerificationLine[]; current?: boolean
}
type FlagView = {
  name: string; label: string; description: string; category: string
  enabled: boolean; defaultEnabled: boolean; overridden: boolean; retired: boolean
}
type BuildInfo = {
  environment: string; commitSha: string | null; commitShort: string | null
  deploymentId: string | null; deploymentUrl: string | null; deployDate: string | null; available: boolean
}
type Snapshot = {
  generatedAt: number; build: BuildInfo; current: ReleaseEntry | null; history: ReleaseEntry[]
  flags: FlagView[]; flagSummary: { total: number; enabled: number; disabled: number; overridden: number }
  migration: { state: string; headline: string; detail: string }; knownIssues: string[]
}

const CATEGORY_ORDER = ['Release Automation', 'AI & Vision', 'Book Now / Intake', 'Tenancy', 'Shadow Analytics', 'Platform']

const card: React.CSSProperties = { padding: 18 }
const dash = '—'

function Chip({ children, fg, bg }: { children: React.ReactNode; fg: string; bg: string }) {
  return <span style={{ fontSize: 11, fontWeight: 800, padding: '3px 9px', borderRadius: 99, background: bg, color: fg, whiteSpace: 'nowrap' }}>{children}</span>
}

function EnvChip({ env }: { env: string }) {
  const map: Record<string, { fg: string; bg: string }> = {
    production: { fg: '#fca5a5', bg: 'rgba(239,68,68,.16)' },
    preview: { fg: '#fcd34d', bg: 'rgba(245,158,11,.15)' },
    development: { fg: '#93c5fd', bg: 'rgba(59,130,246,.15)' },
    local: { fg: '#94a3b8', bg: 'rgba(255,255,255,.06)' },
  }
  const c = map[env] ?? map.local
  return <Chip fg={c.fg} bg={c.bg}>{env}</Chip>
}

function FlagState({ enabled }: { enabled: boolean }) {
  return enabled
    ? <Chip fg="#86efac" bg="rgba(34,197,94,.16)">ON</Chip>
    : <Chip fg="#94a3b8" bg="rgba(255,255,255,.06)">OFF</Chip>
}

const CHECK: Record<CheckState, { Icon: typeof CheckCircle2; color: string; label: string }> = {
  passed: { Icon: CheckCircle2, color: '#86efac', label: 'Passed' },
  failed: { Icon: XCircle, color: '#fca5a5', label: 'Failed' },
  skipped: { Icon: MinusCircle, color: '#94a3b8', label: 'Skipped' },
  pending: { Icon: Clock, color: '#fcd34d', label: 'Pending' },
  not_applicable: { Icon: MinusCircle, color: '#94a3b8', label: 'N/A' },
}

function Section({ title, icon: Icon, children }: { title: string; icon: typeof Flag; children: React.ReactNode }) {
  return (
    <div className="os-card os-rise" style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <Icon size={17} style={{ color: 'var(--muted)' }} />
        <h2 className="jkos-h" style={{ fontSize: 16, margin: 0 }}>{title}</h2>
      </div>
      {children}
    </div>
  )
}

function KeyVal({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
      <span style={{ ...osLabel, fontSize: 10.5 }}>{k}</span>
      <span className={mono ? 'tabular-nums' : undefined} style={{ fontSize: 13, color: 'var(--text)', fontWeight: 600, textAlign: 'right', wordBreak: 'break-word' }}>{v}</span>
    </div>
  )
}

function Bullets({ items }: { items: string[] }) {
  if (!items?.length) return <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>None.</p>
  return (
    <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
      {items.map((t, i) => <li key={i} style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.45 }}>{t}</li>)}
    </ul>
  )
}

// ── Businesses (the unified release view) ────────────────────────────────────
type BizTone = 'ok' | 'attention' | 'busy' | 'critical' | 'neutral'
type BizView = {
  id: string; name: string; edition: string
  status: string; statusLabel: string; tone: BizTone; action: string; actionLabel: string
  installedVersion: string; latestVersion: string; lastUpdatedAt?: number
  detail: {
    updateSummary: string; previewStatus: string; validationSummary: string
    history: { at: number; label: string }[]; attention: string[]
    lastCheckedAt?: number; connection: string
  }
}

const TONE: Record<BizTone, { fg: string; bg: string }> = {
  ok: { fg: '#86efac', bg: 'rgba(34,197,94,.16)' },
  attention: { fg: '#fcd34d', bg: 'rgba(245,158,11,.15)' },
  busy: { fg: '#93c5fd', bg: 'rgba(59,130,246,.15)' },
  critical: { fg: '#fca5a5', bg: 'rgba(239,68,68,.16)' },
  neutral: { fg: '#94a3b8', bg: 'rgba(255,255,255,.06)' },
}
const STEPS = ['Check', 'Review', 'Test', 'Verify', 'Publish']
function activeStep(status: string): number {
  if (status === 'update_available') return 1
  if (status === 'updating' || status === 'preview_ready') return 2
  if (status === 'verification_failed') return 3
  if (status === 'ready_to_publish') return 4
  return 0
}
function timeAgo(at?: number): string {
  if (!at) return '—'
  const s = Math.max(1, Math.floor((Date.now() - at) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const LIVE_STEPS = ['Checking', 'Preparing test', 'Opening test site', 'Running safety checks', 'Ready to publish']
type Prog = { step: number; stepLabel: string; message: string; running: boolean; previewReady: boolean; blocked: boolean; canRetry: boolean; issue?: string }

function BusinessRow({ b, updatesEnabled }: { b: BizView; updatesEnabled: boolean }) {
  const [open, setOpen] = useState(false)
  const [prog, setProg] = useState<Prog | null>(null)
  const [hasJob, setHasJob] = useState(b.status === 'updating')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [reviewOpen, setReviewOpen] = useState(false)
  const ivRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const t = TONE[b.tone]
  const emphatic = b.action === 'update' || b.action === 'publish' || b.action === 'resolve' || b.action === 'retry' || b.action === 'set_up'

  const stop = () => { if (ivRef.current) { clearInterval(ivRef.current); ivRef.current = null } }
  const poll = useCallback(async () => {
    try {
      const r = await fetch(`/api/admin/release/businesses/${b.id}/update`, { credentials: 'same-origin' })
      if (!r.ok) return
      const j = await r.json()
      setHasJob(!!j.hasJob)
      if (j.progress) { setProg(j.progress); if (!j.progress.running) stop() }
    } catch { /* fail-soft */ }
  }, [b.id])
  const startPoll = useCallback(() => { stop(); poll(); ivRef.current = setInterval(poll, 3000) }, [poll])
  useEffect(() => () => stop(), [])
  // Resume progress after a page refresh mid-update — the state comes from the real job.
  useEffect(() => { if (open && b.status === 'updating') startPoll() }, [open, b.status, startPoll])

  async function send(body: object) {
    setBusy(true)
    try { await fetch(`/api/admin/release/businesses/${b.id}/update`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }
    finally { setBusy(false) }
  }
  async function onPrimary() {
    setNote('')
    // Publish opens the existing review → approval → publish workflow (the drawer). It is
    // NOT a second publish implementation and never publishes on click — the drawer keeps
    // the read-only review, owner approval, and typed publish confirmation separate.
    if (b.action === 'publish') { setReviewOpen(true); return }
    setOpen(true)
    if (b.action === 'update') {
      if (!updatesEnabled) { setNote('Updates aren’t enabled here yet.'); return }
      await send({}); startPoll()
    } else if (b.action === 'view_progress') { startPoll() }
    else if (b.action === 'retry') { await send({ action: 'retry' }); startPoll() }
    else if (b.action === 'set_up') { setNote('The setup assistant is coming next.') }
    // 'check' / others simply open the details
  }

  const step = prog ? prog.step : activeStep(b.status)
  const liveActive = hasJob || !!prog
  return (
    <div style={{ borderRadius: 14, background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', overflow: 'hidden' }}>
      {/* Header wraps on narrow screens so the trailing controls never overflow horizontally. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: '1 1 190px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 700, overflowWrap: 'anywhere' }}>{b.name}</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
            Current version <span className="tabular-nums" style={{ color: 'var(--text)', fontWeight: 600 }}>{b.installedVersion}</span>
            <span style={{ opacity: .5 }}> · Updated {timeAgo(b.lastUpdatedAt)}</span>
          </div>
        </div>
        {/* Trailing controls stay grouped and wrap as one unit under the name on mobile. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginLeft: 'auto' }}>
          <Chip fg={t.fg} bg={t.bg}>{b.statusLabel}</Chip>
          {/* Single publish entry point: the primary action opens the review→approval→publish
              workflow (the drawer). No duplicate "Review release" button. */}
          <button onClick={onPrimary} disabled={busy} className="os-tap"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 13px', borderRadius: 10, fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap', cursor: busy ? 'default' : 'pointer', opacity: busy ? .7 : 1,
              color: emphatic ? '#fff' : 'var(--text)', background: emphatic ? 'var(--red)' : 'transparent', border: emphatic ? '1px solid transparent' : '1px solid var(--line)' }}>
            {busy ? 'Working…' : b.actionLabel}
          </button>
          <button onClick={() => setOpen(v => !v)} aria-label={open ? 'Hide details' : 'View details'} aria-expanded={open} className="os-tap"
            style={{ display: 'inline-flex', padding: 7, borderRadius: 999, color: 'var(--muted)', background: 'transparent', border: '1px solid var(--line)', cursor: 'pointer' }}>
            <ChevronDown size={16} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .18s ease' }} />
          </button>
        </div>
      </div>

      {open && (
        <div style={{ padding: '4px 16px 16px', borderTop: '1px solid var(--line)', display: 'grid', gap: 14 }}>
          {note && <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '12px 0 0' }}>{note}</p>}
          <p style={{ fontSize: 13, color: 'var(--text)', margin: note ? 0 : '12px 0 0', lineHeight: 1.5 }}>{b.detail.updateSummary}</p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div><div style={{ ...osLabel, marginBottom: 4 }}>Current version</div><div className="tabular-nums" style={{ fontSize: 14, fontWeight: 700 }}>{b.installedVersion}</div></div>
            <div><div style={{ ...osLabel, marginBottom: 4 }}>Latest version</div><div className="tabular-nums" style={{ fontSize: 14, fontWeight: 700 }}>{b.latestVersion}</div></div>
          </div>

          {/* Guided flow — LIVE steps driven by the real job when one is running, else a calm preview. */}
          <div>
            <div style={{ ...osLabel, marginBottom: 8 }}>What happens next</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {(liveActive ? LIVE_STEPS : STEPS).map((s, i) => (
                <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700, padding: '4px 10px', borderRadius: 999,
                    color: i <= step ? 'var(--text)' : 'var(--muted)',
                    background: i === step ? 'color-mix(in srgb, #fff 9%, var(--card))' : 'transparent',
                    border: `1px solid ${i === step ? 'var(--line)' : 'transparent'}` }}>{s}</span>
                  {i < (liveActive ? LIVE_STEPS : STEPS).length - 1 && <span style={{ color: 'var(--muted)', opacity: .5 }}>›</span>}
                </span>
              ))}
            </div>
            {prog
              ? <p style={{ fontSize: 12, color: prog.blocked ? '#fca5a5' : 'var(--text)', margin: '8px 0 0', display: 'flex', alignItems: 'center', gap: 7 }}>
                  {prog.running && <RefreshCw size={13} style={{ animation: 'spin 1s linear infinite', color: 'var(--muted)' }} />}{prog.message}
                </p>
              : <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '6px 0 0' }}>Operion handles these steps and always pauses before changing the live site.</p>}
            {prog?.blocked && prog.issue && (
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12.5, color: '#fca5a5' }}>{prog.issue}</span>
                {prog.canRetry && <button onClick={async () => { setNote(''); await send({ action: 'retry' }); startPoll() }} disabled={busy} className="os-tap" style={{ fontSize: 12, fontWeight: 700, padding: '6px 11px', borderRadius: 9, color: 'var(--text)', background: 'transparent', border: '1px solid var(--line)', cursor: 'pointer' }}>Retry</button>}
              </div>
            )}
            {prog?.previewReady && <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '6px 0 0' }}>Your test is ready. Choose “Publish to Production” to review everything before the live site changes.</p>}
          </div>

          <div style={{ display: 'grid', gap: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Test site</span><span style={{ fontSize: 12.5, color: 'var(--text)', textAlign: 'right' }}>{b.detail.previewStatus}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Safety checks</span><span style={{ fontSize: 12.5, color: 'var(--text)', textAlign: 'right' }}>{b.detail.validationSummary}</span></div>
          </div>

          {b.detail.attention.length > 0 && (
            <div>
              <div style={{ ...osLabel, marginBottom: 6 }}>Needs attention</div>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 5 }}>
                {b.detail.attention.map((a, i) => <li key={i} style={{ fontSize: 12.5, color: '#fcd34d', lineHeight: 1.45 }}>{a}</li>)}
              </ul>
            </div>
          )}

          {b.detail.history.length > 0 && (
            <div>
              <div style={{ ...osLabel, marginBottom: 6 }}>Recent activity</div>
              <div style={{ display: 'grid', gap: 5 }}>
                {b.detail.history.map((h, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, color: 'var(--muted)' }}>
                    <span style={{ color: 'var(--text)' }}>{h.label}</span><span>{timeAgo(h.at)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <details>
            <summary style={{ ...osLabel, cursor: 'pointer', listStyle: 'none' }}>Technical details</summary>
            <div style={{ display: 'grid', gap: 4, marginTop: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, color: 'var(--muted)' }}><span>Edition</span><span style={{ color: 'var(--text)' }}>{b.edition}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, color: 'var(--muted)' }}><span>Connection</span><span style={{ color: 'var(--text)' }}>{b.detail.connection}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, color: 'var(--muted)' }}><span>Last checked</span><span style={{ color: 'var(--text)' }}>{timeAgo(b.detail.lastCheckedAt)}</span></div>
            </div>
          </details>
        </div>
      )}
      <PublishReviewDrawer businessId={b.id} businessName={b.name} open={reviewOpen} onClose={() => setReviewOpen(false)} />
    </div>
  )
}

function Businesses() {
  const [views, setViews] = useState<BizView[] | null>(null)
  const [updatesEnabled, setUpdatesEnabled] = useState(false)
  const [show, setShow] = useState(false)
  const [nonce, setNonce] = useState(0) // bump to re-fetch (e.g. after a sandbox repair)
  useEffect(() => {
    let live = true
    fetch('/api/admin/release/businesses', { credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (live && j?.businesses) { setViews(j.businesses); setUpdatesEnabled(!!j.updatesEnabled); setShow(true) } })
      .catch(() => {})
    return () => { live = false }
  }, [nonce])
  if (!show || !views) return null // owner-only: silently absent for non-owners
  return views.length === 0
    ? <Section title="Updates" icon={Rocket}><p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>No businesses have been added yet.</p></Section>
    : <div style={{ display: 'grid', gap: 10 }}>
        {views.map(b => <BusinessRow key={b.id} b={b} updatesEnabled={updatesEnabled} />)}
        <SandboxAdvanced onRepaired={() => setNonce(n => n + 1)} />
      </div>
}

// ── Advanced · Sandbox repair (owner + PREVIEW + OPERION_SANDBOX_REPAIR_ENABLED only) ──
// Renders NOTHING unless the diagnostics endpoint answers 200 — which only happens
// for a platform owner, in Preview, with the flag on. Never appears in Production.
type SandboxDiag = {
  environment: string
  records: Record<'business' | 'product' | 'reconciliation' | 'update' | 'compat', 'present' | 'malformed' | 'missing'>
  queryReturnsSandbox: boolean; currentVersion: string | null; availableVersion: string | null
  resolvedStatus: string | null; resolvedAction: string | null
  visibleBusinesses: { id: string; name: string }[]; needsRepair: boolean; notes: string[]
}
const miniDanger: React.CSSProperties = { ...osMiniBtn, color: '#fca5a5', borderColor: 'rgba(239,68,68,.4)' }

function SandboxAdvanced({ onRepaired }: { onRepaired: () => void }) {
  const [diag, setDiag] = useState<SandboxDiag | null>(null)
  const [avail, setAvail] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const check = useCallback(async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await fetch('/api/admin/release/sandbox/diagnostics', { credentials: 'same-origin' })
      if (!r.ok) { setAvail(false); return }
      const j = await r.json(); setDiag(j.diagnostics); setAvail(true)
    } catch { setAvail(false) } finally { setBusy(false) }
  }, [])
  useEffect(() => { check() }, [check])
  if (!avail) return null // hidden in Production / for non-owners / flag off

  const runRepair = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await fetch('/api/admin/release/sandbox/repair', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'operion-sandbox', confirm: 'operion-sandbox' }),
      })
      const j = await r.json()
      if (!r.ok) { setMsg(`Repair refused: ${(j.refusals || []).join(', ') || r.status}`); return }
      setDiag(j.diagnostics)
      setMsg(`Repaired. Wrote ${j.keysWritten.length} record(s), ${j.keysUnchanged.length} already valid. Live records unchanged: ${j.integrity.liveRecordsUnchanged ? 'yes' : 'NO — investigate'}.`)
      onRepaired()
    } catch { setMsg('Repair failed to run.') } finally { setBusy(false); setConfirming(false) }
  }

  const health = sandboxHealth(diag)
  const healthTone = SANDBOX_HEALTH_TONE[health]
  return (
    <div style={{ marginTop: 16, padding: 12, border: '1px solid var(--line)', borderRadius: 12, background: 'rgba(255,255,255,.02)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={osLabel}>Advanced · Sandbox</span>
        <Chip fg="#fcd34d" bg="rgba(245,158,11,.15)">PREVIEW ONLY</Chip>
        {diag && <Chip fg={healthTone.fg} bg={healthTone.bg}>{SANDBOX_HEALTH_LABEL[health]}</Chip>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={check} disabled={busy} style={osMiniBtn}>Check Sandbox</button>
          {!confirming
            ? <button onClick={() => setConfirming(true)} disabled={busy} style={miniDanger}>Repair Sandbox</button>
            : <button onClick={runRepair} disabled={busy} style={miniDanger}>Confirm — repair now</button>}
        </div>
      </div>
      {msg && <p style={{ fontSize: 12.5, color: 'var(--text)', margin: '10px 0 0' }}>{msg}</p>}
      {diag && (
        <>
          <button onClick={() => setOpen(o => !o)} style={{ ...osLabel, background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginTop: 8 }}>
            {open ? 'Hide details' : 'Show details'}
          </button>
          {open && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, display: 'grid', gap: 3 }}>
              <div>Environment: {diag.environment}</div>
              <div>Records — business: {diag.records.business}, product: {diag.records.product}, reconciliation: {diag.records.reconciliation}, update: {diag.records.update}, compat: {diag.records.compat}</div>
              <div>Query returns sandbox: {String(diag.queryReturnsSandbox)} · version {diag.currentVersion ?? '—'} → {diag.availableVersion ?? '—'} · status {diag.resolvedStatus ?? '—'} · action {diag.resolvedAction ?? '—'}</div>
              <div>Visible businesses: {diag.visibleBusinesses.map(b => b.id).join(', ') || '(none)'}</div>
              {diag.notes.map((n, i) => <div key={i}>• {n}</div>)}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ReleaseCard({ r }: { r: ReleaseEntry }) {
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 17, fontWeight: 900 }}>{r.version}</span>
        <EnvChip env={r.environment} />
        <span style={{ ...osLabel, fontSize: 10.5 }}>{r.date}</span>
      </div>
      <p style={{ fontSize: 14, color: 'var(--text)', margin: 0, lineHeight: 1.5 }}>{r.summary}</p>

      <div><div style={{ ...osLabel, marginBottom: 6 }}>Highlights</div><Bullets items={r.highlights} /></div>
      <div><div style={{ ...osLabel, marginBottom: 6 }}>Feature flags</div><Bullets items={r.flagChanges} /></div>
      <div><div style={{ ...osLabel, marginBottom: 6 }}>Migrations</div><p style={{ fontSize: 13, color: 'var(--text)', margin: 0 }}>{r.migrations}</p></div>
      <div><div style={{ ...osLabel, marginBottom: 6 }}>Known issues</div><Bullets items={r.knownIssues} /></div>
      <div><div style={{ ...osLabel, marginBottom: 6 }}>Rollback</div><p style={{ fontSize: 13, color: 'var(--text)', margin: 0 }}>{r.rollback}</p></div>

      <div>
        <div style={{ ...osLabel, marginBottom: 8 }}>Verification</div>
        <div style={{ display: 'grid', gap: 6 }}>
          {r.verification.map((v, i) => {
            const c = CHECK[v.state]
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <c.Icon size={15} style={{ color: c.color, flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: 'var(--text)' }}>{v.label}</span>
                <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 700, color: c.color }}>{c.label}</span>
                {v.note && <span className="hidden sm:inline" style={{ fontSize: 11.5, color: 'var(--muted)', flexBasis: '100%', paddingLeft: 24 }}>{v.note}</span>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function ReleaseCenter() {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'error' | 'forbidden'>('loading')
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState('updates')

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/admin/release', { credentials: 'same-origin' })
      if (res.status === 401 || res.status === 403) { setState('forbidden'); return }
      if (!res.ok) { setState('error'); return }
      setSnap(await res.json()); setState('ok')
    } catch { setState('error') }
    finally { setBusy(false) }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 className="jkos-h" style={{ fontSize: 24, margin: 0 }}>Release Center</h1>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: '4px 0 0' }}>Test updates, review what changed, and safely publish when you’re ready.</p>
        </div>
        <button onClick={load} disabled={busy} className="os-tap" aria-label="Refresh"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 13px', borderRadius: 999, fontSize: 12.5, fontWeight: 700, color: 'var(--muted)', background: 'var(--card)', border: '1px solid var(--line)', cursor: 'pointer' }}>
          <RefreshCw size={14} style={{ animation: busy ? 'spin 1s linear infinite' : undefined }} /> Refresh
        </button>
      </div>

      {state === 'loading' && (
        <div className="os-card" style={{ ...card, display: 'grid', placeItems: 'center', minHeight: 120 }}>
          <div className="skeleton" style={{ width: 160, height: 14, borderRadius: 7 }} />
        </div>
      )}

      {state === 'forbidden' && (
        <Section title="Admin access required" icon={ShieldCheck}>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>The Release Center is admin-only. Sign in with an admin account to view it.</p>
        </Section>
      )}

      {state === 'error' && (
        <Section title="Couldn't load release data" icon={AlertTriangle}>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>Something went wrong fetching the snapshot. Try refreshing.</p>
        </Section>
      )}

      {state === 'ok' && snap && (
        <>
          <div className="os-card" style={{ padding: '2px 14px 0' }}>
            <Tabs value={tab} onChange={setTab} tabs={[
              { id: 'updates', label: 'Updates' },
              { id: 'readiness', label: 'Ready Check' },
              { id: 'history', label: 'History' },
              { id: 'system', label: 'System Details' },
            ]} />
          </div>

          {tab === 'updates' && <Businesses />}

          {tab === 'readiness' && (
            <Section title="Ready Check" icon={ShieldCheck}>
              <ActivationReadinessPanel />
            </Section>
          )}

          {tab === 'history' && (
            <Section title="History" icon={Clock}>
              <ReleaseHistoryPanel />
            </Section>
          )}

          {tab === 'system' && <div style={{ display: 'grid', gap: 16 }}>
          {/* Technical information is intentionally off the default path. */}
          <Section title="Current build" icon={Server}>
            {!snap.build.available && (
              <p style={{ fontSize: 12.5, color: '#fcd34d', margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: 7 }}>
                <AlertTriangle size={14} /> Deployment metadata is unavailable (running outside a Vercel deployment). Showing what is known.
              </p>
            )}
            <div style={{ display: 'grid', gap: 0 }}>
              <KeyVal k="Environment" v={<EnvChip env={snap.build.environment} />} />
              <KeyVal k="Commit" mono v={snap.build.commitShort
                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><GitCommitHorizontal size={14} style={{ color: 'var(--muted)' }} />{snap.build.commitShort}</span>
                : dash} />
              <KeyVal k="Deployment ID" mono v={snap.build.deploymentId ?? dash} />
              <KeyVal k="Deploy / release date" v={snap.build.deployDate
                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><CalendarClock size={14} style={{ color: 'var(--muted)' }} />{snap.build.deployDate}</span>
                : dash} />
            </div>
          </Section>

          {/* Current release */}
          <Section title="Current release" icon={Rocket}>
            {snap.current ? <ReleaseCard r={snap.current} /> : <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>No release notes on record yet.</p>}
          </Section>

          {/* Feature flags stay collapsed until an owner asks for technical detail. */}
          <Section title="Feature controls" icon={Flag}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              <Chip fg="#86efac" bg="rgba(34,197,94,.16)">{snap.flagSummary.enabled} on</Chip>
              <Chip fg="#94a3b8" bg="rgba(255,255,255,.06)">{snap.flagSummary.disabled} off</Chip>
              <Chip fg="#fcd34d" bg="rgba(245,158,11,.15)">{snap.flagSummary.overridden} non-default</Chip>
            </div>
            <details>
              <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>View feature controls</summary>
              <div style={{ display: 'grid', gap: 16, marginTop: 14 }}>
              {CATEGORY_ORDER.filter(cat => snap.flags.some(f => f.category === cat)).map(cat => (
                <div key={cat}>
                  <div style={{ ...osLabel, marginBottom: 8 }}>{cat}</div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {snap.flags.filter(f => f.category === cat).map(f => (
                      <div key={f.name} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderRadius: 12, background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 13.5, fontWeight: 700 }}>{f.label}</span>
                            {f.retired && <Chip fg="#fca5a5" bg="rgba(239,68,68,.16)">retired</Chip>}
                            {f.overridden && !f.retired && <Chip fg="#fcd34d" bg="rgba(245,158,11,.15)">non-default</Chip>}
                          </div>
                          <p style={{ fontSize: 12, color: 'var(--muted)', margin: '3px 0 0', lineHeight: 1.4 }}>{f.description}</p>
                          <p className="tabular-nums" style={{ fontSize: 10.5, color: 'var(--muted)', margin: '4px 0 0', opacity: .7 }}>{f.name} · default {f.defaultEnabled ? 'ON' : 'OFF'}</p>
                        </div>
                        <FlagState enabled={f.enabled} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              </div>
            </details>
          </Section>

          {/* Migration status */}
          <Section title="Migration status" icon={GitCommitHorizontal}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
              <CheckCircle2 size={16} style={{ color: snap.migration.state === 'none_pending' ? '#86efac' : '#fcd34d' }} />
              <span style={{ fontSize: 14, fontWeight: 700 }}>{snap.migration.headline}</span>
            </div>
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0, lineHeight: 1.5 }}>{snap.migration.detail}</p>
          </Section>

          {/* Standing known issues */}
          <Section title="Known issues & notes" icon={AlertTriangle}>
            <Bullets items={snap.knownIssues} />
          </Section>

          {/* Earlier release notes */}
          {snap.history.length > 0 && (
            <Section title="Earlier releases" icon={Clock}>
              <div style={{ display: 'grid', gap: 20 }}>
                {snap.history.map((r, i) => <ReleaseCard key={i} r={r} />)}
              </div>
            </Section>
          )}
          </div>}

          <p style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', margin: '4px 0 0' }}>
            Last checked {new Date(snap.generatedAt).toLocaleString()}
          </p>
        </>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}

export default function ReleaseCenterPage() {
  return <OperationsShell><ReleaseCenter /></OperationsShell>
}
