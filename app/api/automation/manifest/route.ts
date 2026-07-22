import { NextRequest, NextResponse } from 'next/server'
import { isEnabled } from '../../../lib/platform/flags'
import { verifyCallback } from '../../../lib/platform/automation/callback'
import { getJob, saveJob, saveTransferEvidence, withBusinessLock } from '../../../lib/platform/automation/store'
import { getBusiness, getCompatMap } from '../../../lib/platform/updates/store'
import { getAutomationProvider } from '../../../lib/platform/automation/provider'
import { parseRepoName, businessRepoRef } from '../../../lib/platform/automation/repo-identity'
import { buildCommitTransferManifest } from '../../../lib/platform/automation/manifest-builder'
import { buildTransferEvidence, buildRefusalEvidence } from '../../../lib/platform/automation/evidence'
import type { TransferEvidence, UpdateAutomationJob } from '../../../lib/platform/automation/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Persist what the builder decided (§4 #7).
 *
 * FAIL-SOFT, ALWAYS. An audit write must never break the transfer it is auditing —
 * the CI runner is blocked on this response. Same doctrine as the post-promotion
 * record reconciliation in orchestrator.ts: a hiccup here must not undo real work.
 *
 * The job itself gets only a timestamp marker, written under the per-business lock so
 * a concurrent status write is never clobbered; `updatedAt` is deliberately NOT
 * touched, so an audit write cannot disturb the job's position in the index.
 */
async function recordEvidence(job: UpdateAutomationJob, evidence: TransferEvidence): Promise<void> {
  try {
    await saveTransferEvidence(evidence)
    await withBusinessLock(job.businessId, async () => {
      const fresh = await getJob(job.id)
      if (!fresh) return
      fresh.transferEvidenceAt = evidence.recordedAt
      await saveJob(fresh)
    }, { onBusy: () => undefined, token: `evidence:${job.id}:${evidence.recordedAt}` })
  } catch (err) {
    console.warn('[operion] transfer evidence not recorded (non-fatal):', err instanceof Error ? err.message : err)
  }
}

// POST /api/automation/manifest — the CI runner fetches the approved commit-transfer manifest
// + file contents for a job. Machine-to-machine: gated by the SAME HMAC signature as the
// callback (OPERION_CALLBACK_SECRET over `${timestamp}.${rawBody}`), a freshness window, and
// OPERION_AUTOMATION_ENABLED. Read-only: it reads the SOURCE repo via the GitHub App and never
// writes anything, never returns a token/secret. The transfer set is the source commit's own
// files — not attacker-supplied paths.
export async function POST(req: NextRequest) {
  if (!isEnabled('OPERION_AUTOMATION_ENABLED')) return NextResponse.json({ error: 'automation disabled' }, { status: 403 })

  const raw = await req.text()
  const verify = verifyCallback(raw, req.headers.get('x-operion-timestamp'), req.headers.get('x-operion-signature'), process.env.OPERION_CALLBACK_SECRET, Date.now())
  if (!verify.ok) return NextResponse.json({ error: 'unauthorized', reason: verify.reason }, { status: 401 })

  let body: { jobId?: string }
  try { body = JSON.parse(raw) } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }) }
  const jobId = typeof body.jobId === 'string' ? body.jobId : ''
  const job = await getJob(jobId)
  if (!job) return NextResponse.json({ error: 'unknown job' }, { status: 404 })

  const business = await getBusiness(job.businessId)
  if (!business?.githubInstallationId) return NextResponse.json({ error: 'business not configured' }, { status: 409 })

  // Source (where the approved change lives) — the update's source repo + commit on the job.
  const sourceRepo = parseRepoName(job.sourceRepository)
  if (!sourceRepo) return NextResponse.json({ error: 'job has no valid source repository' }, { status: 409 })
  if (!job.sourceCommit) return NextResponse.json({ error: 'job has no source commit' }, { status: 409 })
  // Target allowlist: the job's target must resolve to the configured business repo.
  const targetRepo = businessRepoRef(business)
  if (!targetRepo) return NextResponse.json({ error: 'target repository not configured' }, { status: 409 })

  // Target-specific exclusions are part of the approved compatibility assessment.
  // They must constrain the machine manifest, not merely appear in a human-facing prompt.
  const compatibility = (await getCompatMap(job.updateId))[job.businessId]

  const built = await buildCommitTransferManifest({
    provider: getAutomationProvider(),
    installationId: business.githubInstallationId,
    sourceRepo, sourceRepoName: job.sourceRepository!, sourceCommit: job.sourceCommit,
    targetRepo, targetBranch: business.defaultBranch,
    updateKey: job.updateId,
    compatibility,
  })
  const common = { jobId, attempt: job.attemptCount ?? 0, sourceCommit: job.sourceCommit, now: Date.now() }

  // A REFUSAL is the case worth keeping most: it is the state that previously left no
  // trace at all, and the one an incident review actually asks about.
  if (!built.ok) {
    await recordEvidence(job, buildRefusalEvidence(built.error, common))
    return NextResponse.json({ error: built.error }, { status: 422 })
  }

  await recordEvidence(job, buildTransferEvidence(built.data, common))

  // Response shape is unchanged — the runner sees exactly what it saw before.
  return NextResponse.json({ jobId, ...built.data })
}
