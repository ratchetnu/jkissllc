// ── Operion automation — signed callback verification (Phase 10) — PURE ──────
// The CI workflow reports results here. We NEVER trust an unsigned callback: HMAC-SHA256
// over `${timestamp}.${rawBody}`, a timestamp freshness window (replay guard), constant-
// time compare, and strict payload-schema validation. All pure → hermetically testable.

import crypto from 'node:crypto'
import type { WorkflowResult } from './types'
import type { UpdateAutomationJob } from './types'
import type { TargetDeploymentEvidence } from '../updates/types'
import { validateTargetEvidence } from './target-evidence'

export function signCallback(rawBody: string, timestamp: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
}

export type VerifyResult = { ok: boolean; reason?: string }
export function verifyCallback(
  rawBody: string, timestamp: string | null, signature: string | null, secret: string | undefined,
  now: number, opts: { windowMs?: number } = {},
): VerifyResult {
  if (!secret) return { ok: false, reason: 'callback secret not configured' }
  if (!signature) return { ok: false, reason: 'missing signature' }
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' }
  if (Math.abs(now - ts) > (opts.windowMs ?? 300_000)) return { ok: false, reason: 'timestamp outside window (replay guard)' }
  const expected = signCallback(rawBody, String(timestamp), secret)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature mismatch' }
  return { ok: true }
}

// ── Payload schema (strict; unknown/bad shapes rejected) ─────────────────────
export type CallbackPayload = {
  deliveryId: string
  jobId: string
  deploymentRequestId?: string
  status: 'tests_failed' | 'build_failed' | 'preview_ready' | 'preview_failed' | 'apply_failed' | 'error'
  step?: string
  branch?: string
  commit?: string
  pullRequestNumber?: number
  pullRequestUrl?: string
  workflowRunId?: string
  previewDeploymentId?: string
  previewUrl?: string
  result?: WorkflowResult
  errorCategory?: string
  errorSummary?: string
  /**
   * The target's value-free capability + build snapshot. Optional: a target that
   * predates the contract simply omits it and everything behaves as before. It is
   * only accepted here because the whole payload is already HMAC-verified,
   * freshness-checked, replay-guarded by deliveryId, and bound to the active job's
   * work branch — an unsigned or replayed report never reaches this field.
   */
  capabilityEvidence?: TargetDeploymentEvidence
  /** Entries the validator refused (a malformed id, a value where a NAME was due). */
  evidenceWarnings?: string[]
}

/** Bind a callback to the exact active job branch that the server derived at dispatch.
 *  A valid shared HMAC is not enough: Preview and Production can share repository secrets,
 *  and manual workflow dispatches can otherwise replay a signed result against another job. */
export function callbackMatchesJob(payload: CallbackPayload, job: UpdateAutomationJob): boolean {
  if (!payload.branch || !job.workBranch || payload.branch !== job.workBranch) return false
  return ['creating_branch', 'applying_update', 'testing', 'preview_deploying', 'preview_ready'].includes(job.status)
}

/** Preview callbacks cannot request a Production rollback because Production has not changed. */
export function previewFailureStatus(status: CallbackPayload['status']): 'build_failed' | 'failed' {
  return status === 'build_failed' ? 'build_failed' : 'failed'
}

const STATUSES = new Set(['tests_failed', 'build_failed', 'preview_ready', 'preview_failed', 'apply_failed', 'error'])
const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.slice(0, max) : undefined)

/**
 * `at` is OUR clock, not the target's. The evidence record is stamped with it so a
 * target cannot backdate or postdate its own report; the target's `reportedAt` is
 * carried through as advisory only.
 */
export function validateCallbackPayload(
  obj: unknown,
  opts: { at?: number } = {},
): { ok: true; value: CallbackPayload } | { ok: false; reason: string } {
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'not an object' }
  const o = obj as Record<string, unknown>
  const deliveryId = str(o.deliveryId, 128)
  const jobId = str(o.jobId, 64)
  const status = str(o.status, 32)
  if (!deliveryId) return { ok: false, reason: 'missing deliveryId' }
  if (!jobId) return { ok: false, reason: 'missing jobId' }
  if (!status || !STATUSES.has(status)) return { ok: false, reason: 'invalid status' }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const r = o.result && typeof o.result === 'object' ? (o.result as Record<string, unknown>) : undefined

  // Evidence is OPTIONAL and non-fatal: a target that reports a malformed snapshot
  // still gets its preview result recorded. Rejecting the whole callback would turn
  // a reporting bug on the target into a stuck deployment, which is a worse failure
  // than having no evidence.
  let capabilityEvidence: TargetDeploymentEvidence | undefined
  let evidenceWarnings: string[] | undefined
  if (o.capabilityEvidence !== undefined) {
    const ev = validateTargetEvidence(o.capabilityEvidence, opts.at ?? Date.now())
    if (ev.ok) {
      capabilityEvidence = ev.value
      evidenceWarnings = ev.warnings.length ? ev.warnings.slice(0, 20) : undefined
    } else {
      evidenceWarnings = [`capability evidence rejected: ${ev.reason}`]
    }
  }

  return {
    ok: true,
    value: {
      deliveryId, jobId, status: status as CallbackPayload['status'],
      deploymentRequestId: str(o.deploymentRequestId, 64), step: str(o.step, 40),
      branch: str(o.branch, 200), commit: str(o.commit, 80),
      pullRequestNumber: num(o.pullRequestNumber), pullRequestUrl: str(o.pullRequestUrl, 300),
      workflowRunId: str(o.workflowRunId, 64), previewDeploymentId: str(o.previewDeploymentId, 128), previewUrl: str(o.previewUrl, 300),
      result: r ? {
        testsPassed: typeof r.testsPassed === 'boolean' ? r.testsPassed : undefined,
        testTotal: num(r.testTotal), testFailed: num(r.testFailed),
        buildPassed: typeof r.buildPassed === 'boolean' ? r.buildPassed : undefined,
        lintPassed: typeof r.lintPassed === 'boolean' ? r.lintPassed : undefined,
        changedFiles: num(r.changedFiles), filesApplied: num(r.filesApplied), filesSkipped: num(r.filesSkipped), filesFailed: num(r.filesFailed),
        adaptationReport: str(r.adaptationReport, 4000),
        warnings: Array.isArray(r.warnings) ? r.warnings.filter(w => typeof w === 'string').slice(0, 20) as string[] : undefined,
      } : undefined,
      errorCategory: str(o.errorCategory, 60), errorSummary: str(o.errorSummary, 2000),
      capabilityEvidence, evidenceWarnings,
    },
  }
}
