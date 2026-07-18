'use client'
// ── Publish Review — READ-ONLY owner interface (Increment 3B.2C) ─────────────
//
// Renders the 3B.2B publish-review payload using the 3B.2A design-system components.
// REVIEW AND VISIBILITY ONLY. It performs a single read-only GET, never a write; it
// contains NO Publish / Approve / Confirm / Retry-production / Rollback control and
// never mutates release state, creates a job/lock, or calls a provider write API.

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Drawer, RiskBanner, EligibilityChecklist, Skeleton, Button } from '../../../components/ui'
import type { ChecklistItem } from '../../../components/ui'
import type { PublishReview } from '../../../lib/platform/release/publish-review'
import { overallReviewBanner, orUnavailable, verificationAgeLabel } from './publish-review-view'

const CHECK_TO_ITEM: Record<string, ChecklistItem['state']> = { pass: 'pass', warn: 'warn', fail: 'fail', skip: 'warn' }

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, padding: '3px 0' }}>
      <span style={{ color: 'var(--muted)' }}>{label}</span>
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

// ── Pure presentational content (no fetch, no state — fully testable) ─────────
export function PublishReviewContent({ review, warnings }: { review: PublishReview; warnings: string[] }) {
  const banner = overallReviewBanner(review, warnings)
  const v = review
  const checks: ChecklistItem[] = v.verification.checks.map((c) => ({ label: c.name, state: CHECK_TO_ITEM[c.state] ?? 'warn' }))
  const fc = v.filesChanged
  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <RiskBanner level={banner.level} title={banner.title}>{banner.detail}</RiskBanner>

      <Sect title="Business">
        <Row label="Name">{v.business.name}</Row>
        <Row label="ID">{v.business.id}</Row>
        <Row label="Edition">{orUnavailable(v.business.edition)}</Row>
        <Row label="Release state">{orUnavailable(v.business.releaseStatus)}</Row>
        {v.business.testOnly && <Row label="Test-only">Yes — refused for production by default</Row>}
      </Sect>

      <Sect title="Version comparison">
        <Row label="Current production">{orUnavailable(v.version.current)}</Row>
        <Row label="Current deployment">{orUnavailable(v.rollback.targetDeploymentId)}</Row>
        <Row label="Candidate version">{orUnavailable(v.version.candidate)}{v.version.releaseType ? ` (${v.version.releaseType})` : ''}</Row>
        <Row label="Candidate commit">{orUnavailable(v.version.candidateCommit)}</Row>
        <Row label="Branch">{orUnavailable(v.version.sourceBranch)}</Row>
      </Sect>

      <Sect title="Preview verification">
        <Row label="Preview">{v.preview.deploymentId ? `${orUnavailable(v.preview.readyState)}${v.preview.verified ? ' · verified' : ''}` : 'Unavailable'}</Row>
        <Row label="Verified">{v.verification.verifiedAt ? verificationAgeLabel(v.verification.verificationAgeMs) : 'Unavailable'}{v.verification.fresh ? ' · fresh' : v.verification.verifiedAt ? ' · stale' : ''}</Row>
        {checks.length > 0 ? <EligibilityChecklist title="Automated checks" items={checks} /> : <Row label="Checks">Unavailable</Row>}
      </Sect>

      <Sect title="Eligibility">
        <EligibilityChecklist items={v.eligibility.items} />
        {(v.eligibility.blockingReasons?.length ?? 0) > 0 && (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {v.eligibility.blockingReasons!.map((r, i) => <div key={i}><code style={{ color: 'var(--status-bad-fg)' }}>{r.code}</code> — {r.message}</div>)}
          </div>
        )}
      </Sect>

      <Sect title="Change summary">
        {fc.available === false
          ? <Row label="Diff">Unavailable — read from the verified diff at execution time</Row>
          : fc.identical
            ? <Row label="Diff">No changes — candidate matches current production</Row>
            : <>
                <Row label="Files changed">{orUnavailable(fc.fileCount)}</Row>
                <Row label="Commits">{orUnavailable(fc.commitCount)}</Row>
                <Row label="Additions / deletions">{orUnavailable(fc.additions)} / {orUnavailable(fc.deletions)}</Row>
                <Row label="Changed areas">{fc.changedAreas?.length ? fc.changedAreas.join(', ') : 'Unavailable'}</Row>
                {fc.truncated && <Row label="Note">Large diff — file list truncated by GitHub; counts may be partial</Row>}
              </>}
        <Row label="Migration">{fc.migrations ? 'Yes' : 'No'}</Row>
        <Row label="Env change">{fc.envChanges ? 'Yes' : 'No'}</Row>
        <Row label="Workflow change">{fc.workflowChange == null ? 'Unavailable' : fc.workflowChange ? 'Yes' : 'No'}</Row>
        <Row label="High-risk files">{fc.highRiskFiles == null ? 'Unavailable' : fc.highRiskFiles ? 'Yes' : 'No'}</Row>
        {fc.highRiskDetails && fc.highRiskDetails.length > 0 && (
          <ul style={{ margin: '2px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--muted)', display: 'grid', gap: 2 }}>
            {fc.highRiskDetails.map((h, i) => (
              <li key={i}><span style={{ color: 'var(--status-bad-fg)' }}>{h.category}</span> — <code style={{ overflowWrap: 'anywhere' }}>{h.file}</code></li>
            ))}
          </ul>
        )}
        <Row label="Rollback supported">{fc.rollbackSupported ? 'Yes' : 'No'}</Row>
      </Sect>

      <Sect title="Rollback readiness">
        <Row label="Prior production version">{orUnavailable(v.rollback.targetVersion)}</Row>
        <Row label="Prior production deployment">{orUnavailable(v.rollback.targetDeploymentId)}</Row>
        <Row label="Prior production commit">{orUnavailable(v.rollback.targetCommit)}</Row>
        <Row label="Prior production URL">{orUnavailable(v.rollback.targetUrl)}</Row>
        <Row label="Prior production deployed">{v.rollback.targetDeployedAt ? verificationAgeLabel(review.evaluatedAt - v.rollback.targetDeployedAt) : 'Unavailable'}</Row>
        <Row label="Target metadata">{v.rollback.metadataComplete == null ? (v.rollback.ready ? 'Partial' : 'Unavailable') : v.rollback.metadataComplete ? 'Complete' : 'Partial'}</Row>
        <Row label="Rollback target ready">{v.rollback.ready ? 'Yes' : 'No'}</Row>
        {v.rollback.warnings?.map((w, i) => <RiskBanner key={i} level="warning" title="Rollback">{w}</RiskBanner>)}
        {v.rollback.warning && <RiskBanner level="info" title="Rollback">{v.rollback.warning}</RiskBanner>}
      </Sect>

      <Sect title="Risk">
        <RiskBanner level={v.risk.level} title={v.risk.title}>{v.risk.detail}</RiskBanner>
      </Sect>

      <Sect title="Audit preview — no audit record has been created">
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--muted)', display: 'grid', gap: 3 }}>
          {v.audit.willRecord.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      </Sect>
    </div>
  )
}

// ── Drawer wrapper: single read-only GET + loading/error/empty states ─────────
type State =
  | { kind: 'loading' } | { kind: 'unauthorized' } | { kind: 'error'; message: string }
  | { kind: 'data'; review: PublishReview; warnings: string[] }

export function PublishReviewDrawer({ businessId, businessName, open, onClose }: { businessId: string; businessName?: string; open: boolean; onClose: () => void }) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [nonce, setNonce] = useState(0)
  const abortRef = useRef<AbortController | null>(null)

  // `.then` chain (not sync setState) so the effect never setStates synchronously.
  const load = useCallback((signal: AbortSignal) => {
    fetch(`/api/admin/release/businesses/${businessId}/publish-review`, { credentials: 'same-origin', cache: 'no-store', signal })
      .then(async (r) => {
        if (r.status === 401 || r.status === 403) { setState({ kind: 'unauthorized' }); return }
        if (!r.ok) { setState({ kind: 'error', message: 'Could not load the release review.' }); return }
        const j = await r.json()
        if (!j?.review) { setState({ kind: 'error', message: j?.refusal?.message ?? 'No review data available.' }); return }
        setState({ kind: 'data', review: j.review, warnings: j.warnings ?? [] })
      })
      .catch((e: { name?: string }) => {
        if (e?.name === 'AbortError') return
        setState({ kind: 'error', message: 'Could not load the release review.' }) // sanitized — never a raw provider error
      })
  }, [businessId])

  useEffect(() => {
    if (!open) return
    const ac = new AbortController()
    abortRef.current?.abort()      // abort a stale request when switching businesses / refetching
    abortRef.current = ac
    load(ac.signal)
    return () => ac.abort()
  }, [open, businessId, nonce, load])

  const refresh = () => { setState({ kind: 'loading' }); setNonce((n) => n + 1) }

  return (
    <Drawer open={open} onClose={onClose} title={`Review release — ${businessName ?? businessId}`}>
      <div style={{ display: 'grid', gap: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {/* Refresh repeats ONLY the read-only GET — it never triggers a release action. */}
          <Button variant="secondary" size="sm" onClick={refresh} disabled={state.kind === 'loading'}>Refresh</Button>
        </div>
        {state.kind === 'loading' && <div style={{ display: 'grid', gap: 10 }}><Skeleton height={20} width={220} /><Skeleton height={60} /><Skeleton height={120} /><Skeleton height={90} /></div>}
        {state.kind === 'unauthorized' && <div role="alert" style={{ color: 'var(--muted)', fontSize: 14 }}>Owner access is required to view the release review.</div>}
        {state.kind === 'error' && <div role="alert" style={{ color: 'var(--status-bad-fg)', fontSize: 14 }}>{state.message}</div>}
        {state.kind === 'data' && <PublishReviewContent review={state.review} warnings={state.warnings} />}
      </div>
    </Drawer>
  )
}
