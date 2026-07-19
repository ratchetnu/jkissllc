'use client'
// ── Release Center — Release Details drawer (Increment 3B.6) ─────────────────
//
// Read-only detail view for one release (publish or rollback): deployment + commit + approval +
// publish metadata + an audit-trail timeline. For a business's release it also embeds the
// controlled Rollback panel. A single no-store GET; the only interactive control is Rollback
// (owner + typed confirmation), rendered by RollbackPanel.

import { type ReactNode, useEffect, useState } from 'react'
import { Drawer, StatusBadge, Skeleton, Card } from '../../../components/ui'
import type { ReleaseHistoryEntry, ReleaseAuditLine } from '../../../lib/platform/release/release-history'
import { releaseStatusTone, releaseStatusLabel, releaseKindLabel } from './release-history-view'
import { RollbackPanel } from './RollbackPanel'

type Details = { release: ReleaseHistoryEntry; auditTrail: ReleaseAuditLine[] }
type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'unauthorized' } | { kind: 'data'; details: Details }

const or = (v: string | number | undefined | null): string => (v === undefined || v === null || v === '' ? 'Unavailable' : String(v))
const at = (ms?: number) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'Unavailable')

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, padding: '3px 0' }}>
      <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{label}</span>
      <span style={{ color: 'var(--text)', textAlign: 'right', minWidth: 0, overflowWrap: 'anywhere' }}>{children}</span>
    </div>
  )
}
function Sect({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: 'grid', gap: 6 }}>
      <h3 style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)', margin: 0 }}>{title}</h3>
      {children}
    </section>
  )
}

export function ReleaseDetailsContent({ details }: { details: Details }) {
  const r = details.release
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card style={{ background: 'var(--card)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>{releaseKindLabel(r.kind)} · {r.businessSlug}</h2>
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <StatusBadge tone={releaseStatusTone(r.status)}>{releaseStatusLabel(r.status)}</StatusBadge>
            <StatusBadge tone={r.mode === 'live' ? 'bad' : 'info'} dot={false}>{r.mode === 'live' ? 'LIVE' : 'Simulated'}</StatusBadge>
          </span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>{r.id} · {at(r.at)}</div>
      </Card>

      <Sect title="Deployment">
        <Row label="Environment">{r.environment}</Row>
        <Row label="Deployment">{or(r.deploymentId)}</Row>
        <Row label="Source deployment">{or(r.sourceDeploymentId)}</Row>
        <Row label="Commit"><code>{or(r.commit)}</code></Row>
        <Row label="Branch">{or(r.branch)}</Row>
      </Sect>

      <Sect title="Approval">
        <Row label="Approving owner">{or(r.approvingOwner)}</Row>
        <Row label="Approved at">{at(r.approvalAt)}</Row>
        <Row label="Approval id">{or(r.approvalId)}</Row>
      </Sect>

      <Sect title="Publish metadata">
        <Row label="Started by">{or(r.startedBy)}</Row>
        <Row label="Completed at">{at(r.publishAt)}</Row>
        <Row label="Mode">{r.mode === 'live' ? 'LIVE' : 'Simulated'}</Row>
        {r.failureReason && <Row label="Failure">{r.failureReason}</Row>}
        {r.rollbackOfPublishId && <Row label="Rollback of">{r.rollbackOfPublishId}</Row>}
        {r.rolledBackByRollbackId && <Row label="Rolled back by">{r.rolledBackByRollbackId}</Row>}
      </Sect>

      <Sect title="Audit trail">
        {details.auditTrail.length === 0
          ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>No audit events recorded.</div>
          : <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 0 }}>
              {details.auditTrail.map((line, i) => (
                <li key={line.id} style={{ display: 'grid', gridTemplateColumns: '14px 1fr', gap: 10 }}>
                  <div style={{ display: 'grid', justifyItems: 'center' }}>
                    <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--muted)', marginTop: 5 }} />
                    {i < details.auditTrail.length - 1 && <span aria-hidden style={{ width: 1, flex: 1, background: 'var(--line)', minHeight: 14 }} />}
                  </div>
                  <div style={{ paddingBottom: 12 }}>
                    <div style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 600 }}><code style={{ color: 'var(--muted)' }}>{line.action}</code></div>
                    <div style={{ fontSize: 12.5, color: 'var(--muted)', overflowWrap: 'anywhere' }}>{line.summary}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', opacity: .8 }}>{at(line.at)} · {line.actor}</div>
                  </div>
                </li>
              ))}
            </ol>}
      </Sect>

      {/* Controlled rollback for this business (owner + typed confirmation, simulated in Preview). */}
      <RollbackPanel businessId={r.businessId} />
    </div>
  )
}

// Keyed by releaseId so each selection mounts fresh (initial 'loading') — the effect never
// setStates synchronously (only in the async `.then`), matching the drawer pattern elsewhere.
function DetailsBody({ releaseId }: { releaseId: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  useEffect(() => {
    const ac = new AbortController()
    fetch(`/api/admin/release/history/${releaseId}`, { credentials: 'same-origin', cache: 'no-store', signal: ac.signal })
      .then(async (r) => {
        if (r.status === 401 || r.status === 403) { setState({ kind: 'unauthorized' }); return }
        if (!r.ok) { setState({ kind: 'error', message: 'Could not load the release details.' }); return }
        const j = await r.json()
        if (!j?.release) { setState({ kind: 'error', message: 'Release not found.' }); return }
        setState({ kind: 'data', details: { release: j.release, auditTrail: j.auditTrail ?? [] } })
      })
      .catch((e: { name?: string }) => { if (e?.name !== 'AbortError') setState({ kind: 'error', message: 'Could not load the release details.' }) })
    return () => ac.abort()
  }, [releaseId])

  if (state.kind === 'loading') return <div style={{ display: 'grid', gap: 10 }}><Skeleton height={40} /><Skeleton height={80} /><Skeleton height={120} /></div>
  if (state.kind === 'unauthorized') return <div role="alert" style={{ color: 'var(--muted)', fontSize: 14 }}>Owner access is required.</div>
  if (state.kind === 'error') return <div role="alert" style={{ color: 'var(--status-bad-fg)', fontSize: 14 }}>{state.message}</div>
  return <ReleaseDetailsContent details={state.details} />
}

export function ReleaseDetailsDrawer({ releaseId, title, open, onClose }: { releaseId: string | null; title?: string; open: boolean; onClose: () => void }) {
  return (
    <Drawer open={open} onClose={onClose} title={title ?? 'Release details'}>
      {open && releaseId && <DetailsBody key={releaseId} releaseId={releaseId} />}
    </Drawer>
  )
}
