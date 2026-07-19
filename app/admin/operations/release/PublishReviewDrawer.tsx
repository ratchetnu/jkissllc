'use client'
// ── Publish Review — READ-ONLY owner dashboard (UI polish over 3B.2C/3B.2D) ──
//
// Renders the publish-review payload as a COMPACT, scannable owner dashboard using the
// design-system components. REVIEW AND VISIBILITY ONLY. It performs a single read-only
// GET, never a write; it contains NO Publish / Approve / Confirm / Retry-production /
// Rollback control and never mutates release state, creates a job/lock, or calls a
// provider write API. The only interactive controls are Refresh (repeats the GET) and
// disclosure toggles (expand/collapse detail) — both purely presentational.

import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'
import { Drawer, RiskBanner, EligibilityChecklist, Skeleton, Button, MetricCard, StatusBadge, KpiRow, Card, Tabs } from '../../../components/ui'
import type { ChecklistItem, Tone } from '../../../components/ui'
import type { PublishReview } from '../../../lib/platform/release/publish-review'
import {
  overallReviewBanner, orUnavailable, verificationAgeLabel,
  summaryMetrics, groupedWarnings, eligibilityPill, previewPill, rollbackPill, riskToTone, highRiskCount, splitFileList,
} from './publish-review-view'
import { ReleaseApprovalPanel } from './ReleaseApprovalPanel'

const CHECK_TO_ITEM: Record<string, ChecklistItem['state']> = { pass: 'pass', warn: 'warn', fail: 'fail', skip: 'warn' }

// ── Small presentational atoms ────────────────────────────────────────────────
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, padding: '3px 0', minWidth: 0 }}>
      <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{label}</span>
      <span style={{ color: 'var(--text)', textAlign: 'right', minWidth: 0, overflowWrap: 'anywhere' }}>{children}</span>
    </div>
  )
}

/** Accessible disclosure card: a real button header (aria-expanded/aria-controls) over a
 *  region. Collapsed content stays in the DOM (still reachable / findable) but is `hidden`.
 *  The chevron is a static glyph — no motion — so it is inherently reduced-motion safe. */
function Collapse({ title, badge, defaultOpen = false, children }: { title: string; badge?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  const panelId = useId()
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      {/* Accordion pattern: a heading wraps the disclosure button for screen-reader nav. */}
      <h3 style={{ margin: 0 }}>
        <button
          type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}
          style={{ width: '100%', minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 14px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text)', font: 'inherit', textAlign: 'left' }}
        >
          <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)', minWidth: 0, overflowWrap: 'anywhere' }}>{title}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {badge}
            <span aria-hidden style={{ color: 'var(--muted)', fontSize: 12, width: 12, textAlign: 'center' }}>{open ? '▾' : '▸'}</span>
          </span>
        </button>
      </h3>
      <div id={panelId} role="region" aria-label={title} hidden={!open} style={{ padding: '0 14px 14px' }}>{children}</div>
    </Card>
  )
}

function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <StatusBadge tone={tone}>{children}</StatusBadge>
}

// ── Change-summary tabbed body ────────────────────────────────────────────────
function ChangeSummaryBody({ review }: { review: PublishReview }) {
  const fc = review.filesChanged
  const [tab, setTab] = useState('stats')
  const { shown, remaining } = splitFileList(fc.changedFilePaths)
  const yn = (v: boolean | undefined) => (v == null ? 'Unavailable' : v ? 'Yes' : 'No')
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'stats', label: 'Statistics' }, { id: 'files', label: 'Files' }, { id: 'analysis', label: 'Analysis' }]} />
      {tab === 'stats' && (
        fc.available === false
          ? <Row label="Diff">Unavailable — read from the verified diff at execution time</Row>
          : fc.identical
            ? <Row label="Diff">No changes — candidate matches current production</Row>
            : <div style={{ display: 'grid', gap: 2 }}>
                <Row label="Files changed">{orUnavailable(fc.fileCount)}</Row>
                <Row label="Commits">{orUnavailable(fc.commitCount)}</Row>
                <Row label="Additions / deletions">{orUnavailable(fc.additions)} / {orUnavailable(fc.deletions)}</Row>
                <Row label="Changed areas">{fc.changedAreas?.length ? fc.changedAreas.join(', ') : 'Unavailable'}</Row>
                {fc.truncated && <Row label="Note">Large diff — file list truncated by GitHub; counts may be partial</Row>}
              </div>
      )}
      {tab === 'files' && (
        fc.changedFilePaths?.length
          ? <div style={{ display: 'grid', gap: 4 }}>
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5, color: 'var(--text)', display: 'grid', gap: 2 }}>
                {shown.map((p, i) => <li key={i}><code style={{ overflowWrap: 'anywhere' }}>{p}</code></li>)}
              </ul>
              {remaining > 0 && (
                <details>
                  <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--muted)', minHeight: 24 }}>+{remaining} more file{remaining === 1 ? '' : 's'}</summary>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 16, fontSize: 12.5, color: 'var(--text)', display: 'grid', gap: 2 }}>
                    {(fc.changedFilePaths ?? []).slice(shown.length).map((p, i) => <li key={i}><code style={{ overflowWrap: 'anywhere' }}>{p}</code></li>)}
                  </ul>
                </details>
              )}
            </div>
          : <Row label="Files">Unavailable</Row>
      )}
      {tab === 'analysis' && (
        <div style={{ display: 'grid', gap: 2 }}>
          <Row label="Migration">{yn(fc.migrations)}</Row>
          <Row label="Env change">{yn(fc.envChanges)}</Row>
          <Row label="Workflow change">{yn(fc.workflowChange)}</Row>
          <Row label="High-risk files">{fc.highRiskFiles == null ? 'Unavailable' : fc.highRiskFiles ? 'Yes' : 'No'}</Row>
          {fc.highRiskDetails && fc.highRiskDetails.length > 0 && (
            <ul style={{ margin: '2px 0 0', paddingLeft: 16, fontSize: 12, color: 'var(--muted)', display: 'grid', gap: 2 }}>
              {fc.highRiskDetails.map((h, i) => (
                <li key={i}><span style={{ color: 'var(--status-bad-fg)' }}>{h.category}</span> — <code style={{ overflowWrap: 'anywhere' }}>{h.file}</code></li>
              ))}
            </ul>
          )}
          <Row label="Rollback supported">{fc.rollbackSupported ? 'Yes' : 'No'}</Row>
        </div>
      )}
    </div>
  )
}

// ── Pure presentational content (fully testable via renderToStaticMarkup) ─────
export function PublishReviewContent({ review, warnings }: { review: PublishReview; warnings: string[] }) {
  const v = review
  const banner = overallReviewBanner(v, warnings)
  const checks: ChecklistItem[] = v.verification.checks.map((c) => ({ label: c.name, state: CHECK_TO_ITEM[c.state] ?? 'warn' }))
  const metrics = summaryMetrics(v, warnings)
  const wg = groupedWarnings(v, warnings)
  const elig = eligibilityPill(v)
  const prev = previewPill(v)
  const roll = rollbackPill(v)
  const riskTone = riskToTone(v.risk.level)
  const hr = highRiskCount(v)

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* ── TOP SUMMARY BAR ── a real design-system Card (same background / border /
          elevation / spacing as every sibling card). Sticky within the drawer's scroll
          container; `var(--card)` is the OPAQUE form of the card surface (identical to the
          siblings' color-mix over the drawer's own `var(--card)` panel) so scrolled content
          never bleeds through. It uses ONLY dark-theme tokens (never the light surface token). */}
      <Card style={{ position: 'sticky', top: 0, zIndex: 3, background: 'var(--card)' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 8, justifyContent: 'space-between' }}>
          <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, letterSpacing: '-.01em', color: 'var(--text)', overflowWrap: 'anywhere' }}>{v.business.name}</h2>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <Pill tone="info">Production</Pill>
              {v.business.testOnly && <Pill tone="warn">Test-only</Pill>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end' }}>
            <Pill tone={riskTone}>{v.risk.title}</Pill>
            <Pill tone={elig.tone}>{elig.label}</Pill>
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginTop: 8, fontSize: 13, color: 'var(--muted)' }}>
          <span>Candidate <strong style={{ color: 'var(--text)' }}>{orUnavailable(v.version.candidate)}</strong>{v.version.releaseType ? ` (${v.version.releaseType})` : ''}</span>
          <span>Current <strong style={{ color: 'var(--text)' }}>{orUnavailable(v.version.current)}</strong></span>
          <span>Verified <strong style={{ color: 'var(--text)' }}>{v.verification.verifiedAt ? verificationAgeLabel(v.verification.verificationAgeMs) : 'Unavailable'}</strong></span>
        </div>
      </Card>

      {/* ── OVERALL BANNER (expanded) ── */}
      <RiskBanner level={banner.level} title={banner.title}>{banner.detail}</RiskBanner>

      {/* ── SUMMARY METRICS ── */}
      <KpiRow min={132}>
        {metrics.map((m) => <MetricCard key={m.key} label={m.label} value={m.value} hint={m.hint} tone={m.tone} />)}
      </KpiRow>

      {/* ── MAIN CONTENT — two columns where space permits ── */}
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', alignItems: 'start' }}>
        {/* LEFT: Eligibility · Risk · Change summary */}
        <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
          <Collapse title="Eligibility" defaultOpen badge={<Pill tone={elig.tone}>{elig.label}</Pill>}>
            <EligibilityChecklist items={v.eligibility.items} />
            {(v.eligibility.blockingReasons?.length ?? 0) > 0 && (
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                {v.eligibility.blockingReasons!.map((r, i) => <div key={i}><code style={{ color: 'var(--status-bad-fg)' }}>{r.code}</code> — {r.message}</div>)}
              </div>
            )}
          </Collapse>

          <Collapse title="Risk" defaultOpen badge={<Pill tone={riskTone}>{v.risk.level}</Pill>}>
            <RiskBanner level={v.risk.level} title={v.risk.title}>{v.risk.detail}</RiskBanner>
          </Collapse>

          <Collapse title="Change summary" badge={<Pill tone={hr && hr > 0 ? 'bad' : 'neutral'}>{metrics.find((m) => m.key === 'files')?.value}</Pill>}>
            <ChangeSummaryBody review={v} />
          </Collapse>
        </div>

        {/* RIGHT: Deployment · Version comparison · Rollback · Business */}
        <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
          <Collapse title="Deployment" badge={<Pill tone={prev.tone}>{prev.label}</Pill>}>
            <div style={{ display: 'grid', gap: 2 }}>
              <Row label="Preview">{v.preview.deploymentId ? `${orUnavailable(v.preview.readyState)}${v.preview.verified ? ' · verified' : ''}` : 'Unavailable'}</Row>
              <Row label="Preview verified">{v.verification.verifiedAt ? verificationAgeLabel(v.verification.verificationAgeMs) : 'Unavailable'}{v.verification.fresh ? ' · fresh' : v.verification.verifiedAt ? ' · stale' : ''}</Row>
              {checks.length > 0 ? <EligibilityChecklist title="Automated checks" items={checks} /> : <Row label="Checks">Unavailable</Row>}
              <Row label="Current deployment">{orUnavailable(v.rollback.targetDeploymentId)}</Row>
              <Row label="Current commit">{orUnavailable(v.rollback.targetCommit)}</Row>
              <Row label="Current URL">{orUnavailable(v.rollback.targetUrl)}</Row>
              <Row label="Deployed">{v.rollback.targetDeployedAt ? verificationAgeLabel(v.evaluatedAt - v.rollback.targetDeployedAt) : 'Unavailable'}</Row>
            </div>
          </Collapse>

          <Collapse title="Version comparison">
            <div style={{ display: 'grid', gap: 2 }}>
              <Row label="Current production">{orUnavailable(v.version.current)}</Row>
              <Row label="Candidate version">{orUnavailable(v.version.candidate)}{v.version.releaseType ? ` (${v.version.releaseType})` : ''}</Row>
              <Row label="Candidate commit">{orUnavailable(v.version.candidateCommit)}</Row>
              <Row label="Branch">{orUnavailable(v.version.sourceBranch)}</Row>
            </div>
          </Collapse>

          <Collapse title="Rollback readiness" badge={<Pill tone={roll.tone}>{roll.label}</Pill>}>
            <div style={{ display: 'grid', gap: 2 }}>
              <Row label="Prior production version">{orUnavailable(v.rollback.targetVersion)}</Row>
              <Row label="Prior production deployment">{orUnavailable(v.rollback.targetDeploymentId)}</Row>
              <Row label="Prior production commit">{orUnavailable(v.rollback.targetCommit)}</Row>
              <Row label="Prior production URL">{orUnavailable(v.rollback.targetUrl)}</Row>
              <Row label="Target metadata">{v.rollback.metadataComplete == null ? (v.rollback.ready ? 'Partial' : 'Unavailable') : v.rollback.metadataComplete ? 'Complete' : 'Partial'}</Row>
              <Row label="Rollback target ready">{v.rollback.ready ? 'Yes' : 'No'}</Row>
            </div>
            {v.rollback.warnings?.map((w, i) => <RiskBanner key={i} level="warning" title="Rollback">{w}</RiskBanner>)}
            {v.rollback.warning && <RiskBanner level="info" title="Rollback">{v.rollback.warning}</RiskBanner>}
          </Collapse>

          <Collapse title="Business details">
            <div style={{ display: 'grid', gap: 2 }}>
              <Row label="ID">{v.business.id}</Row>
              <Row label="Edition">{orUnavailable(v.business.edition)}</Row>
              <Row label="Release state">{orUnavailable(v.business.releaseStatus)}</Row>
              {v.business.testOnly && <Row label="Test-only">Yes — refused for production by default</Row>}
            </div>
          </Collapse>
        </div>
      </div>

      {/* ── PROVIDER WARNINGS — expanded only when a hard blocker exists ── */}
      <Collapse
        title="Provider warnings"
        defaultOpen={wg.blocking.length > 0}
        badge={<Pill tone={wg.blocking.length > 0 ? 'bad' : wg.informational.length > 0 ? 'warn' : 'good'}>{wg.blocking.length + wg.informational.length}</Pill>}
      >
        {wg.blocking.length === 0 && wg.informational.length === 0
          ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>No warnings — all review data loaded.</div>
          : <div style={{ display: 'grid', gap: 8 }}>
              {wg.blocking.length > 0 && (
                <div>
                  <div style={{ fontSize: 11.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--status-bad-fg)', marginBottom: 4 }}>Blocking</div>
                  <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5, color: 'var(--text)', display: 'grid', gap: 2 }}>
                    {wg.blocking.map((r, i) => <li key={i}><code style={{ color: 'var(--status-bad-fg)' }}>{r.code}</code> — {r.message}</li>)}
                  </ul>
                </div>
              )}
              {wg.informational.length > 0 && (
                <div>
                  <div style={{ fontSize: 11.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', marginBottom: 4 }}>Informational</div>
                  <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5, color: 'var(--muted)', display: 'grid', gap: 2 }}>
                    {wg.informational.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </div>
              )}
            </div>}
      </Collapse>

      {/* ── AUDIT PREVIEW ── */}
      <Collapse title="Audit preview — no audit record has been created">
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--muted)', display: 'grid', gap: 3 }}>
          {v.audit.willRecord.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      </Collapse>
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
        {/* Separate, explicit approval workflow (owner-only, its own GET/POST). The review
            above stays READ-ONLY; approval is never a side effect of loading/refreshing it. */}
        {state.kind === 'data' && <ReleaseApprovalPanel businessId={businessId} />}
      </div>
    </Drawer>
  )
}
