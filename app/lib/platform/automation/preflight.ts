// ── Operion automation — PURE preflight + config validators ──────────────────
// No I/O. "Show every failed gate; never start automation while a required gate is
// unresolved." Also the server-side allowlist / commit-drift / rollback-eligibility
// checks that keep browser input from ever choosing a repo, branch, or workflow.

import type { PlatformUpdate, PlatformBusiness, UpdateCompatibility } from '../updates/types'
import { businessRepoRef } from './repo-identity'
import type { UpdateApplicability } from './target-evidence'
import { resolveSourceArtifact } from '../release/source-artifact'

/**
 * What KIND of thing a gate is asking about. This is what lets a caller say
 * "blocked by a required platform dependency" instead of "blocked", and it is the
 * difference between an operator knowing to fix infrastructure and an operator
 * hunting through twenty rows to work out which one mattered.
 *
 *   platform       Required infrastructure or provenance. A real blocker.
 *   review         A human has to decide something (a manual port, an unassessed
 *                  compatibility, an unapproved migration). Not broken — undecided.
 *   capability     An optional capability's code or activation. Only the CODE half
 *                  may block; activation never does.
 *   documentation  Advisory. Never blocks anything, ever.
 */
export type PreflightGateClass = 'platform' | 'review' | 'capability' | 'documentation'

export type PreflightGate = {
  id: string
  label: string
  ok: boolean
  blocking: boolean
  reason?: string
  gateClass: PreflightGateClass
}

/**
 * The single word an operator needs, and the reasons behind it.
 *
 *   ready                        Send it.
 *   ready_optional_unavailable   Send it. Some of what it ships will be dormant on
 *                                this target because the tenant does not run the
 *                                optional feature involved. NOT a problem, and
 *                                emphatically NOT a reason to withhold the update.
 *   manual_review                A person has to decide something first.
 *   blocked_by_platform          Required infrastructure or provenance is missing.
 */
export type PreflightVerdict = 'ready' | 'ready_optional_unavailable' | 'manual_review' | 'blocked_by_platform'

export type PreflightResult = {
  ok: boolean
  gates: PreflightGate[]
  verdict: PreflightVerdict
  /** One plain sentence naming the verdict's cause. */
  summary: string
  /** The exact gate reasons behind the verdict — never a bare count. */
  reasons: string[]
  /** Capabilities that will land dormant, or that need activation on this target. */
  affectedCapabilities: string[]
}

export type PreflightInput = {
  update: PlatformUpdate
  business: PlatformBusiness
  compat?: UpdateCompatibility
  hasActiveJob: boolean
  flags: { automation: boolean; preview: boolean; githubActions: boolean; controlPlane?: boolean }
  approvals?: { migration?: boolean; environment?: boolean }
  /**
   * Required updates (issue #48 Phase B). Resolved by the orchestrator, which reads
   * compatibility + deployments, and passed in so this function stays pure. Absent =
   * not yet evaluated, which is treated as satisfied ONLY for updates that declare no
   * dependencies — the orchestrator always supplies it when there are any.
   */
  requiredUpdates?: { ok: boolean; missing: string[]; detail?: string }
  /**
   * Exact commit-transfer readiness (issue #48 Phase A, hoisted to preflight). The
   * orchestrator builds the real manifest and reports the verdict; a failure here
   * means the transfer would not compile on the target.
   */
  transferReady?: { ok: boolean; reason?: string }
  /**
   * What this update means for this target's capabilities (see target-evidence.ts).
   *
   * ── THE INVARIANT THIS ENCODES ──
   * An optional provider's configuration is NEVER a deployment prerequisite. There
   * is no gate below that reads Stripe / Twilio / Resend readiness, and none may be
   * added: a security or shared-library fix must reach a target whose owner has
   * deliberately switched every optional integration off. Installation and
   * activation are separate events.
   *
   * The ONE capability fact that may block is `missingCapabilityCode` — the target
   * lacks the CODE a transfer depends on, which is the same class of blocker as
   * `requiredModules` and would fail to compile. Activation requirements are
   * reported as a SOFT gate so the owner sees the remaining step without the
   * deployment being held hostage to it.
   */
  capabilityImpact?: UpdateApplicability
}

// `partially_deployed` means the approved update has reached at least one business but
// still has eligible targets remaining. It must remain previewable for those targets;
// otherwise recording the source deployment permanently deadlocks cross-business rollout.
// The ONLY update statuses eligible to reach the target. Exported because retry must be
// judged by exactly this list too — a retry is a dispatch, and an update that may not be
// dispatched may not be re-dispatched either. Anything absent (archived, rejected,
// fully_deployed, superseded, queued, …) is ineligible by omission, so a new status is
// ineligible until someone deliberately adds it.
export const APPROVED_STATUSES = ['approved', 'ready_to_release', 'ready_for_review', 'included_in_release', 'partially_deployed']

export function evaluatePreflight(x: PreflightInput): PreflightResult {
  const g: PreflightGate[] = []
  const add = (id: string, label: string, ok: boolean, blocking: boolean, reason?: string, gateClass: PreflightGateClass = 'platform') =>
    g.push({ id, label, ok, blocking, reason: ok ? undefined : reason, gateClass })

  // Automation must be enabled + a target with automation config.
  add('automation_enabled', 'Automation enabled', x.flags.automation, true, 'OPERION_AUTOMATION_ENABLED is off')
  add('preview_automation_enabled', 'Preview automation enabled', x.flags.preview, true, 'OPERION_PREVIEW_AUTOMATION_ENABLED is off')
  add('github_actions_enabled', 'GitHub Actions execution enabled', x.flags.githubActions, true, 'OPERION_GITHUB_ACTIONS_ENABLED is off')
  add('production_control_plane', 'Production control plane', x.flags.controlPlane !== false, true, 'workflow dispatch is disabled from Vercel Preview deployments')
  add('target_is_target', 'Selected business is a deploy target', x.business.role === 'target' || x.business.role === 'source_and_target', true, 'business is not a target')
  add('target_configured', 'Target automation configured', x.business.configurationStatus === 'ready'
    && !!businessRepoRef(x.business) && !!x.business.githubInstallationId && !!x.business.automationWorkflowFile,
    true, 'target GitHub App install / repo / workflow not configured (status must be "ready")')
  add('preview_provider', 'Preview provider configured', !!x.business.previewProjectId && !!x.business.previewDeploymentProvider, true, 'no preview project configured')

  // Update readiness + provenance.
  add('update_approved', 'Update approved', APPROVED_STATUSES.includes(x.update.status), true, `update status is "${x.update.status}"`)
  // The artifact must be a COMMIT — not a branch, not a working tree. A deployment
  // built from "whatever is on disk" cannot be reproduced, diffed, or rolled back to
  // a known point, because there is no known point.
  const artifact = resolveSourceArtifact({
    updateKey: x.update.key,
    sourceRepo: x.update.sourceRepo,
    sourceCommit: x.update.sourceCommit,
    sourceWorktreeDirty: x.update.sourceWorktreeDirty,
  })
  add('source_commit', 'Source is a committed, reproducible artifact', artifact.ok, true, artifact.ok ? undefined : artifact.reason)
  add('tests_defined', 'Source tests + build green', x.update.validation.tests === 'passed' && x.update.validation.build === 'passed', true, 'source tests/build not marked passed')

  // Compatibility must be assessed and not blocking.
  const c = x.compat
  add('compat_assessed', 'Compatibility assessed', !!c && c.status !== 'unknown' && c.status !== 'under_review', true, 'compatibility not assessed for this target', 'review')
  add('compat_not_blocked', 'Compatibility not incompatible/blocked', !c || (c.status !== 'incompatible' && c.status !== 'blocked'), true, c?.blockingIssues ?? 'compatibility is incompatible/blocked', 'review')
  add(
    'deterministic_transfer',
    'No manual port or code reconciliation required',
    !(x.update.manualPortRequired || c?.manualPortRequired || c?.codeReconciliationRequired),
    true,
    'this update requires a manual port or code reconciliation and cannot use deterministic commit transfer',
    'review',
  )

  // Branch allowlist (base = target default branch).
  const base = x.business.defaultBranch
  add('branch_allowlisted', 'Base branch allowlisted', !!base && (x.business.allowedTargetBranches?.length ? x.business.allowedTargetBranches.includes(base) : true), true, `base branch "${base}" not in allowlist`)

  // Health not down; no conflicting job.
  add('target_health', 'Target health not down', x.business.healthStatus !== 'down', true, 'target health is down')
  add('no_conflicting_job', 'No conflicting automation job', !x.hasActiveJob, true, 'another automation job is active for this target')

  // Required updates must already be installed AND verified on THIS target. An update
  // that declares none is unaffected — `dependencies` is absent on every record that
  // predates this gate, so those evaluate as satisfied and behave exactly as before.
  const req = x.requiredUpdates
  add(
    'required_updates',
    'Required updates installed',
    !req || req.ok,
    true,
    req && !req.ok
      ? `this update needs ${req.missing.join(', ')} on this business first${req.detail ? ` — ${req.detail}` : ''}`
      : 'a required update is not installed on this business',
  )

  // The exact files this transfer would send must resolve on the target. This is the
  // Phase A closure check run BEFORE a job exists, so an incomplete update never
  // reaches branch creation or workflow dispatch.
  const transfer = x.transferReady
  add(
    'transfer_ready',
    'Transfer is complete for this target',
    !transfer || transfer.ok,
    true,
    transfer?.reason ?? 'the transfer is missing files this business needs',
  )

  // ── Capability gates ──
  // Blocking: the target does not have the CODE this transfer depends on. That is a
  // compile-time fact, not a preference.
  const cap = x.capabilityImpact
  add(
    'capability_code_present',
    'Required capability code present on target',
    !cap || cap.missingCapabilityCode.length === 0,
    true,
    cap && cap.missingCapabilityCode.length ? `this target is missing the code for ${cap.missingCapabilityCode.join(', ')}` : 'a required capability is not implemented on this target',
    'capability',
  )
  // NON-blocking: what the owner must do for the shipped behavior to become live.
  // Deliberately soft — an update that lands dormant has still landed, and holding
  // the deploy until someone configures an optional provider is exactly the failure
  // this whole gate set exists to prevent.
  add(
    'capability_activation',
    'Optional features ready to activate (informational)',
    !cap || cap.activationRequirements.length === 0,
    false,
    cap && cap.activationRequirements.length
      ? `installs now, dormant until: ${cap.activationRequirements.map(r => r.detail).join('; ')}`
      : 'some shipped behavior stays off until the owner activates it',
    'capability',
  )

  // Owner-gated approvals for risky changes.
  add('migration_approved', 'Migration approved (if any)', !x.update.migrationRequired || x.approvals?.migration === true, true, 'migration requires explicit owner approval', 'review')
  add('env_approved', 'Env/secret change approved (if any)', !(x.update.environmentChangeRequired || x.update.secretRequired) || x.approvals?.environment === true, true, 'env/secret change requires explicit owner approval', 'review')

  // Soft (non-blocking) documentation gates.
  add('flags_documented', 'Feature flags documented (if any)', !x.update.featureFlagRequired || !!(x.update.ownerNotes || x.update.technicalImpact), false, 'document the feature flag(s) in owner notes', 'documentation')
  add('rollback_documented', 'Rollback path documented', x.update.rollbackSupported, false, 'no rollback path recorded', 'documentation')

  const ok = g.every(gate => gate.ok || !gate.blocking)
  return { ok, gates: g, ...classifyPreflight(g, x.capabilityImpact) }
}

/**
 * Turn the gate set into ONE verdict, plus the reasons behind it.
 *
 * The ordering is the whole point. A missing optional integration and a missing
 * GitHub App are both "a gate failed"; only one of them is a reason not to ship. So
 * platform blockers outrank review items, review items outrank optional gaps, and an
 * optional gap NEVER produces a blocked verdict — the strongest thing it can say is
 * "ready, and some of this will be dormant".
 */
export function classifyPreflight(
  gates: PreflightGate[],
  capabilityImpact?: UpdateApplicability,
): Pick<PreflightResult, 'verdict' | 'summary' | 'reasons' | 'affectedCapabilities'> {
  const failed = gates.filter((g) => !g.ok && g.blocking)
  const reasonsFor = (cls: PreflightGateClass) =>
    failed.filter((g) => g.gateClass === cls).map((g) => g.reason ?? g.label)

  const platform = reasonsFor('platform')
  const capabilityCode = reasonsFor('capability')
  const review = reasonsFor('review')

  // A missing capability CODE dependency is a platform-class blocker in substance —
  // the transfer would not compile — even though it is discovered through the
  // capability model. Grouped with platform so the verdict is about consequence
  // rather than provenance.
  const hardBlockers = [...platform, ...capabilityCode]
  const affected = [
    ...(capabilityImpact?.missingCapabilityCode ?? []),
    ...(capabilityImpact?.affectedCapabilities ?? []),
    ...(capabilityImpact?.activationRequirements ?? []).map((r) => r.capability),
  ]
  const affectedCapabilities = [...new Set(affected)]

  if (hardBlockers.length) {
    return {
      verdict: 'blocked_by_platform',
      summary: `Blocked by a required platform dependency: ${hardBlockers[0]}`,
      reasons: hardBlockers,
      affectedCapabilities,
    }
  }
  if (review.length) {
    return {
      verdict: 'manual_review',
      summary: `A person needs to decide something first: ${review[0]}`,
      reasons: review,
      affectedCapabilities,
    }
  }

  const dormant = capabilityImpact?.dormant === true
  const activation = capabilityImpact?.activationRequirements ?? []
  if (dormant || activation.length) {
    return {
      verdict: 'ready_optional_unavailable',
      summary: dormant
        ? 'Ready. Everything it touches is switched off on this target, so it installs and stays dormant.'
        : 'Ready. Some of what it ships stays off until the optional features below are turned on.',
      reasons: activation.length ? activation.map((r) => r.detail) : [capabilityImpact?.rationale ?? 'optional features are switched off on this target'],
      affectedCapabilities,
    }
  }

  return { verdict: 'ready', summary: 'Ready.', reasons: [], affectedCapabilities }
}

// ── Server-side allowlist / drift / rollback validators ──────────────────────
// Allowlist matches against the business's CANONICAL owner/name — never browser input.
export function isRepoAllowed(b: PlatformBusiness, owner: string, name: string): boolean {
  const ref = businessRepoRef(b)
  return !!ref && ref.owner === owner && ref.name === name
}
export function isBranchAllowed(b: PlatformBusiness, branch: string, kind: 'source' | 'target'): boolean {
  const list = kind === 'source' ? b.allowedSourceBranches : b.allowedTargetBranches
  if (!list || list.length === 0) return branch === b.defaultBranch
  return list.includes(branch)
}
/** Deterministic, server-derived work branch — NEVER taken from browser input. */
export function workBranchFor(updateKey: string): string {
  return `operion/${updateKey.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`
}
/** True when the commit the owner approved differs from the PR's current head. */
export function commitDriftDetected(approvedCommit: string | undefined, currentCommit: string | undefined): boolean {
  return !!approvedCommit && !!currentCommit && approvedCommit !== currentCommit
}
export function automaticRollbackEligible(opts: {
  enabled: boolean; productionProjectId?: string; irreversibleMigration: boolean; previousVerifiedCommit?: string
}): boolean {
  return opts.enabled && !!opts.productionProjectId && !opts.irreversibleMigration && !!opts.previousVerifiedCommit
}
