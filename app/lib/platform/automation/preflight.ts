// ── Operion automation — PURE preflight + config validators ──────────────────
// No I/O. "Show every failed gate; never start automation while a required gate is
// unresolved." Also the server-side allowlist / commit-drift / rollback-eligibility
// checks that keep browser input from ever choosing a repo, branch, or workflow.

import type { PlatformUpdate, PlatformBusiness, UpdateCompatibility } from '../updates/types'
import { businessRepoRef } from './repo-identity'

export type PreflightGate = { id: string; label: string; ok: boolean; blocking: boolean; reason?: string }
export type PreflightResult = { ok: boolean; gates: PreflightGate[] }

export type PreflightInput = {
  update: PlatformUpdate
  business: PlatformBusiness
  compat?: UpdateCompatibility
  hasActiveJob: boolean
  flags: { automation: boolean; preview: boolean; githubActions: boolean }
  approvals?: { migration?: boolean; environment?: boolean }
}

const APPROVED_STATUSES = ['approved', 'ready_to_release', 'ready_for_review', 'included_in_release']

export function evaluatePreflight(x: PreflightInput): PreflightResult {
  const g: PreflightGate[] = []
  const add = (id: string, label: string, ok: boolean, blocking: boolean, reason?: string) => g.push({ id, label, ok, blocking, reason: ok ? undefined : reason })

  // Automation must be enabled + a target with automation config.
  add('automation_enabled', 'Automation enabled', x.flags.automation, true, 'OPERION_AUTOMATION_ENABLED is off')
  add('target_is_target', 'Selected business is a deploy target', x.business.role === 'target' || x.business.role === 'source_and_target', true, 'business is not a target')
  add('target_configured', 'Target automation configured', x.business.configurationStatus === 'ready'
    && !!businessRepoRef(x.business) && !!x.business.githubInstallationId && !!x.business.automationWorkflowFile,
    true, 'target GitHub App install / repo / workflow not configured (status must be "ready")')
  add('preview_provider', 'Preview provider configured', !!x.business.previewProjectId && !!x.business.previewDeploymentProvider, true, 'no preview project configured')

  // Update readiness + provenance.
  add('update_approved', 'Update approved', APPROVED_STATUSES.includes(x.update.status), true, `update status is "${x.update.status}"`)
  add('source_commit', 'Source commit recorded', !!x.update.sourceCommit, true, 'update has no source commit')
  add('tests_defined', 'Source tests + build green', x.update.validation.tests === 'passed' && x.update.validation.build === 'passed', true, 'source tests/build not marked passed')

  // Compatibility must be assessed and not blocking.
  const c = x.compat
  add('compat_assessed', 'Compatibility assessed', !!c && c.status !== 'unknown' && c.status !== 'under_review', true, 'compatibility not assessed for this target')
  add('compat_not_blocked', 'Compatibility not incompatible/blocked', !c || (c.status !== 'incompatible' && c.status !== 'blocked'), true, c?.blockingIssues ?? 'compatibility is incompatible/blocked')

  // Branch allowlist (base = target default branch).
  const base = x.business.defaultBranch
  add('branch_allowlisted', 'Base branch allowlisted', !!base && (x.business.allowedTargetBranches?.length ? x.business.allowedTargetBranches.includes(base) : true), true, `base branch "${base}" not in allowlist`)

  // Health not down; no conflicting job.
  add('target_health', 'Target health not down', x.business.healthStatus !== 'down', true, 'target health is down')
  add('no_conflicting_job', 'No conflicting automation job', !x.hasActiveJob, true, 'another automation job is active for this target')

  // Owner-gated approvals for risky changes.
  add('migration_approved', 'Migration approved (if any)', !x.update.migrationRequired || x.approvals?.migration === true, true, 'migration requires explicit owner approval')
  add('env_approved', 'Env/secret change approved (if any)', !(x.update.environmentChangeRequired || x.update.secretRequired) || x.approvals?.environment === true, true, 'env/secret change requires explicit owner approval')

  // Soft (non-blocking) documentation gates.
  add('flags_documented', 'Feature flags documented (if any)', !x.update.featureFlagRequired || !!(x.update.ownerNotes || x.update.technicalImpact), false, 'document the feature flag(s) in owner notes')
  add('rollback_documented', 'Rollback path documented', x.update.rollbackSupported || !!x.business.rollbackWorkflowFile, false, 'no rollback path recorded')

  const ok = g.every(gate => gate.ok || !gate.blocking)
  return { ok, gates: g }
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
  enabled: boolean; rollbackWorkflowFile?: string; irreversibleMigration: boolean; previousVerifiedCommit?: string
}): boolean {
  return opts.enabled && !!opts.rollbackWorkflowFile && !opts.irreversibleMigration && !!opts.previousVerifiedCommit
}
