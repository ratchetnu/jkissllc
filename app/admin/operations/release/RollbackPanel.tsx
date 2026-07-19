'use client'
// ── Release Center — controlled Rollback panel (Increment 3B.6) ──────────────
//
// Owner-authorized, typed-confirmed rollback of a business to its prior known-good production
// deployment. Appears only when a rollback target exists + the flags allow it. A SECOND typed
// confirmation (ROLLBACK <SLUG> FROM PRODUCTION) is required. In non-Production runtimes the
// server runs SIMULATED (no real promotion) — labelled clearly. Rendered inside the release
// details drawer; never publishes forward.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, TypedConfirm, Button, StatusBadge, Alert } from '../../../components/ui'
import type { Tone } from '../../../components/ui'

type RollbackView = {
  state: 'idle' | 'rolling_back' | 'restoring' | 'rolled_back' | 'failed'
  id?: string; status?: 'rolling_back' | 'completed' | 'failed'; mode?: 'live' | 'simulated'
  targetDeploymentId?: string; fromDeploymentId?: string; targetCommit?: string; failureReason?: string
}
type RollbackStatus = {
  ok: boolean; rollbackEnabled: boolean; approvalGateEnabled: boolean; mode: 'live' | 'simulated'
  ready: boolean; blocker?: { code: string; message: string }; requiredPhrase?: string
  business: { id: string; name: string; slug: string } | null
  target: { targetDeploymentId?: string; currentDeploymentId?: string; targetCommit?: string; targetUrl?: string }
  rollback: RollbackView
}

const UX_LABEL: Record<RollbackView['state'], string> = {
  idle: 'Ready to roll back', rolling_back: 'Rolling back…', restoring: 'Restoring…',
  rolled_back: 'Rolled back', failed: 'Rollback failed',
}
const NON_TERMINAL = new Set(['rolling_back'])

export function RollbackPanel({ businessId }: { businessId: string }) {
  const [status, setStatus] = useState<RollbackStatus | null>(null)
  const [load, setLoad] = useState<'loading' | 'ok' | 'error' | 'unauthorized'>('loading')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [phrase, setPhrase] = useState('')
  const [matched, setMatched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const fetchStatus = useCallback((signal: AbortSignal) => {
    fetch(`/api/admin/release/businesses/${businessId}/rollback`, { credentials: 'same-origin', cache: 'no-store', signal })
      .then(async (r) => {
        if (r.status === 401 || r.status === 403) { setLoad('unauthorized'); return }
        if (!r.ok) { setLoad('error'); return }
        setStatus(await r.json()); setLoad('ok')
      })
      .catch((e: { name?: string }) => { if (e?.name !== 'AbortError') setLoad('error') })
  }, [businessId])
  const reload = useCallback(() => { const ac = new AbortController(); abortRef.current?.abort(); abortRef.current = ac; fetchStatus(ac.signal) }, [fetchStatus])
  useEffect(() => { const ac = new AbortController(); abortRef.current = ac; fetchStatus(ac.signal); return () => ac.abort() }, [fetchStatus])
  useEffect(() => {
    if (!status || !NON_TERMINAL.has(status.rollback.status ?? '')) return
    const iv = setInterval(reload, 2500); return () => clearInterval(iv)
  }, [status, reload])

  const submit = async () => {
    if (!status?.business || !matched) return
    setBusy(true); setMsg(null)
    try {
      const res = await fetch(`/api/admin/release/businesses/${businessId}/rollback`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phrase, targetDeploymentId: status.target.targetDeploymentId }),
      })
      const j = await res.json().catch(() => ({}))
      if (res.ok && j?.ok) {
        const done = j.rollback?.state === 'rolled_back'
        setMsg({ tone: done ? 'good' : 'info', text: j.idempotent ? 'This deployment was already restored (no duplicate rollback).' : done ? `Rolled back${j.mode === 'simulated' ? ' (simulated — no real production change)' : ''}.` : 'Rolling back…' })
        setDialogOpen(false); setPhrase(''); setMatched(false); reload()
      } else { setMsg({ tone: 'bad', text: j?.message ?? 'Rollback was not performed.' }) }
    } catch { setMsg({ tone: 'bad', text: 'Rollback request failed.' }) }
    finally { setBusy(false) }
  }

  if (load === 'loading' || load === 'unauthorized' || load === 'error' || !status) return null
  if (!status.approvalGateEnabled) return null

  const r = status.rollback
  const inProgress = r.state === 'rolling_back'
  const showButton = status.rollbackEnabled && status.ready && (r.state === 'idle' || r.state === 'failed') && !busy
  const badgeTone: Tone = r.state === 'rolled_back' ? 'good' : r.state === 'failed' ? 'bad' : r.state === 'idle' ? (status.ready ? 'warn' : 'neutral') : 'info'
  const idleLabel = status.ready ? 'Ready to roll back' : 'Not available'
  const modeBadge = <StatusBadge tone={status.mode === 'live' ? 'bad' : 'info'} dot={false}>{status.mode === 'live' ? 'LIVE' : 'Simulated'}</StatusBadge>

  return (
    <section aria-label="Rollback" style={{ display: 'grid', gap: 10, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 11.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>Rollback</h3>
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <StatusBadge tone={busy ? 'info' : badgeTone}>{busy ? 'Rolling back…' : r.state === 'idle' ? idleLabel : UX_LABEL[r.state]}</StatusBadge>
          {modeBadge}
        </span>
      </div>

      {(busy || inProgress) && <Alert tone="info">Rolling back… restoring the prior production deployment…</Alert>}
      {r.state === 'rolled_back' && !busy && (
        <Alert tone="good" title="Rolled back">Production was restored to the prior deployment{r.mode === 'simulated' ? ' (simulated — no real production change was made)' : ''}{r.targetDeploymentId ? <> (<code>{r.targetDeploymentId}</code>)</> : null}.</Alert>
      )}
      {r.state === 'failed' && !busy && (
        <Alert tone="bad" title="Rollback failed">{r.failureReason ?? 'The production rollback failed.'} · Verify the target, then retry with a new typed confirmation.</Alert>
      )}
      {!showButton && r.state === 'idle' && status.blocker && status.rollbackEnabled && (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>{status.blocker.message}</div>
      )}
      {!status.rollbackEnabled && <div style={{ fontSize: 13, color: 'var(--muted)' }}>Production rollback is disabled in this environment (OPERION_PRODUCTION_PROMOTION_ENABLED is off).</div>}
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {showButton && <Button variant="danger" size="sm" onClick={() => { setMsg(null); setPhrase(''); setMatched(false); setDialogOpen(true) }}>Roll back production…</Button>}
        <Button variant="ghost" size="sm" onClick={reload} disabled={busy}>Refresh status</Button>
      </div>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} title="Roll back production to the prior deployment">
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'grid', gap: 3, fontSize: 13 }}>
            <Row k="Business">{status.business?.name} <span style={{ color: 'var(--muted)' }}>({status.business?.slug})</span></Row>
            <Row k="Roll back from"><code style={{ overflowWrap: 'anywhere' }}>{status.target.currentDeploymentId ?? 'Unavailable'}</code></Row>
            <Row k="Restore (target)"><code style={{ overflowWrap: 'anywhere' }}>{status.target.targetDeploymentId ?? 'Unavailable'}</code></Row>
            <Row k="Target commit"><code>{status.target.targetCommit?.slice(0, 12) ?? 'Unavailable'}</code></Row>
            <Row k="Execution mode">{status.mode === 'live' ? 'LIVE (real rollback)' : 'Simulated (no real production change)'}</Row>
          </div>
          <Alert tone="warn" title="Final confirmation">
            This action will <strong>restore the prior production deployment</strong> as the live production. Successful restores are idempotent; a failed attempt may be retried with a new typed confirmation. This is a controlled rollback, not a forward publish.
          </Alert>
          <TypedConfirm requiredValue={status.requiredPhrase ?? ''} label="Type the exact phrase to roll back" value={phrase} onChange={setPhrase} onMatchChange={setMatched} />
          {msg && msg.tone === 'bad' && <Alert tone="bad">{msg.text}</Alert>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={() => setDialogOpen(false)} disabled={busy}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={submit} disabled={!matched || busy}>{busy ? 'Rolling back…' : 'Roll back production'}</Button>
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
