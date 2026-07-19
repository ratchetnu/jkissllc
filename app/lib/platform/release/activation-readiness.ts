// ── Operion 3B.7 — activation readiness (PURE) ──────────────────────────────
//
// One fail-closed projection for the owner to answer "what can safely be enabled?".
// It never reads providers, changes flags, or exposes env values. The route supplies only
// boolean configuration evidence plus server-derived business/rollback metadata.

import type { PlatformBusiness } from '../updates/types'
import { isRepoAllowed, isTestOnlyBusiness, isVercelProjectAllowed } from './promotion-guards'

export type ActivationStageId = 'provider_access' | 'preview_automation' | 'controlled_production' | 'advanced_automation'
export type ActivationCheckKind = 'configuration' | 'flag' | 'business' | 'rollback'
export type ActivationCheck = { id: string; label: string; ok: boolean; kind: ActivationCheckKind; detail: string }
export type ActivationStage = {
  id: ActivationStageId
  label: string
  description: string
  state: 'ready' | 'disabled' | 'blocked'
  checks: ActivationCheck[]
}
export type BusinessActivationReadiness = {
  id: string
  name: string
  readyForPreview: boolean
  readyForProduction: boolean
  checks: ActivationCheck[]
}
export type ActivationReadiness = {
  evaluatedAt: number
  environment: string
  safeToEnablePreview: boolean
  safeToEnableProduction: boolean
  stages: ActivationStage[]
  businesses: BusinessActivationReadiness[]
}

export type ActivationReadinessInput = {
  now: number
  environment?: string
  configured: { githubApp: boolean; vercel: boolean; callbackSecret: boolean }
  flags: {
    automation: boolean
    githubActions: boolean
    previewAutomation: boolean
    approvalGate: boolean
    productionPromotion: boolean
    aiAdaptation: boolean
    automaticRollback: boolean
  }
  businesses: PlatformBusiness[]
  rollbackTargets?: Record<string, { currentDeploymentId?: string; targetDeploymentId?: string }>
}

const check = (id: string, label: string, ok: boolean, kind: ActivationCheckKind, pass: string, fail: string): ActivationCheck =>
  ({ id, label, ok, kind, detail: ok ? pass : fail })

function stage(id: ActivationStageId, label: string, description: string, checks: ActivationCheck[]): ActivationStage {
  const hardBlocked = checks.some((c) => !c.ok && c.kind !== 'flag')
  const flagOff = checks.some((c) => !c.ok && c.kind === 'flag')
  return { id, label, description, checks, state: hardBlocked ? 'blocked' : flagOff ? 'disabled' : 'ready' }
}

const PREVIEW_BUSINESS_CHECKS = [
  'configuration_ready', 'repo_allowlisted', 'github_installation', 'workflow_configured', 'preview_project',
] as const
const PRODUCTION_BUSINESS_CHECKS = [
  ...PREVIEW_BUSINESS_CHECKS,
  'production_project', 'default_branch', 'owner_approval', 'production_allowed', 'current_production', 'rollback_target',
] as const

/** Named membership is deliberately fail-closed: adding/reordering display checks cannot redefine readiness. */
function namedChecksPass(checks: ActivationCheck[], required: readonly string[]): boolean {
  return required.every((id) => checks.find((candidate) => candidate.id === id)?.ok === true)
}

export function evaluateActivationReadiness(input: ActivationReadinessInput): ActivationReadiness {
  const environment = (input.environment ?? 'unknown').trim().toLowerCase() || 'unknown'
  const trustedEnvironment = environment === 'preview' || environment === 'production'
  const eligibleBusinesses = input.businesses.filter((b) => b.status === 'active' && !isTestOnlyBusiness(b))

  const providerChecks = [
    check('trusted_environment', 'Trusted Vercel runtime', trustedEnvironment, 'configuration', `Running in ${environment}.`, 'Activation may only be evaluated in Preview or Production.'),
    check('github_app', 'GitHub App credentials', input.configured.githubApp, 'configuration', 'GitHub App ID and private key are configured.', 'GitHub App ID/private key are incomplete.'),
    check('vercel_access', 'Vercel provider credentials', input.configured.vercel, 'configuration', 'Vercel token and project context are configured.', 'Vercel token or project context is missing.'),
    check('callback_secret', 'Signed automation callback', input.configured.callbackSecret, 'configuration', 'Automation callback secret is configured.', 'Automation callback secret is missing.'),
  ]

  const businesses = eligibleBusinesses.map((b): BusinessActivationReadiness => {
    const repo = b.repoName || (b.repositoryOwner && b.repositoryNameOnly ? `${b.repositoryOwner}/${b.repositoryNameOnly}` : undefined)
    const project = b.productionProjectId || b.deployProject
    const rollback = input.rollbackTargets?.[b.id]
    const checks = [
      check('configuration_ready', 'Business configuration ready', b.configurationStatus === 'ready', 'business', 'Business configuration is marked ready.', 'Business configuration is not marked ready.'),
      check('repo_allowlisted', 'Repository allowlisted', isRepoAllowed(repo), 'business', repo ? `${repo} is allowlisted.` : 'Repository is not configured.', 'Repository is missing or outside the production allowlist.'),
      check('github_installation', 'GitHub installation mapped', !!b.githubInstallationId, 'business', 'GitHub installation is mapped.', 'GitHub installation ID is missing.'),
      check('workflow_configured', 'Automation workflow configured', !!b.automationWorkflowFile, 'business', 'Automation workflow is configured.', 'Automation workflow file is missing.'),
      check('preview_project', 'Preview project configured', !!b.previewProjectId && !!b.previewDeploymentProvider, 'business', 'Preview deployment target is configured.', 'Preview project/provider is incomplete.'),
      check('production_project', 'Production project allowlisted', isVercelProjectAllowed(project), 'business', project ? `${project} is allowlisted.` : 'Production project is not configured.', 'Production project is missing or outside the allowlist.'),
      check('default_branch', 'Default branch allowlisted', !!b.defaultBranch && (!b.allowedTargetBranches?.length || b.allowedTargetBranches.includes(b.defaultBranch)), 'business', `Default branch ${b.defaultBranch} is allowed.`, 'Default branch is missing or outside the target allowlist.'),
      check('owner_approval', 'Owner approval required', b.requireOwnerApproval === true && b.manualApprovalRequired === true, 'business', 'Owner approval is explicitly required.', 'Both owner-approval policy fields must be explicitly enabled.'),
      check('production_allowed', 'Production promotion permitted', b.allowProductionPromotion === true, 'business', 'Business permits controlled production promotion.', 'Business does not permit production promotion.'),
      check('current_production', 'Current production deployment known', !!rollback?.currentDeploymentId, 'rollback', 'Current production deployment is known.', 'Current production deployment could not be verified.'),
      check('rollback_target', 'Prior rollback target known', !!rollback?.targetDeploymentId, 'rollback', 'A distinct prior production deployment is available.', 'No prior known-good production deployment is available.'),
      check('rollback_workflow', 'Automatic rollback workflow configured', !!b.rollbackWorkflowFile, 'rollback', 'Rollback workflow is configured.', 'Rollback workflow file is missing; controlled manual rollback can still be used.'),
    ]
    const readyForPreview = namedChecksPass(checks, PREVIEW_BUSINESS_CHECKS)
    const readyForProduction = namedChecksPass(checks, PRODUCTION_BUSINESS_CHECKS)
    return { id: b.id, name: b.name, readyForPreview, readyForProduction, checks }
  })

  const hasBusiness = businesses.length > 0
  const allPreviewReady = hasBusiness && businesses.every((b) => b.readyForPreview)
  const allProductionReady = hasBusiness && businesses.every((b) => b.readyForProduction)

  const previewStage = stage('preview_automation', 'Preview automation', 'Prepare, deploy, and verify updates without changing Production.', [
    ...providerChecks,
    check('business_preview_ready', 'All active businesses preview-ready', allPreviewReady, 'business', 'Every active business has complete Preview configuration.', hasBusiness ? 'One or more active businesses have Preview blockers.' : 'No active production business is registered.'),
    check('automation_flag', 'Automation master enabled', input.flags.automation, 'flag', 'Automation master is enabled.', 'OPERION_AUTOMATION_ENABLED is off.'),
    check('github_flag', 'GitHub dispatch enabled', input.flags.githubActions, 'flag', 'GitHub Actions dispatch is enabled.', 'OPERION_GITHUB_ACTIONS_ENABLED is off.'),
    check('preview_flag', 'Preview automation enabled', input.flags.previewAutomation, 'flag', 'Preview automation is enabled.', 'OPERION_PREVIEW_AUTOMATION_ENABLED is off.'),
  ])

  const productionStage = stage('controlled_production', 'Controlled production', 'Owner-approved publish and typed-confirmation rollback.', [
    ...providerChecks,
    check('business_production_ready', 'All active businesses production-ready', allProductionReady, 'business', 'Every active business has a verified rollback path.', hasBusiness ? 'One or more active businesses have production blockers.' : 'No active production business is registered.'),
    check('approval_flag', 'Approval gate enabled', input.flags.approvalGate, 'flag', 'Owner approval gate is enabled.', 'OPERION_APPROVAL_GATE_ENABLED is off.'),
    check('promotion_flag', 'Production promotion enabled', input.flags.productionPromotion, 'flag', 'Controlled production promotion is enabled.', 'OPERION_PRODUCTION_PROMOTION_ENABLED is off.'),
  ])

  const advancedStage = stage('advanced_automation', 'Advanced automation', 'AI adaptation and automatic rollback after controlled canary evidence.', [
    ...productionStage.checks.filter((c) => c.kind !== 'flag'),
    check('ai_adaptation_flag', 'AI adaptation enabled', input.flags.aiAdaptation, 'flag', 'AI adaptation is enabled.', 'OPERION_AI_ADAPTATION_ENABLED is off.'),
    check('automatic_rollback_flag', 'Automatic rollback enabled', input.flags.automaticRollback, 'flag', 'Automatic rollback is enabled.', 'OPERION_AUTOMATIC_ROLLBACK_ENABLED is off.'),
    check('all_rollback_workflows', 'Rollback workflows configured', hasBusiness && businesses.every((b) => b.checks.find((c) => c.id === 'rollback_workflow')?.ok), 'rollback', 'Every active business has an automatic rollback workflow.', 'Automatic rollback remains blocked until every active business has a rollback workflow.'),
  ])

  const providerStage = stage('provider_access', 'Provider access', 'Read-only access required before any automation flag is enabled.', providerChecks)
  return {
    evaluatedAt: input.now,
    environment,
    safeToEnablePreview: providerStage.state === 'ready' && allPreviewReady,
    safeToEnableProduction: providerStage.state === 'ready' && allProductionReady,
    stages: [providerStage, previewStage, productionStage, advancedStage],
    businesses,
  }
}
