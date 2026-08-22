import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../../_lib/session'
import { getUpdate, getBusiness, getCompatMap } from '../../../../lib/platform/updates/store'
import { listJobs } from '../../../../lib/platform/automation/store'
import { evaluatePreviewReadiness, resolveCapabilityImpact } from '../../../../lib/platform/automation/orchestrator'
import { deriveGuidedState } from '../../../../lib/platform/automation/guided-flow'
import { getActiveApprovalFor } from '../../../../lib/platform/release/approval-store'
import { deriveApprovalState } from '../../../../lib/platform/release/approval'
import { getLatestPublishFor } from '../../../../lib/platform/release/publish-store'
import { publishUxState, publishPhrase } from '../../../../lib/platform/release/publish'
import { resolveSourceArtifact, describeSourceArtifact } from '../../../../lib/platform/release/source-artifact'
import { buildReleaseComparison } from '../../../../lib/platform/release/release-comparison'
import { getTransferEvidence } from '../../../../lib/platform/automation/store'
import { resolveTenantCapabilities } from '../../../../lib/platform/capabilities/tenant-profile-store'
import { resolveAllProviderReadiness } from '../../../../lib/platform/capabilities/provider-readiness'
import { capabilityReadiness, providerHealth, releaseCompatibility } from '../../../../lib/platform/readiness'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const noStore = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' }

// GET /api/admin/platform/guided?updateKey=…&businessId=…
//
// READ-ONLY. Assembles the single owner-facing view of "where is this update, and
// what is the one thing to do next" from records that already exist. It performs no
// writes, dispatches nothing, and grants nothing: the actions it names are the
// EXISTING endpoints, each of which re-validates authorization, eligibility and the
// typed phrase server-side when it is actually called. Pointing at an endpoint is
// not permission to use it.
//
// Because every fact comes from the server, the guided workflow survives a refresh,
// a logout, or a different device — there is no progress held in the browser.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who

  const url = new URL(req.url)
  const updateKey = url.searchParams.get('updateKey') ?? ''
  const businessId = url.searchParams.get('businessId') ?? ''
  if (!updateKey || !businessId) {
    return NextResponse.json({ ok: true, state: deriveGuidedState({ update: null, business: null, preflight: null, job: null, approval: null, publish: null }) }, { headers: noStore })
  }

  const [update, business] = await Promise.all([getUpdate(updateKey), getBusiness(businessId)])
  if (!update || !business) return NextResponse.json({ error: 'unknown update or business' }, { status: 404, headers: noStore })

  const jobs = await listJobs()
  const job = jobs
    .filter((j) => j.businessId === businessId && j.updateId === updateKey)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null

  // The exact-transfer check costs GitHub reads. It is worth paying once, before a
  // job exists, so "Send" is only offered when the transfer would really resolve —
  // and skipped entirely once a job exists, because this endpoint is polled.
  const compat = (await getCompatMap(updateKey))[businessId]
  const [preflight, capabilityImpact] = await Promise.all([
    job ? Promise.resolve(null) : evaluatePreviewReadiness({ update, business, compat }),
    resolveCapabilityImpact(update, business),
  ])

  const now = Date.now()
  const approvalRecord = await getActiveApprovalFor(businessId)
  const publishRecord = await getLatestPublishFor(businessId)
  const slug = business.slug || business.id

  const state = deriveGuidedState({
    update: { key: update.key, title: update.title },
    business: { id: business.id, name: business.name, slug },
    preflight,
    job: job ? {
      id: job.id, status: job.status, previewUrl: job.previewUrl, previewDeploymentId: job.previewDeploymentId,
      failureSummary: job.failureSummary, failureCategory: job.failureCategory, pullRequestUrl: job.pullRequestUrl,
    } : null,
    // The approval FINGERPRINT is re-derived by the approval route itself; here we
    // only need to know whether one is currently active, which decides whether the
    // owner is at "review" or at "confirm".
    approval: approvalRecord ? { state: deriveApprovalState(approvalRecord, now) } : { state: 'none' },
    publish: {
      state: publishUxState(publishRecord?.status),
      failureReason: publishRecord?.failureReason,
      requiredPhrase: publishPhrase(slug),
    },
    capabilityImpact,
  })

  // ── The comparison, assembled from records that already exist ──
  //
  // The operator should never have to gather a commit, a file list and a target
  // build id by hand — the system knows all three. Fail-soft throughout: a missing
  // piece narrows the comparison, it never fails the page.
  const artifact = resolveSourceArtifact({
    updateKey: update.key,
    sourceRepo: update.sourceRepo,
    sourceCommit: update.sourceCommit,
    sourceWorktreeDirty: update.sourceWorktreeDirty,
  })
  const evidence = await getTransferEvidence(job?.id ?? '').catch(() => null)
  const comparison = artifact.ok
    ? buildReleaseComparison({
        artifact: artifact.artifact,
        update,
        business: { id: business.id, name: business.name },
        changedPaths: evidence?.manifestPaths,
        excludedPaths: evidence?.excludedPaths,
        capabilityImpact,
        targetEvidence: job?.targetEvidence ?? null,
      })
    : null

  // ── The four readiness questions, answered separately ──
  const resolved = await resolveTenantCapabilities(businessId).catch(() => null)

  return NextResponse.json({
    ok: true,
    state,
    // The exact artifact, so nobody has to look one up or type one in.
    artifact: artifact.ok
      ? { ...artifact.artifact, display: describeSourceArtifact(artifact.artifact) }
      : { refused: true, code: artifact.code, reason: artifact.reason },
    comparison,
    readiness: {
      // Platform health is deliberately NOT included here: it is a property of a
      // deployment, not of an update × target pair, and answering it in this
      // response would invite exactly the conflation this work exists to remove.
      release: preflight ? releaseCompatibility(preflight) : null,
      capability: resolved ? capabilityReadiness(resolved.capabilities) : null,
      provider: resolved
        ? providerHealth(resolveAllProviderReadiness({ enabled: resolved.providers, env: process.env }))
        : null,
      /** False while a tenant is still on the legacy credential-inference fallback. */
      capabilityProfileInitialized: resolved?.initialized ?? false,
    },
    preview: job ? { url: job.previewUrl, deploymentId: job.previewDeploymentId, pullRequestUrl: job.pullRequestUrl } : null,
    // The value-free snapshot the target itself reported, so the review screen can
    // show optional-feature impact without Operion guessing.
    targetEvidence: job?.targetEvidence ?? null,
  }, { headers: noStore })
})
