// ── Operion Update Center — record contract (Phase 1 MVP) ────────────────────
//
// Operion's system-of-record for updates/releases across the businesses the owner
// runs (J KISS + Supercharged). Storage is Redis (platform:* key family, global /
// never tenant-scoped) — NO SQL, NO migrations. These are the shapes; the store
// (store.ts) persists them and the policy (policy.ts) reasons over them.
//
// NAMING: "PlatformBusiness" = a business the OWNER runs (a deployable app), NOT the
// J KISS moving CLIENTS in app/lib/businesses.ts. Keep the two concepts separate.

export const PLATFORM_UPDATE_VERSION = 1

// ── Businesses the owner runs ────────────────────────────────────────────────
export type ReleaseChannel = 'internal' | 'alpha' | 'beta' | 'stable' | 'lts' | 'custom'
export type UpdatePolicy = 'manual' | 'owner_approval' | 'scheduled_manual' | 'security_only' | 'pinned' | 'paused'
export type BusinessStatus = 'active' | 'onboarding' | 'paused' | 'archived'
export type BusinessRole = 'source' | 'target' | 'source_and_target'
export type HealthStatus = 'unknown' | 'healthy' | 'degraded' | 'down'

// Controlled automation modes (no unrestricted autonomous production mode exists).
export type AutomationMode =
  | 'manual_prompt'            // current behavior — generate a prompt, owner runs it
  | 'automated_preparation'    // branch + apply + tests; production needs owner approval
  | 'automated_preview'        // + preview deploy/verify automatically; production manual
  | 'approved_production'      // owner explicitly approves a verified preview → merge+deploy
  | 'fully_manual'             // Operion only records external work
export type ConfigurationStatus = 'not_configured' | 'incomplete' | 'validating' | 'ready' | 'error'

export type PlatformBusiness = {
  recordVersion: number
  id: string                       // slug, e.g. 'jkiss' | 'supercharged'
  name: string
  slug: string
  industry?: string
  edition?: string
  status: BusinessStatus
  role: BusinessRole               // is this the source platform, a target, or both
  repoProvider?: string            // 'github'
  repoName?: string                // 'ratchetnu/jkissllc'
  repoId?: string
  defaultBranch: string            // 'main'
  deployProvider?: string          // 'vercel'
  deployProject?: string
  productionUrl?: string
  healthEndpoint?: string
  currentVersion?: string
  currentCommit?: string
  latestVerifiedVersion?: string
  latestVerifiedCommit?: string    // commit of the last VERIFIED production deployment (set by reconciliation)
  releaseChannel: ReleaseChannel
  updatePolicy: UpdatePolicy
  updatesPaused: boolean
  manualApprovalRequired: boolean
  autoDeployAllowed: boolean       // MVP: always false; the record exists, the automation doesn't
  healthStatus: HealthStatus
  lastDeploymentAt?: number
  lastVerificationAt?: number
  enabledModules?: string[]
  notes?: string
  // ── Controlled automation config (Phase 5) — NON-SECRET only. The GitHub App private
  // key + Vercel token live in env; here we store the installation id + allowlists +
  // gate booleans. Nothing here lets the browser choose a repo/branch/workflow at run time.
  automationMode?: AutomationMode              // default manual_prompt
  githubInstallationId?: string                // GitHub App installation (non-secret)
  repositoryOwner?: string                     // e.g. 'ratchetnu'
  repositoryNameOnly?: string                  // e.g. 'supercharged' (repoName kept for display)
  allowedSourceBranches?: string[]             // allowlist
  allowedTargetBranches?: string[]             // allowlist (work branches are derived, prefix-checked)
  automationWorkflowFile?: string              // e.g. 'operion-update.yml' (server-configured, not user input)
  rollbackWorkflowFile?: string                 // legacy metadata; rollback executes server-side through the Vercel provider
  previewDeploymentProvider?: string           // 'vercel'
  previewProjectId?: string
  previewRepoId?: string                       // numeric GitHub repo id for Vercel git preview
  productionProjectId?: string
  requirePullRequest?: boolean
  requireOwnerApproval?: boolean               // default true
  requirePreview?: boolean                     // default true
  requirePassingChecks?: boolean               // default true
  allowAutomatedMerge?: boolean                // default false
  allowProductionPromotion?: boolean           // default false
  configurationStatus?: ConfigurationStatus    // default not_configured
  createdAt: number
  updatedAt: number
}

// ── Updates ──────────────────────────────────────────────────────────────────
export type UpdateType =
  | 'feature' | 'enhancement' | 'bug_fix' | 'security' | 'performance' | 'accessibility'
  | 'design' | 'infrastructure' | 'migration' | 'configuration' | 'documentation'
  | 'deprecation' | 'emergency_hotfix'

export type UpdateScope =
  | 'platform_core' | 'shared_module' | 'industry_specific' | 'edition_specific'
  | 'business_specific' | 'repository_specific' | 'environment_specific'

export type UpdateSeverity = 'low' | 'medium' | 'high' | 'critical'
export type UpdatePriority = 'low' | 'normal' | 'high' | 'urgent'

export type UpdateStatus =
  | 'discovered' | 'planned' | 'queued' | 'in_progress' | 'implemented' | 'testing'
  | 'blocked' | 'ready_for_review' | 'approved' | 'ready_to_release' | 'included_in_release'
  | 'partially_deployed' | 'fully_deployed' | 'failed' | 'rolled_back' | 'cancelled' | 'archived'

/** Per-gate validation state — the evidence checklist. */
export type CheckStatus = 'unknown' | 'passed' | 'failed' | 'skipped' | 'not_applicable'
export type ValidationChecklist = {
  typecheck: CheckStatus
  lint: CheckStatus
  tests: CheckStatus
  build: CheckStatus
  securityReview: CheckStatus
  accessibilityReview: CheckStatus
  e2e: CheckStatus
  smokeTest: CheckStatus
  ownerVerification: CheckStatus
}

export type PlatformUpdate = {
  recordVersion: number
  key: string                      // stable id, e.g. 'UPD-1001'
  title: string
  summary: string
  description?: string
  customerImpact?: string
  technicalImpact?: string
  type: UpdateType
  scope: UpdateScope
  severity: UpdateSeverity
  priority: UpdatePriority
  status: UpdateStatus
  module?: string
  // Source provenance
  sourceBusinessId?: string
  sourceRepo?: string
  sourceBranch?: string
  sourceCommit?: string
  sourceDeploymentId?: string
  pullRequest?: string
  // Technical requirements
  breakingChange: boolean
  migrationRequired: boolean
  environmentChangeRequired: boolean
  secretRequired: boolean
  featureFlagRequired: boolean
  manualPortRequired: boolean
  rollbackSupported: boolean
  requiredModules?: string[]
  dependencies?: string[]
  // Evidence + narrative
  validation: ValidationChecklist
  risks?: string
  limitations?: string
  exclusions?: string
  ownerNotes?: string
  // Attribution + aging
  createdBy?: string
  approvedBy?: string
  createdAt: number
  updatedAt: number
  approvedAt?: number
}

// ── Compatibility (per update × business) ────────────────────────────────────
export type CompatStatus =
  | 'unknown' | 'under_review' | 'compatible' | 'compatible_with_changes'
  | 'already_present' | 'not_applicable' | 'incompatible' | 'blocked'

export type UpdateCompatibility = {
  recordVersion: number
  updateKey: string
  businessId: string
  status: CompatStatus
  reason?: string
  manualPortRequired?: boolean
  codeReconciliationRequired?: boolean
  migrationRequired?: boolean
  configurationRequired?: boolean
  secretRequired?: boolean
  featureFlagRequired?: boolean
  brandingChangesRequired?: boolean
  dataModelChangesRequired?: boolean
  requiredModules?: string[]
  missingModules?: string[]
  /** Human-readable component names used by deployment guidance. Not machine-enforced paths. */
  componentsToExclude?: string[]
  /** Exact repository-relative paths omitted from deterministic commit transfers. */
  pathsToExclude?: string[]
  blockingIssues?: string
  assessedBy?: string
  overrideReason?: string
  createdAt: number
  updatedAt: number
}

// ── Releases (minimal in MVP) ────────────────────────────────────────────────
export type ReleaseStatus =
  | 'draft' | 'assembling' | 'validating' | 'blocked' | 'ready_for_approval' | 'approved'
  | 'scheduled' | 'rolling_out' | 'partially_completed' | 'completed' | 'failed' | 'rolled_back'
  | 'cancelled' | 'archived'

export type PlatformRelease = {
  recordVersion: number
  version: string                  // 'v1.4.0'
  name?: string
  description?: string
  releaseNotes?: string
  channel: ReleaseChannel
  status: ReleaseStatus
  updateKeys: string[]
  targetBusinessIds: string[]
  createdBy?: string
  approvedBy?: string
  createdAt: number
  updatedAt: number
  approvedAt?: number
}

// ── Deployment records ───────────────────────────────────────────────────────
export type DeploymentStatus = 'requested' | 'in_progress' | 'deployed' | 'failed' | 'rolled_back' | 'cancelled'
export type VerificationStatus = 'pending' | 'passed' | 'failed' | 'waived'

export type DeploymentRecord = {
  recordVersion: number
  id: string
  businessId: string
  updateKeys: string[]
  releaseVersion?: string
  repo?: string
  branch?: string
  sourceCommit?: string
  targetCommit?: string
  provider?: string
  deploymentId?: string            // Vercel deployment id
  deploymentUrl?: string
  automationJobId?: string         // the UpdateAutomationJob that produced this deployment (idempotency key for reconciliation)
  environment?: string
  status: DeploymentStatus
  buildStatus?: CheckStatus
  healthCheckStatus?: CheckStatus
  smokeTestStatus?: CheckStatus
  verificationStatus: VerificationStatus
  verificationWaivedReason?: string
  rollbackAvailable: boolean
  previousCommit?: string
  errorCategory?: string
  errorSummary?: string
  notes?: string
  initiatedBy?: string
  verifiedBy?: string
  createdAt: number
  updatedAt: number
  verifiedAt?: number
}

// Statuses that count an update as still "pending" (owner must not forget it).
export const PENDING_STATUSES: UpdateStatus[] = [
  'discovered', 'planned', 'queued', 'in_progress', 'implemented', 'testing',
  'blocked', 'ready_for_review', 'approved', 'ready_to_release', 'included_in_release',
  'partially_deployed',
]
export const TERMINAL_STATUSES: UpdateStatus[] = ['fully_deployed', 'cancelled', 'archived']
