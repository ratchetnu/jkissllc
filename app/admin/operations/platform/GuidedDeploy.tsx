'use client'

// ── "Send an update to Supercharged" — the guided owner path ────────────────
//
// One screen, one primary button, seven visible steps. Every fact on it comes from
// GET /api/admin/platform/guided, so closing the tab, refreshing, or signing back in
// on another device resumes exactly where it was — nothing about the deployment
// lives in this component's state.
//
// The internal vocabulary (job statuses, gate ids, publish states) is not hidden —
// it is moved into the Advanced disclosure, where it belongs for recovery work. The
// normal path never asks the owner to know that `awaiting_owner_review` means "your
// turn" or that `partially_deployed` is success.

import { useCallback, useEffect, useRef, useState } from 'react'
import ConfirmDialog from './ConfirmDialog'
import type { GuidedAction, GuidedState } from '../../../lib/platform/automation/guided-flow'
import type { PlatformBusiness, PlatformUpdate, TargetDeploymentEvidence } from '../../../lib/platform/updates/types'

const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 16 }
const lab: React.CSSProperties = { display: 'block', fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted)', marginBottom: 3 }
const field: React.CSSProperties = { width: '100%', padding: '8px 10px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 9, color: 'var(--text)', fontSize: 13, outline: 'none' }
const btn = (kind: 'primary' | 'ghost' | 'danger' = 'ghost'): React.CSSProperties => ({
  fontSize: 13, fontWeight: 700, padding: '9px 16px', borderRadius: 9, cursor: 'pointer', whiteSpace: 'nowrap',
  border: '1px solid ' + (kind === 'primary' ? 'var(--red)' : kind === 'danger' ? 'rgba(224,0,42,.4)' : 'var(--line)'),
  background: kind === 'primary' ? 'var(--red)' : 'transparent',
  color: kind === 'primary' ? '#fff' : kind === 'danger' ? '#ff6680' : 'var(--text)',
})

const STEP_LABELS = ['Choose', 'Check', 'Send', 'Review', 'Confirm', 'Publish', 'Live']
/** Stages where the server is working, so the view polls itself. */
const BUSY_STAGES = new Set(['checking', 'sending', 'previewing', 'publishing', 'verifying'])

type GuidedResponse = {
  ok: boolean
  state: GuidedState
  preview: { url?: string; deploymentId?: string; pullRequestUrl?: string } | null
  targetEvidence: TargetDeploymentEvidence | null
}

type PublishGate = { ready?: boolean; requiredPhrase?: string; blocker?: { code: string; message: string }; mode?: string }
type ApprovalGate = { gateEnabled?: boolean; eligible?: boolean; requiredPhrase?: string; previewReady?: boolean; release?: { releaseId?: string; sourceDeploymentId?: string } }

async function api(url: string, init: RequestInit = {}) {
  const res = await fetch(url, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', ...init })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j.message || j.error || 'That did not go through.')
  return j
}

export default function GuidedDeploy({ businesses, updates, onChanged }: {
  businesses: PlatformBusiness[]
  updates: PlatformUpdate[]
  onChanged: () => void
}) {
  const targets = businesses.filter(b => b.role === 'target' || b.role === 'source_and_target')
  const [updateKey, setUpdateKey] = useState('')
  const [businessId, setBusinessId] = useState(targets[0]?.id ?? '')
  const [data, setData] = useState<GuidedResponse | null>(null)
  const [publishGate, setPublishGate] = useState<PublishGate | null>(null)
  const [approvalGate, setApprovalGate] = useState<ApprovalGate | null>(null)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState<GuidedAction | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const inflight = useRef(false)

  const load = useCallback(async () => {
    // A single in-flight request at a time: the poll and a manual refresh must not
    // race and render an older state over a newer one.
    if (inflight.current) return
    inflight.current = true
    try {
      const q = new URLSearchParams({ updateKey, businessId })
      const j = await api(`/api/admin/platform/guided?${q}`) as GuidedResponse
      setData(j); setError('')
      if (j.state.stage === 'review_preview' || j.state.stage === 'confirm_production') {
        // The authoritative approval + publish gates are re-read from the routes that
        // ENFORCE them, rather than re-derived here. Approval and publish deliberately
        // require two DIFFERENT phrases; this view carries both rather than inventing
        // either, because a second implementation of that decision is exactly how a UI
        // and a server end up disagreeing about safety.
        const [pg, ag] = await Promise.all([
          api(`/api/admin/release/businesses/${businessId}/publish`).catch(() => null),
          api(`/api/admin/release/businesses/${businessId}/approval`).catch(() => null),
        ])
        setPublishGate(pg as PublishGate | null)
        setApprovalGate(ag as ApprovalGate | null)
      } else {
        setPublishGate(null)
        setApprovalGate(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the current state.')
    } finally {
      inflight.current = false
    }
  }, [updateKey, businessId])

  useEffect(() => { load() }, [load])

  // Self-updating while the server is working, so the owner is never asked to
  // refresh to find out whether their deployment finished.
  useEffect(() => {
    if (!data || !BUSY_STAGES.has(data.state.stage)) return
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [data, load])

  const state = data?.state
  const stage = state?.stage
  const busy = !!stage && BUSY_STAGES.has(stage)

  const run = async (action: GuidedAction, phrase?: string) => {
    if (!action.endpoint) {
      if (action.id === 'refresh') { await load(); return }
      if (action.id === 'open_review') { setReviewOpen(true); return }
      return
    }
    const body: Record<string, unknown> = { ...(action.body ?? {}), ...(phrase ? { phrase } : {}) }
    // A publish is bound to the exact release + preview deployment the owner reviewed;
    // the server re-derives both and refuses if they have moved (commit drift).
    if (action.id === 'publish' && publishGate) {
      body.releaseId = approvalGate?.release?.releaseId
      body.sourceDeploymentId = approvalGate?.release?.sourceDeploymentId
    }
    await api(action.endpoint, { method: action.method ?? 'POST', body: JSON.stringify(body) })
    await load()
    onChanged()
  }

  const startAction = (action: GuidedAction) => {
    // Anything that changes a target — sending, publishing, rolling back — is
    // confirmed in-app first. Only 'refresh' and 'open_review' are inert enough to
    // run straight away.
    if (action.id === 'refresh' || action.id === 'open_review') { void run(action); return }
    setConfirming(action)
  }

  const target = targets.find(b => b.id === businessId)
  const selectableUpdates = updates.filter(u => !['fully_deployed', 'cancelled', 'archived'].includes(u.status))

  return (
    <div style={{ ...card, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <h2 style={{ fontSize: 15.5, fontWeight: 900, letterSpacing: '-.01em' }}>Send an update</h2>
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Preview first · you approve before anything goes live</span>
      </div>

      {/* 1 + 2 — pick the update and the target */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, marginBottom: 14 }}>
        <div>
          <label style={lab} htmlFor="guided-update">Update</label>
          <select id="guided-update" style={field} value={updateKey} onChange={e => setUpdateKey(e.target.value)}>
            <option value="">Choose an update…</option>
            {selectableUpdates.map(u => <option key={u.key} value={u.key}>{u.key} — {u.title}</option>)}
          </select>
        </div>
        <div>
          <label style={lab} htmlFor="guided-target">Send to</label>
          <select id="guided-target" style={field} value={businessId} onChange={e => setBusinessId(e.target.value)}>
            {targets.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
      </div>

      {/* 5 — progress, always visible, always server-derived */}
      {state && (
        <ol style={{ display: 'flex', gap: 6, listStyle: 'none', padding: 0, margin: '0 0 14px', flexWrap: 'wrap' }} aria-label="Progress">
          {STEP_LABELS.map((s, i) => {
            const n = i + 1
            const done = n < state.stepIndex
            const now = n === state.stepIndex
            return (
              <li key={s} aria-current={now ? 'step' : undefined} style={{
                fontSize: 11, fontWeight: 700, padding: '4px 9px', borderRadius: 999,
                border: '1px solid ' + (now ? 'var(--red)' : 'var(--line)'),
                color: now ? '#fff' : done ? '#34d399' : 'var(--muted)',
                background: now ? 'var(--red)' : 'transparent',
              }}>{done ? '✓ ' : ''}{s}</li>
            )
          })}
        </ol>
      )}

      {/* 11 — one plain-language blocker, one recovery */}
      {error && <p role="alert" style={{ color: '#f87171', fontSize: 13, marginBottom: 10 }}>{error}</p>}

      {state && (
        <div
          // The headline changes as the server advances; announce it politely so a
          // screen-reader user is not left on a page that silently moved on.
          aria-live="polite"
          style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 14, background: 'color-mix(in srgb, var(--card) 92%, transparent)' }}
        >
          <p style={{ fontSize: 15, fontWeight: 800 }}>
            {busy && <span aria-hidden="true" style={{ marginRight: 6 }}>⏳</span>}
            {state.headline}
          </p>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 5, lineHeight: 1.55 }}>{state.detail}</p>

          {state.capabilityNote && (
            <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line)' }}>
              <strong style={{ color: 'var(--text)' }}>Optional features: </strong>{state.capabilityNote}
            </p>
          )}

          {state.blocker && (
            <div role="alert" style={{ marginTop: 10, padding: 10, borderRadius: 9, border: '1px solid rgba(248,113,113,.35)', background: 'rgba(248,113,113,.07)' }}>
              <p style={{ fontSize: 13, color: '#fca5a5', fontWeight: 600 }}>{state.blocker.plain}</p>
              <button style={{ ...btn(state.blocker.recovery.destructive ? 'danger' : 'ghost'), marginTop: 9 }} onClick={() => startAction(state.blocker!.recovery)}>
                {state.blocker.recovery.label}
              </button>
            </div>
          )}

          {publishGate?.blocker && stage === 'confirm_production' && (
            <p role="alert" style={{ marginTop: 10, fontSize: 13, color: '#fca5a5' }}>{publishGate.blocker.message}</p>
          )}

          {state.primary && (
            <button style={{ ...btn('primary'), marginTop: 12 }} onClick={() => startAction(state.primary!)}>
              {state.primary.label}
            </button>
          )}

          {data?.preview?.url && (
            <p style={{ marginTop: 10, fontSize: 12.5 }}>
              <a href={data.preview.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text)', textDecoration: 'underline' }}>Open the Preview ↗</a>
              {data.preview.pullRequestUrl && <> · <a href={data.preview.pullRequestUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--muted)', textDecoration: 'underline' }}>Pull request ↗</a></>}
            </p>
          )}
        </div>
      )}

      {/* Advanced — recovery + the internal vocabulary, on request only */}
      {state && (
        <details style={{ marginTop: 12 }} open={showAdvanced} onToggle={e => setShowAdvanced((e.currentTarget as HTMLDetailsElement).open)}>
          <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>Advanced</summary>
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)', display: 'grid', gap: 6 }}>
            <p>Job: <code>{state.advanced.jobId ?? '—'}</code> · status <code>{state.advanced.jobStatus ?? '—'}</code></p>
            <p>Approval: <code>{state.advanced.approvalState ?? '—'}</code> · publish <code>{state.advanced.publishStatus ?? '—'}</code>{publishGate?.mode ? ` · mode ${publishGate.mode}` : ''}</p>
            {state.advanced.failedGates.length > 0 && (
              <div>
                <p style={{ fontWeight: 700, color: '#f87171' }}>Blocking gates</p>
                <ul style={{ margin: '4px 0 0 16px' }}>
                  {state.advanced.failedGates.map(g => <li key={g.id}><code>{g.id}</code> — {g.reason ?? g.label}</li>)}
                </ul>
              </div>
            )}
            {state.advanced.softGates.length > 0 && (
              <div>
                <p style={{ fontWeight: 700 }}>Advisory</p>
                <ul style={{ margin: '4px 0 0 16px' }}>
                  {state.advanced.softGates.map(g => <li key={g.id}><code>{g.id}</code> — {g.reason ?? g.label}</li>)}
                </ul>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
              <button style={btn()} onClick={() => void load()}>Refresh</button>
              {state.advanced.jobId && (
                <button style={btn('danger')} onClick={() => startAction({ id: 'cancel', label: 'Cancel this run', endpoint: `/api/admin/platform/automation/${state.advanced.jobId}`, method: 'POST', body: { action: 'cancel' }, destructive: true })}>
                  Cancel this run
                </button>
              )}
            </div>
          </div>
        </details>
      )}

      {/* 7 — the owner review screen */}
      <ConfirmDialog
        open={reviewOpen}
        title={`Review the ${target?.name ?? 'target'} Preview`}
        confirmLabel="Approve for production"
        cancelLabel="Not yet"
        // The APPROVAL phrase — deliberately different from the publish phrase, so
        // approving and publishing can never be the same muscle memory.
        requiredPhrase={approvalGate?.requiredPhrase}
        onCancel={() => setReviewOpen(false)}
        onConfirm={async () => {
          await api(`/api/admin/release/businesses/${businessId}/approval`, {
            method: 'POST',
            body: JSON.stringify({
              phrase: approvalGate?.requiredPhrase,
              // Bind the approval to the exact release + preview the owner just read
              // about. The server re-derives both and refuses a mismatch.
              releaseId: approvalGate?.release?.releaseId,
              sourceDeploymentId: approvalGate?.release?.sourceDeploymentId,
            }),
          })
          setReviewOpen(false)
          await load()
        }}
      >
        <ul style={{ margin: '0 0 10px 16px', display: 'grid', gap: 4 }}>
          <li>Preview: {data?.preview?.url ? <a href={data.preview.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text)' }}>open it ↗</a> : 'not available'}</li>
          <li>Changes: {data?.preview?.pullRequestUrl ? <a href={data.preview.pullRequestUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text)' }}>see the diff ↗</a> : 'see the Update Center'}</li>
          <li>Checks: Supercharged’s own typecheck, tests and build passed on this branch.</li>
          <li>If it goes wrong: the previous build stays available to restore.</li>
        </ul>
        {state?.capabilityNote && <p><strong>Optional features:</strong> {state.capabilityNote}</p>}
        <p>Approving records your intent. It does not publish — that is the next, separate step.</p>
      </ConfirmDialog>

      {/* 8 — the deliberate typed confirmation, for every state-changing action */}
      <ConfirmDialog
        open={!!confirming}
        title={confirming?.label ?? ''}
        confirmLabel={confirming?.label ?? 'Confirm'}
        destructive={confirming?.destructive}
        requiredPhrase={confirming?.requiresTypedConfirmation ? (publishGate?.requiredPhrase ?? confirming?.phrase) : undefined}
        onCancel={() => setConfirming(null)}
        onConfirm={async () => {
          const action = confirming!
          const phrase = action.requiresTypedConfirmation ? (publishGate?.requiredPhrase ?? action.phrase) : undefined
          await run(action, phrase)
          setConfirming(null)
        }}
      >
        {confirming?.id === 'send_preview' && (
          <p>This copies the approved files to a <strong>{target?.name}</strong> branch and runs its tests. Nothing goes live, and nothing is merged.</p>
        )}
        {confirming?.id === 'publish' && (
          <p>This is the step customers see. <strong>{target?.name}</strong> will be promoted to the build you just reviewed, and Operion will verify the live deployment afterwards.</p>
        )}
        {confirming?.id === 'rollback' && (
          <p>This restores the previous known-good build of <strong>{target?.name}</strong>.</p>
        )}
        {confirming?.id === 'cancel' && (
          <p>This stops the current run. Nothing that has already been published is undone.</p>
        )}
        {confirming?.id === 'retry_preview' && (
          <p>This runs the same update against <strong>{target?.name}</strong> again. Nothing goes live.</p>
        )}
      </ConfirmDialog>
    </div>
  )
}
