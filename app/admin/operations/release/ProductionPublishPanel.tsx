'use client'
// ── Release Center — Production Publish panel (Increment 3B.4) ───────────────
//
// The controlled publish action: appears ONLY when an active approval + the flags make the
// release publishable. A SECOND typed confirmation (PUBLISH <SLUG> TO PRODUCTION) is required.
// It performs a single owner-only POST that CONSUMES the approval and promotes the approved
// Preview deployment. In non-Production runtimes the server runs SIMULATED mode (no real
// promotion) — the panel labels this clearly. No rollback/retry this phase.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, TypedConfirm, Button, StatusBadge, Alert } from '../../../components/ui'
import type { Tone } from '../../../components/ui'

type PublishView = {
  state: 'idle' | 'publishing' | 'queued' | 'verifying' | 'ready' | 'failed'
  id?: string; status?: 'promoting' | 'verifying' | 'completed' | 'failed'; mode?: 'live' | 'simulated'
  releaseId?: string; sourceDeploymentId?: string; promotedDeploymentId?: string
  failureReason?: string; startedAt?: number; completedAt?: number
}
type PublishStatus = {
  ok: boolean
  publishEnabled: boolean
  approvalGateEnabled: boolean
  mode: 'live' | 'simulated'
  ready: boolean
  blocker?: { code: string; message: string }
  requiredPhrase?: string
  business: { id: string; name: string; slug: string } | null
  release: { releaseId?: string; sourceDeploymentId?: string; targetEnvironment: string }
  approval: { approvedAt: number; expiresAt: number } | null
  publish: PublishView
}

const UX_LABEL: Record<PublishView['state'], string> = {
  idle: 'Ready to publish', publishing: 'Publishing…', queued: 'Promotion queued…',
  verifying: 'Verifying Production…', ready: 'Production READY', failed: 'Publish failed',
}
const NON_TERMINAL = new Set(['promoting', 'verifying'])

function ageLabel(ms: number | undefined): string {
  if (ms == null) return 'Unavailable'
  const m = Math.floor(ms / 60000)
  return m < 1 ? 'just now' : `${m}m ago`
}

export function ProductionPublishPanel({ businessId }: { businessId: string }) {
  const [status, setStatus] = useState<PublishStatus | null>(null)
  const [load, setLoad] = useState<'loading' | 'ok' | 'error' | 'unauthorized'>('loading')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [phrase, setPhrase] = useState('')
  const [matched, setMatched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const fetchStatus = useCallback((signal: AbortSignal) => {
    fetch(`/api/admin/release/businesses/${businessId}/publish`, { credentials: 'same-origin', cache: 'no-store', signal })
      .then(async (r) => {
        if (r.status === 401 || r.status === 403) { setLoad('unauthorized'); return }
        if (!r.ok) { setLoad('error'); return }
        setStatus(await r.json()); setLoad('ok')
      })
      .catch((e: { name?: string }) => { if (e?.name !== 'AbortError') setLoad('error') })
  }, [businessId])

  const reload = useCallback(() => { const ac = new AbortController(); abortRef.current?.abort(); abortRef.current = ac; fetchStatus(ac.signal) }, [fetchStatus])
  useEffect(() => { const ac = new AbortController(); abortRef.current = ac; fetchStatus(ac.signal); return () => ac.abort() }, [fetchStatus])

  // Poll only while a publish is genuinely in a non-terminal state (promoting/verifying).
  // Synchronous execution usually resolves before the first tick; this covers cross-session
  // viewing and the LIVE verifying window. Never polls once terminal.
  useEffect(() => {
    if (!status || !NON_TERMINAL.has(status.publish.status ?? '')) return
    const iv = setInterval(reload, 2500)
    return () => clearInterval(iv)
  }, [status, reload])

  const submit = async () => {
    if (!status?.business || !matched) return
    setBusy(true); setMsg(null)
    try {
      const res = await fetch(`/api/admin/release/businesses/${businessId}/publish`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phrase, releaseId: status.release.releaseId, sourceDeploymentId: status.release.sourceDeploymentId }),
      })
      const j = await res.json().catch(() => ({}))
      if (res.ok && j?.ok) {
        const done = j.publish?.state === 'ready'
        setMsg({ tone: done ? 'good' : 'info', text: j.idempotent ? 'This release was already published (no duplicate promotion).' : done ? `Production READY${j.mode === 'simulated' ? ' (simulated — no real production change)' : ''}.` : 'Publishing…' })
        setDialogOpen(false); setPhrase(''); setMatched(false); reload()
      } else {
        setMsg({ tone: 'bad', text: j?.message ?? 'Publish was not performed.' })
      }
    } catch { setMsg({ tone: 'bad', text: 'Publish request failed.' }) }
    finally { setBusy(false) }
  }

  if (load === 'loading') return null
  if (load === 'unauthorized') return null
  if (load === 'error' || !status) return null
  // Only relevant once the approval gate is enabled at all.
  if (!status.approvalGateEnabled) return null

  const p = status.publish
  const inProgress = p.state === 'queued' || p.state === 'verifying'
  const showButton = status.publishEnabled && status.ready && (p.state === 'idle' || p.state === 'failed') && !busy
  const badgeTone: Tone = p.state === 'ready' ? 'good' : p.state === 'failed' ? 'bad' : p.state === 'idle' ? (status.ready ? 'good' : 'neutral') : 'info'
  // The idle badge must be truthful: "Ready to publish" only when actually publishable.
  const idleLabel = status.ready ? 'Ready to publish' : 'Not ready'
  const badgeLabel = busy ? UX_LABEL.publishing : p.state === 'idle' ? idleLabel : UX_LABEL[p.state]
  const modeBadge = <StatusBadge tone={status.mode === 'live' ? 'bad' : 'info'} dot={false}>{status.mode === 'live' ? 'LIVE' : 'Simulated'}</StatusBadge>

  return (
    <section aria-label="Production publish" style={{ display: 'grid', gap: 10, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 11.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>Publish to production</h3>
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <StatusBadge tone={busy ? 'info' : badgeTone}>{badgeLabel}</StatusBadge>
          {modeBadge}
        </span>
      </div>

      {/* Progress / outcome — truthful states only */}
      {(busy || inProgress) && (
        <Alert tone="info">{busy ? 'Publishing…' : p.state === 'verifying' ? 'Verifying Production…' : 'Promotion queued…'}</Alert>
      )}
      {p.state === 'ready' && !busy && (
        <Alert tone="good" title="Production READY">
          The approved Preview deployment was promoted to Production{p.mode === 'simulated' ? ' (simulated — no real production change was made)' : ''}.
          {p.promotedDeploymentId ? <> Deployment <code>{p.promotedDeploymentId}</code>.</> : null}
        </Alert>
      )}
      {p.state === 'failed' && !busy && (
        <Alert tone="bad" title="Publish failed">
          {p.failureReason ?? 'The production promotion failed.'} · Retry is not available in this phase · Rollback is not implemented yet.
        </Alert>
      )}

      {/* Not-ready reason (only when the gate is enabled and something blocks) */}
      {!showButton && p.state === 'idle' && status.blocker && status.publishEnabled && (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>{status.blocker.message}</div>
      )}
      {!status.publishEnabled && (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>Production publish is disabled in this environment (OPERION_PRODUCTION_PROMOTION_ENABLED is off).</div>
      )}

      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {showButton && <Button variant="danger" size="sm" onClick={() => { setMsg(null); setPhrase(''); setMatched(false); setDialogOpen(true) }}>Publish to Production…</Button>}
        <Button variant="ghost" size="sm" onClick={reload} disabled={busy}>Refresh status</Button>
      </div>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} title="Publish this release to Production">
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'grid', gap: 3, fontSize: 13 }}>
            <Row k="Business">{status.business?.name} <span style={{ color: 'var(--muted)' }}>({status.business?.slug})</span></Row>
            <Row k="Source (Preview) deployment"><code style={{ overflowWrap: 'anywhere' }}>{status.release.sourceDeploymentId ?? 'Unavailable'}</code></Row>
            <Row k="Target environment">Production</Row>
            <Row k="Commit"><code>{status.release.releaseId?.slice(0, 12) ?? 'Unavailable'}</code></Row>
            <Row k="Deployment ID"><code style={{ overflowWrap: 'anywhere' }}>{status.release.sourceDeploymentId ?? 'Unavailable'}</code></Row>
            <Row k="Approval age">{status.approval ? ageLabel(Date.now() - status.approval.approvedAt) : 'Unavailable'}</Row>
            <Row k="Execution mode">{status.mode === 'live' ? 'LIVE (real promotion)' : 'Simulated (no real production change)'}</Row>
          </div>
          <Alert tone="warn" title="Final confirmation">
            This action will <strong>promote the approved Preview deployment into Production</strong>. It consumes the approval
            (single-use) and cannot be retried; rollback is not implemented yet.
          </Alert>
          <TypedConfirm requiredValue={status.requiredPhrase ?? ''} label="Type the exact phrase to publish" value={phrase} onChange={setPhrase} onMatchChange={setMatched} />
          {msg && msg.tone === 'bad' && <Alert tone="bad">{msg.text}</Alert>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={() => setDialogOpen(false)} disabled={busy}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={submit} disabled={!matched || busy}>{busy ? 'Publishing…' : 'Publish to Production'}</Button>
          </div>
        </div>
      </Dialog>
    </section>
  )
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ color: 'var(--muted)' }}>{k}</span>
      <span style={{ color: 'var(--text)', textAlign: 'right', minWidth: 0, overflowWrap: 'anywhere' }}>{children}</span>
    </div>
  )
}
