'use client'
// ── Release Center — owner Approval + typed-confirmation panel (Increment 3B.3) ──
//
// A SEPARATE, explicit footer workflow beneath the read-only Publish Review. It never
// publishes, deploys, rolls back, or mutates a business — it records a single-use, short-
// lived, release-bound APPROVAL after the owner types the exact release phrase. The Publish
// Review drawer stays read-only; this panel does its own owner-gated GET/POST/DELETE and is
// the ONLY interactive release action here. There is NO publish button (that is a later phase).

import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, TypedConfirm, Button, StatusBadge, Alert } from '../../../components/ui'
import type { Tone } from '../../../components/ui'

type ApprovalView = {
  state: 'none' | 'active' | 'expired' | 'invalidated' | 'consumed' | 'revoked'
  label: string
  id?: string; releaseId?: string; sourceDeploymentId?: string; targetEnvironment?: string
  approvedBy?: string; approvedAt?: number; expiresAt?: number
}
type ApprovalStatus = {
  ok: boolean
  gateEnabled: boolean
  business: { id: string; name: string; slug: string; testOnly: boolean } | null
  eligible: boolean
  blockingCount: number
  previewReady: boolean
  requiredPhrase?: string
  release: { releaseId?: string; sourceDeploymentId?: string; targetEnvironment: string }
  approval: ApprovalView
}

const stateTone: Record<ApprovalView['state'], Tone> = {
  none: 'neutral', active: 'good', expired: 'warn', invalidated: 'warn', consumed: 'info', revoked: 'neutral',
}

function expiresInLabel(expiresAt?: number): string {
  if (!expiresAt) return ''
  const ms = expiresAt - Date.now()
  if (ms <= 0) return 'expired'
  const m = Math.floor(ms / 60000)
  return m < 1 ? 'expires in <1m' : `expires in ${m}m`
}

export function ReleaseApprovalPanel({ businessId }: { businessId: string }) {
  const [status, setStatus] = useState<ApprovalStatus | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ok' | 'error' | 'unauthorized'>('loading')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [phrase, setPhrase] = useState('')
  const [matched, setMatched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback((signal: AbortSignal) => {
    setLoadState('loading')
    fetch(`/api/admin/release/businesses/${businessId}/approval`, { credentials: 'same-origin', cache: 'no-store', signal })
      .then(async (r) => {
        if (r.status === 401 || r.status === 403) { setLoadState('unauthorized'); return }
        if (!r.ok) { setLoadState('error'); return }
        setStatus(await r.json()); setLoadState('ok')
      })
      .catch((e: { name?: string }) => { if (e?.name !== 'AbortError') setLoadState('error') })
  }, [businessId])

  const reload = useCallback(() => {
    const ac = new AbortController(); abortRef.current?.abort(); abortRef.current = ac; load(ac.signal)
  }, [load])

  useEffect(() => { const ac = new AbortController(); abortRef.current = ac; load(ac.signal); return () => ac.abort() }, [load])

  const submit = async () => {
    if (!status?.business || !matched) return
    setBusy(true); setMsg(null)
    try {
      const res = await fetch(`/api/admin/release/businesses/${businessId}/approval`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phrase, releaseId: status.release.releaseId, sourceDeploymentId: status.release.sourceDeploymentId, targetEnvironment: status.release.targetEnvironment }),
      })
      const j = await res.json().catch(() => ({}))
      if (res.ok && j?.ok) {
        setMsg({ tone: 'good', text: j.reused ? 'An active approval already covers this release.' : 'Approval recorded. This does not publish — a later step performs the publish.' })
        setDialogOpen(false); setPhrase(''); setMatched(false); reload()
      } else {
        setMsg({ tone: 'bad', text: j?.message ?? 'Approval was not recorded.' }) // sanitized server message
      }
    } catch { setMsg({ tone: 'bad', text: 'Approval request failed.' }) }
    finally { setBusy(false) }
  }

  const revoke = async () => {
    setBusy(true); setMsg(null)
    try {
      const res = await fetch(`/api/admin/release/businesses/${businessId}/approval`, { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' })
      if (res.ok) { setMsg({ tone: 'neutral', text: 'Approval revoked.' }); reload() } else { setMsg({ tone: 'bad', text: 'Could not revoke.' }) }
    } catch { setMsg({ tone: 'bad', text: 'Revoke failed.' }) }
    finally { setBusy(false) }
  }

  if (loadState === 'loading') return <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading approval status…</div>
  if (loadState === 'unauthorized') return <div role="alert" style={{ fontSize: 13, color: 'var(--muted)' }}>Owner access is required.</div>
  if (loadState === 'error' || !status) return <div role="alert" style={{ fontSize: 13, color: 'var(--status-bad-fg)' }}>Could not load approval status.</div>

  const a = status.approval
  const canApprove = status.gateEnabled && !!status.business && !status.business.testOnly && status.eligible && status.previewReady
  const reason = !status.gateEnabled ? 'The approval gate is not enabled in this environment.'
    : status.business?.testOnly ? 'This business is test-only — it cannot be approved for production.'
    : !status.eligible ? `Not eligible — ${status.blockingCount} blocking issue(s). Resolve them (see Eligibility above) before approving.`
    : !status.previewReady ? 'The preview is not READY yet.'
    : null
  const showApproveButton = canApprove && (a.state === 'none' || a.state === 'expired' || a.state === 'invalidated' || a.state === 'revoked')

  return (
    <section aria-label="Release approval" style={{ display: 'grid', gap: 10, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 11.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>Approval gate</h3>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <StatusBadge tone={stateTone[a.state]}>{a.label}</StatusBadge>
          {a.state === 'active' && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{expiresInLabel(a.expiresAt)}</span>}
        </span>
      </div>

      {a.state === 'active' && (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', display: 'grid', gap: 2 }}>
          <div>Approved by <strong style={{ color: 'var(--text)' }}>{a.approvedBy}</strong> · release <code>{a.releaseId?.slice(0, 7)}</code> → {a.targetEnvironment}</div>
          <div>This approval records intent only. It has not published anything.</div>
        </div>
      )}

      {reason && <div style={{ fontSize: 13, color: 'var(--muted)' }}>{reason}</div>}
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {showApproveButton && <Button variant="primary" size="sm" onClick={() => { setMsg(null); setPhrase(''); setMatched(false); setDialogOpen(true) }}>Approve for publish…</Button>}
        {a.state === 'active' && <Button variant="secondary" size="sm" onClick={revoke} disabled={busy}>Revoke approval</Button>}
        <Button variant="ghost" size="sm" onClick={reload} disabled={busy}>Refresh status</Button>
      </div>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} title="Approve this release for production">
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'grid', gap: 3, fontSize: 13 }}>
            <Row k="Business">{status.business?.name} <span style={{ color: 'var(--muted)' }}>({status.business?.slug})</span></Row>
            <Row k="Source environment">Preview</Row>
            <Row k="Target environment">Production</Row>
            <Row k="Release / commit"><code>{status.release.releaseId?.slice(0, 12) ?? 'Unavailable'}</code></Row>
            <Row k="Source deployment"><code style={{ overflowWrap: 'anywhere' }}>{status.release.sourceDeploymentId ?? 'Unavailable'}</code></Row>
            <Row k="Blocking issues">{status.blockingCount}</Row>
          </div>
          <Alert tone="warn" title="Approval does not publish">
            Approving records your authorization only. It does <strong>not</strong> publish, merge, or deploy anything —
            a later, separate step performs the actual publish. The approval expires shortly and is bound to this exact
            release; it becomes invalid if the release data changes.
          </Alert>
          <TypedConfirm
            requiredValue={status.requiredPhrase ?? ''}
            label="Type the exact phrase to approve"
            value={phrase}
            onChange={setPhrase}
            onMatchChange={setMatched}
          />
          {msg && msg.tone === 'bad' && <Alert tone="bad">{msg.text}</Alert>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={() => setDialogOpen(false)} disabled={busy}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={submit} disabled={!matched || busy}>{busy ? 'Approving…' : 'Approve for publish'}</Button>
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
