import { NextRequest, NextResponse } from 'next/server'
import { isEnabled } from '../../../lib/platform/flags'
import { listJobs, saveJob } from '../../../lib/platform/automation/store'
import { getBusiness } from '../../../lib/platform/updates/store'
import { getAutomationProvider } from '../../../lib/platform/automation/provider'
import { businessRepoRef } from '../../../lib/platform/automation/repo-identity'
import { retryPreview, finalizePreview } from '../../../lib/platform/automation/orchestrator'
import { reconcileDecision } from '../../../lib/platform/automation/reconcile'
import { isTransientFailure, artifactsComplete } from '../../../lib/platform/automation/deploy-view'
import { AUTOMATION_ACTIVE } from '../../../lib/platform/automation/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/cron/operion-reconcile — background job reconciliation so a Preview job continues
// even with the browser closed. CRON_SECRET bearer (Vercel injects it). For each active (or
// transiently-failed) job it queries the real GitHub run, repairs missed callbacks, finalizes
// stale jobs, and auto-retries transient failures (bounded). It NEVER promotes to production.
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  return !!secret && req.headers.get('authorization') === `Bearer ${secret}`
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!isEnabled('OPERION_AUTOMATION_ENABLED')) return NextResponse.json({ ok: true, skipped: 'automation disabled' })

  const now = Date.now()
  const all = await listJobs()
  const jobs = all.filter(j => AUTOMATION_ACTIVE.includes(j.status) || isTransientFailure(j.failureCategory)
    || (j.status === 'awaiting_owner_review' && (!j.pullRequestUrl || !j.previewUrl)))
  const provider = getAutomationProvider()
  const results: { jobId: string; action: string; reason: string }[] = []

  for (const job of jobs) {
    const business = await getBusiness(job.businessId)
    // Review-ready but missing artifacts → discover/create PR + Preview (idempotent).
    if (job.status === 'awaiting_owner_review' && business && !artifactsComplete(job, { requirePr: business.requirePullRequest, requirePreview: business.requirePreview })) {
      const f = await finalizePreview({ jobId: job.id })
      results.push({ jobId: job.id, action: 'finalize_artifacts', reason: f.artifactsComplete ? 'artifacts recovered' : (f.needsAttention ?? 'still missing artifacts') })
      continue
    }
    const repo = business ? businessRepoRef(business) : null
    let ghRun: { status: string; conclusion?: string | null } | null = null
    if (business?.githubInstallationId && repo && job.workflowRunId) {
      const r = await provider.readWorkflowRun(business.githubInstallationId, repo, job.workflowRunId)
      if (r.ok) ghRun = { status: r.data.status, conclusion: r.data.conclusion }
    }

    const decision = reconcileDecision({ job, ghRun, now })
    if (decision.action === 'finalize') {
      job.status = decision.status
      job.failureCategory = decision.failureCategory as typeof job.failureCategory
      job.failureSummary = decision.reason
      job.updatedAt = now
      await saveJob(job)
    } else if (decision.action === 'repair_success') {
      // The run succeeded but the callback was lost — advance to owner review (never production).
      job.status = 'awaiting_owner_review'
      job.currentStep = 'owner_review'
      job.updatedAt = now
      await saveJob(job)
    } else if (decision.action === 'auto_retry') {
      await retryPreview({ jobId: job.id })   // bounded by attemptCount inside reconcileDecision
    }
    results.push({ jobId: job.id, action: decision.action, reason: decision.reason })
  }
  return NextResponse.json({ ok: true, reconciled: results.length, results })
}
