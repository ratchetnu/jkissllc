import { NextRequest, NextResponse } from 'next/server'
import { isEnabled } from '../../../lib/platform/flags'
import { verifyCallback } from '../../../lib/platform/automation/callback'
import { getJob } from '../../../lib/platform/automation/store'
import { getBusiness, getCompatMap } from '../../../lib/platform/updates/store'
import { getAutomationProvider } from '../../../lib/platform/automation/provider'
import { parseRepoName, businessRepoRef } from '../../../lib/platform/automation/repo-identity'
import { buildCommitTransferManifest } from '../../../lib/platform/automation/manifest-builder'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: 422 })
  return NextResponse.json({ jobId, ...built.data })
}
