// ── The guided Operion → target update workflow (PURE) ───────────────────────
//
// One owner-facing narrative over the EXISTING machinery. Nothing here executes:
// it reads the state the automation job, the approval record and the publish record
// are already in, and answers two questions —
//
//   "Where is this?"  and  "What is the ONE thing to do next?"
//
// ── Why this exists ──────────────────────────────────────────────────────────
//
// The Update Center exposed the internal state space directly: eighteen automation
// statuses, five publish statuses, five approval states, ~20 preflight gates and a
// dozen separate buttons, each valid in some subset of combinations. That is an
// accurate picture of the machine and a useless one for the person operating it —
// the owner had to know that `awaiting_owner_review` means "your turn" while
// `preview_ready` does not, and that `partially_deployed` is success.
//
// ── What is deliberately NOT simplified ──────────────────────────────────────
//
// Every safety control is untouched and still enforced where it always was:
// source-commit pinning, target drift detection, dependency closure, symbol
// verification, path exclusions, owner-only authorization, the Preview requirement,
// typed Production intent, idempotency, concurrency locks, audit records, rollback
// capture, and exact deployment verification. This module cannot weaken any of
// them, because it performs no writes and grants no permissions — it only decides
// which existing, separately-authorized endpoint to point the owner at. The
// simplification is in the NARRATION, not the gates.

import type { PreflightGate, PreflightResult, PreflightVerdict } from './preflight'
import type { UpdateAutomationJob } from './types'
import type { UpdateApplicability } from './target-evidence'

/** The stages an owner actually experiences. Ordered; `blocked` sits outside. */
export const GUIDED_STAGES = [
  'choose', 'checking', 'ready_to_send', 'sending', 'previewing',
  'review_preview', 'confirm_production', 'publishing', 'verifying', 'live',
] as const
export type GuidedStage = (typeof GUIDED_STAGES)[number] | 'blocked' | 'failed' | 'rollback_required'

/**
 * A single action. `endpoint` + `method` + `body` name an EXISTING, separately
 * authorized route — this module never becomes a second executor, it points at the
 * one that already exists and already re-validates everything server-side.
 */
export type GuidedAction = {
  id: 'send_preview' | 'retry_preview' | 'open_review' | 'approve' | 'publish' | 'rollback' | 'cancel' | 'refresh'
  label: string
  endpoint?: string
  method?: 'POST' | 'DELETE'
  body?: Record<string, unknown>
  /** When true the client MUST collect an exact typed phrase before submitting. */
  requiresTypedConfirmation?: boolean
  phrase?: string
  /** Rendered as a destructive action (rollback, cancel). */
  destructive?: boolean
}

/** One plain-language problem and the one thing that fixes it. */
export type GuidedBlocker = {
  /** Stable, non-secret. Safe in a log and an API response. */
  code: string
  /** No internal status names, no gate ids — what a person can act on. */
  plain: string
  recovery: GuidedAction
}

export type GuidedState = {
  stage: GuidedStage
  /** Step N of M along the happy path. `blocked`/`failed` keep the last index. */
  stepIndex: number
  totalSteps: number
  headline: string
  detail: string
  /** Exactly one, or none while the system is working. */
  primary: GuidedAction | null
  blocker?: GuidedBlocker
  /** What an optional-feature-free target gains. Never a reason to withhold an update. */
  capabilityNote?: string
  /**
   * The preflight verdict, in the vocabulary an operator can act on. Carried
   * separately from `stage` because they answer different questions: the stage is
   * where the work has got to, the verdict is whether it may proceed at all.
   */
  verdict?: PreflightVerdict
  /** Exact reasons behind the verdict. Never a bare count. */
  verdictReasons: string[]
  /** Capabilities this update touches on this target. */
  affectedCapabilities: string[]
  /**
   * Internal vocabulary, for the Advanced disclosure ONLY. The normal path never
   * renders these — that was the whole problem.
   */
  advanced: {
    jobId?: string
    jobStatus?: string
    publishStatus?: string
    approvalState?: string
    failedGates: { id: string; label: string; reason?: string; blocking: boolean }[]
    softGates: { id: string; label: string; reason?: string }[]
  }
}

export type GuidedInput = {
  update: { key: string; title: string } | null
  business: { id: string; name: string; slug?: string } | null
  preflight: PreflightResult | null
  job: Pick<UpdateAutomationJob,
    'id' | 'status' | 'previewUrl' | 'previewDeploymentId' | 'failureSummary' | 'failureCategory' | 'pullRequestUrl'
  > | null
  /** From the existing approval route. */
  approval: { state: string; requiredPhrase?: string } | null
  /** From the existing publish route. */
  publish: { state: string; failureReason?: string; requiredPhrase?: string; ready?: boolean; blocker?: { code: string; message: string } } | null
  capabilityImpact?: UpdateApplicability | null
}

const STEP_OF: Record<string, number> = {
  choose: 1, checking: 2, ready_to_send: 2, sending: 3, previewing: 3,
  review_preview: 4, confirm_production: 5, publishing: 6, verifying: 6, live: 7,
}
export const GUIDED_TOTAL_STEPS = 7

// ── Plain-language translation of the internal refusal vocabulary ────────────
//
// Each entry answers "what does the owner DO?", not "what did the machine call
// this?". An unmapped gate falls back to the gate's own reason — visible and
// honest — rather than a generic "something went wrong".
const GATE_PLAIN: Record<string, string> = {
  automation_enabled: 'Automated updates are switched off for this Operion deployment.',
  preview_automation_enabled: 'Sending updates to a Preview is switched off for this Operion deployment.',
  github_actions_enabled: 'Running the update on the target repository is switched off.',
  production_control_plane: 'You are on a Preview build of Operion. Updates can only be sent from the live Operion.',
  target_is_target: 'This business is not set up to receive updates.',
  target_configured: 'Supercharged’s connection is not finished — the repository, the installed app, or the workflow file is missing.',
  preview_provider: 'Supercharged has no Preview project connected, so there is nowhere to test the update.',
  update_approved: 'This update has not been approved for release yet.',
  source_commit: 'This update has no source commit recorded, so there is nothing exact to copy.',
  tests_defined: 'This update’s own tests and build are not recorded as passing.',
  compat_assessed: 'Nobody has assessed whether this update fits Supercharged yet.',
  compat_not_blocked: 'This update has been marked as incompatible with Supercharged.',
  deterministic_transfer: 'This update needs to be ported by hand — it cannot be copied across automatically.',
  branch_allowlisted: 'Supercharged’s branch is not on the allowed list.',
  target_health: 'Supercharged is reporting itself as down. Fix that first.',
  no_conflicting_job: 'Another update is already running for Supercharged. Wait for it to finish.',
  required_updates: 'An earlier update has to reach Supercharged first.',
  transfer_ready: 'Some of the files this update needs are missing on Supercharged.',
  capability_code_present: 'Supercharged is missing code this update depends on. Send that update first.',
  migration_approved: 'This update changes stored data. You need to approve that explicitly.',
  env_approved: 'This update needs a new setting or secret. You need to approve that explicitly.',
}

/** The single most useful failed gate: the first blocking one, in declaration order. */
export function firstBlockingGate(preflight: PreflightResult | null): PreflightGate | null {
  return preflight?.gates.find((g) => !g.ok && g.blocking) ?? null
}

function plainFor(gate: PreflightGate): string {
  return GATE_PLAIN[gate.id] ?? gate.reason ?? `${gate.label} is not satisfied.`
}

// Job statuses grouped by what they MEAN to an owner, rather than by their names.
const SENDING = new Set(['queued', 'draft', 'validating', 'creating_branch'])
const RUNNING = new Set(['applying_update', 'testing', 'preview_deploying', 'preview_ready'])
const OWNER_TURN = new Set(['awaiting_owner_review'])
const PROMOTING = new Set(['approved_for_production', 'merging', 'production_deploying'])
const FAILED = new Set(['failed', 'build_failed', 'cancelled'])
const ROLLBACK = new Set(['rollback_required', 'rolling_back', 'rolled_back'])

const refresh: GuidedAction = { id: 'refresh', label: 'Check again' }

/**
 * Derive the whole owner-facing view. Deterministic: the same inputs always give
 * the same stage, headline and single action — which is what makes the workflow
 * survive a refresh or a logout. Nothing is held in the browser.
 */
export function deriveGuidedState(input: GuidedInput): GuidedState {
  const advanced: GuidedState['advanced'] = {
    jobId: input.job?.id,
    jobStatus: input.job?.status,
    publishStatus: input.publish?.state,
    approvalState: input.approval?.state,
    failedGates: (input.preflight?.gates ?? []).filter((g) => !g.ok && g.blocking).map((g) => ({ id: g.id, label: g.label, reason: g.reason, blocking: true })),
    softGates: (input.preflight?.gates ?? []).filter((g) => !g.ok && !g.blocking).map((g) => ({ id: g.id, label: g.label, reason: g.reason })),
  }

  const capabilityNote = input.capabilityImpact
    ? input.capabilityImpact.rationale
    : undefined
  const verdict = input.preflight?.verdict
  const verdictReasons = input.preflight?.reasons ?? []
  const affectedCapabilities = input.preflight?.affectedCapabilities ?? input.capabilityImpact?.affectedCapabilities ?? []

  const at = (stage: GuidedStage, headline: string, detail: string, primary: GuidedAction | null, blocker?: GuidedBlocker): GuidedState => ({
    stage,
    stepIndex: STEP_OF[stage] ?? STEP_OF[input.job ? 'previewing' : 'choose'] ?? 1,
    totalSteps: GUIDED_TOTAL_STEPS,
    headline, detail, primary, blocker, capabilityNote, verdict, verdictReasons, affectedCapabilities, advanced,
  })

  if (!input.update || !input.business) {
    return at('choose', 'Choose an update', 'Pick the update you want to send, then choose Supercharged.', null)
  }

  const target = input.business.name

  // ── Rollback and failure come first: they outrank any forward motion ──
  if (input.job && ROLLBACK.has(input.job.status)) {
    return at('rollback_required', `Rolling ${target} back`, 'The production update did not verify, so the previous known-good build is being restored.', null, {
      code: 'ROLLBACK_IN_PROGRESS',
      plain: `The update reached ${target} but did not come up healthy. The previous build is being put back.`,
      recovery: refresh,
    })
  }

  if (input.publish?.state === 'failed') {
    return at('failed', `Publishing to ${target} failed`, input.publish.failureReason ?? 'The production publish did not complete.', null, {
      code: 'PUBLISH_FAILED',
      plain: `${target} is still on its previous build — nothing was half-applied. ${input.publish.failureReason ?? ''}`.trim(),
      recovery: { id: 'rollback', label: 'Restore the previous build', endpoint: `/api/admin/release/businesses/${input.business.id}/rollback`, method: 'POST', destructive: true },
    })
  }

  if (input.job && FAILED.has(input.job.status)) {
    const why = input.job.failureSummary || 'The update did not pass on Supercharged.'
    return at('failed', `The test run on ${target} did not pass`, why, null, {
      code: input.job.failureCategory ?? 'PREVIEW_FAILED',
      plain: `Nothing was published. ${target} is untouched. ${why}`,
      recovery: { id: 'retry_preview', label: 'Try again', endpoint: `/api/admin/platform/automation/${input.job.id}`, method: 'POST', body: { action: 'retry' } },
    })
  }

  // ── Live ──
  if (input.publish?.state === 'ready') {
    return at('live', `Live in ${target}`, 'The update is verified and serving in production.', null)
  }
  if (input.publish?.state === 'verifying' || input.publish?.state === 'unconfirmed') {
    return at('verifying', `Confirming ${target} is live`, 'The update has been promoted; Operion is checking the live build before calling it done.', null)
  }
  if (input.publish?.state === 'publishing' || input.publish?.state === 'queued' || (input.job && PROMOTING.has(input.job.status))) {
    return at('publishing', `Publishing to ${target}`, 'Merging and deploying. This does not need anything from you.', null)
  }

  // ── No job yet: readiness decides between "send" and "blocked" ──
  if (!input.job) {
    if (!input.preflight) return at('checking', 'Checking compatibility', `Operion is checking whether this update can go to ${target}.`, null)
    const gate = firstBlockingGate(input.preflight)
    if (gate) {
      // `manual_review` and `blocked_by_platform` are different problems with
      // different fixes, and telling an owner "blocked" for both is how a decision
      // waiting on them gets mistaken for an outage waiting on somebody else.
      const headline = input.preflight.verdict === 'manual_review'
        ? `This update needs a decision before it can go to ${target}`
        : `This update can’t go to ${target} yet`
      return at('blocked', headline, plainFor(gate), null, {
        code: gate.id,
        plain: plainFor(gate),
        recovery: refresh,
      })
    }
    const optionalNote = input.preflight.verdict === 'ready_optional_unavailable'
      ? ` Some of what it ships will stay dormant on ${target} — that is expected, and not a reason to hold it.`
      : ''
    return at('ready_to_send', `Ready to send to ${target}`, `Operion will copy the approved files to a ${target} branch, run its tests and build, and open a Preview. Nothing goes live.${optionalNote}`, {
      id: 'send_preview', label: `Send to ${target} Preview`,
      endpoint: '/api/admin/platform/automation', method: 'POST',
      body: { updateKey: input.update.key, businessId: input.business.id },
    })
  }

  // ── A job exists ──
  if (SENDING.has(input.job.status)) {
    return at('sending', `Sending to ${target}`, 'Creating the branch and handing the files over. You can leave this page — progress is kept on the server.', null)
  }
  if (RUNNING.has(input.job.status)) {
    return at('previewing', `Testing on ${target}`, 'Running Supercharged’s own typecheck, tests and build, then deploying a Preview.', null)
  }

  if (OWNER_TURN.has(input.job.status)) {
    // Preview passed. Two sub-stages: read the review, then confirm production.
    const approvalReady = input.approval?.state === 'active'
    if (!approvalReady) {
      return at('review_preview', 'Preview passed — your turn', `Check what changed and open the ${target} Preview. Nothing is live yet.`, {
        id: 'open_review', label: 'Review Preview',
      })
    }
    const blocker = input.publish?.ready === false && input.publish.blocker
      ? { code: input.publish.blocker.code, plain: input.publish.blocker.message, recovery: refresh }
      : undefined
    return at('confirm_production', `Publish to ${target}?`, 'This is the step that changes what customers see. Type the confirmation phrase exactly to continue.',
      blocker ? null : {
        id: 'publish', label: `Publish to ${target}`,
        endpoint: `/api/admin/release/businesses/${input.business.id}/publish`, method: 'POST',
        requiresTypedConfirmation: true, phrase: input.publish?.requiredPhrase,
      },
      blocker,
    )
  }

  if (input.job.status === 'blocked') {
    return at('blocked', `This update can’t go to ${target} yet`, input.job.failureSummary ?? 'The connection to Supercharged is not finished.', null, {
      code: 'EXECUTION_NOT_CONFIGURED',
      plain: input.job.failureSummary ?? `Supercharged’s connection is not finished, so the update was prepared but not sent.`,
      recovery: refresh,
    })
  }

  if (input.job.status === 'completed') {
    return at('live', `Live in ${target}`, 'The update is verified and serving in production.', null)
  }

  // Unknown status: say so honestly rather than inventing a stage.
  return at('checking', 'Working…', `Operion is between steps on ${target}. This page updates on its own.`, null)
}

/**
 * The phrase gate, restated for the client. A typed confirmation is compared
 * SERVER-SIDE by the publish route; this is only what the UI validates before it
 * bothers submitting, so a mismatch is a local message rather than a round trip.
 */
export function typedConfirmationSatisfied(typed: string, phrase: string | undefined): boolean {
  if (!phrase) return false
  return typed.trim().replace(/\s+/g, ' ').toUpperCase() === phrase.trim().replace(/\s+/g, ' ').toUpperCase()
}
