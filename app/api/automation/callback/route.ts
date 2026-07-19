import { NextRequest, NextResponse } from 'next/server'
import { isEnabled } from '../../../lib/platform/flags'
import { verifyCallback, validateCallbackPayload, callbackMatchesJob } from '../../../lib/platform/automation/callback'
import { getJob, saveJob, callbackSeen, markCallbackSeen } from '../../../lib/platform/automation/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/automation/callback — the CI workflow reports here. NOT session-gated; gated
// by an HMAC signature over `${timestamp}.${rawBody}` (OPERION_CALLBACK_SECRET), a
// freshness window, a replay guard (deliveryId), and strict schema validation. Fail-closed:
// no secret / bad signature / stale / replayed / malformed → rejected, job untouched.
export async function POST(req: NextRequest) {
  if (!isEnabled('OPERION_AUTOMATION_ENABLED')) return NextResponse.json({ error: 'automation disabled' }, { status: 403 })

  const raw = await req.text()
  const verify = verifyCallback(raw, req.headers.get('x-operion-timestamp'), req.headers.get('x-operion-signature'), process.env.OPERION_CALLBACK_SECRET, Date.now())
  if (!verify.ok) return NextResponse.json({ error: 'unauthorized', reason: verify.reason }, { status: 401 })

  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }) }
  const v = validateCallbackPayload(parsed)
  if (!v.ok) return NextResponse.json({ error: 'invalid payload', reason: v.reason }, { status: 400 })
  const p = v.value

  // Replay guard — a delivery id is processed at most once.
  if (await callbackSeen(p.deliveryId)) return NextResponse.json({ ok: true, deduped: true })

  const job = await getJob(p.jobId)
  if (!job) { await markCallbackSeen(p.deliveryId); return NextResponse.json({ error: 'unknown job' }, { status: 404 }) }
  if (!callbackMatchesJob(p, job)) {
    await markCallbackSeen(p.deliveryId)
    return NextResponse.json({ error: 'callback does not match active job' }, { status: 409 })
  }

  const now = Date.now()
  job.heartbeatAt = now; job.workflowRunId = p.workflowRunId ?? job.workflowRunId
  if (p.branch) job.workBranch = p.branch
  if (p.commit) job.targetCommit = p.commit
  if (p.pullRequestNumber != null) job.pullRequestNumber = p.pullRequestNumber
  if (p.pullRequestUrl) job.pullRequestUrl = p.pullRequestUrl
  if (p.result) job.result = p.result

  if (p.status === 'preview_ready') {
    job.previewDeploymentId = p.previewDeploymentId; job.previewUrl = p.previewUrl
    job.status = 'awaiting_owner_review'; job.currentStep = 'owner_review'   // never auto-promotes
  } else {
    job.failureCategory = (p.status === 'tests_failed' ? 'tests_failed' : p.status === 'build_failed' ? 'build_failed' : p.status === 'apply_failed' ? 'apply_failed' : p.status === 'preview_failed' ? 'preview_failed' : 'provider_error')
    job.failureSummary = p.errorSummary ?? p.status
    // OPERION_AUTOMATIC_ROLLBACK_ENABLED consumer: when the job was flagged eligible at
    // prepare (flag on + verified rollback path), a failure auto-routes to rollback_required
    // instead of a plain terminal failure. Off ⇒ eligible=false ⇒ unchanged behavior.
    const failed = p.status === 'build_failed' ? 'build_failed' : 'failed'
    job.status = job.automaticRollbackEligible ? 'rollback_required' : failed
  }
  job.updatedAt = now
  await saveJob(job)
  await markCallbackSeen(p.deliveryId)
  return NextResponse.json({ ok: true, status: job.status })
}
