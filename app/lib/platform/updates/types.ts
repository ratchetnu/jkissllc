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
export type BaselineSource = 'installed_by_release' | 'adopted' | 'unknown'

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
  /** Provenance for currentVersion. Absent legacy records are treated as unknown. */
  baselineSource?: BaselineSource
  baselineAdoptionId?: string
  currentCommit?: string
  latestVerifiedVersion?: string
  latestVerifiedCommit?: string    // commit of the last VERIFIED production deployment (set by reconciliation)
  /**
   * Provider deployment id (`dpl_…`) of the VERIFIED production deployment that
   * `currentVersion` and `currentCommit` describe. Immutable technical evidence for a
   * business-facing version number: the version is a claim, this is what backs it.
   * Written in the same patch as the version, so the two can never disagree.
   */
  currentDeploymentId?: string
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
  /**
   * True when the checkout that produced this record had uncommitted changes.
   *
   * Absent on every record written before this field existed, and absence is
   * deliberately NOT read as "clean": it is read as "this record has no opinion",
   * which is exactly what those records have. Only an explicit `true` refuses.
   */
  sourceWorktreeDirty?: boolean
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
  /**
   * How this update relates to OPTIONAL capabilities. Purely descriptive on the
   * deployment path: nothing in here may become a deployment prerequisite. See
   * UpdateCapabilityImpact.
   */
  capabilityImpact?: UpdateCapabilityImpact
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

// ── Capability impact of an update ───────────────────────────────────────────
//
// These four things were previously one undifferentiated blob, which is how "the
// target has no Stripe key" could read as "this update does not apply here":
//
//   1. WHICH capabilities the update touches          → descriptive, never a gate
//   2. WHAT CODE the target must already have         → a real transfer blocker
//   3. WHAT THE OWNER MUST DO to activate it          → never a deploy blocker
//   4. WHAT THE DEPLOYMENT needs (migration, env)     → already modelled above
//
// (2) and (4) can legitimately block. (1) and (3) never can. Installing code and
// activating a capability are separate events, and an update that lands dormant has
// still landed — which is what lets a security fix reach every target regardless of
// which optional integrations each of them runs.

/** One thing the owner must do before shipped behavior becomes live. */
export type UpdateActivationRequirement = {
  /** Capability id from the platform capability registry. */
  capability: string
  kind: 'tenant_enable' | 'provider_credential' | 'feature_flag'
  /**
   * A variable or flag NAME — never a value. Anything that looks like a secret is
   * rejected by the evidence validator rather than stored.
   */
  reference?: string
  detail: string
}

export type UpdateCapabilityImpact = {
  /** Capabilities this update touches. Descriptive only. */
  affects?: string[]
  /**
   * Capabilities whose CODE must already exist on the target for the transfer to
   * compile. This is the same class of fact as `requiredModules` — a runtime/transfer
   * dependency — and it MAY block. It is emphatically not a tenant preference.
   */
  requiresCapabilityCode?: string[]
  /** What must happen for the shipped code to do anything. NEVER blocks a deploy. */
  activationRequirements?: UpdateActivationRequirement[]
  /**
   * True when the update touches ONLY optional-capability code, so a target with all
   * of them switched off gains no behavior. Even then it still installs: the code is
   * present and dormant, and flipping the capability on later needs no redeployment.
   */
  optionalOnly?: boolean
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
  /** Stable product-safe identity. Legacy records omit this and remain keyed by version. */
  id?: string
  /** Approved authored package that produced this rollout record. */
  packageId?: string
  /** Single managed product this rollout belongs to. */
  targetProduct?: string
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

// ── Authored release packages ────────────────────────────────────────────────
// A package is the reviewed proposal that precedes the legacy PlatformRelease
// rollout record. Drafts may be incomplete; only the server-side readiness
// transition may mark one ready_for_approval.
export type ReleasePackageStatus =
  | 'draft' | 'blocked' | 'ready_for_approval' | 'approved' | 'cancelled' | 'superseded'

export type ReleasePackagePolicySnapshot = {
  previousVersion: string
  baselineSource: BaselineSource
  businessUpdatedAt: number
  versionReason: string
  duplicateReason: string
  evaluatedAt: number
}

export type ReleasePackage = {
  recordVersion: 1
  id: string
  targetProduct: string
  proposedVersion: string
  channel: Exclude<ReleaseChannel, 'custom'>
  classification: import('../release/semver-policy').ChangeClassification
  breakingChange: boolean
  migration: import('../release/semver-policy').MigrationClassification
  updateKeys: string[]
  name?: string
  releaseNotes?: string
  status: ReleasePackageStatus
  blockingReasons: string[]
  policySnapshot?: ReleasePackagePolicySnapshot
  createdBy: string
  createdAt: number
  updatedAt: number
  readyBy?: string
  readyAt?: number
  approvalSnapshot?: ReleasePackagePolicySnapshot
  approvedBy?: string
  approvedAt?: number
  /** Internal rollout record created from this approved package. No deployment is implied. */
  rolloutId?: string
  rolloutCreatedAt?: number
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
  /**
   * What the TARGET said about itself after Preview verification: the build it is
   * running and which optional capabilities are live there. Absent on every record
   * that predates this field, and on any target that did not report — no caller may
   * assume it is present.
   */
  targetEvidence?: TargetDeploymentEvidence
  createdAt: number
  updatedAt: number
  verifiedAt?: number
}

// ── Value-free evidence returned BY the target ──────────────────────────────
//
// After Preview verification the managed target reports what it is actually
// running and which optional channels are live there. Operion stores this as
// deployment evidence so a review screen can say "installed, dormant, needs
// STRIPE_SECRET_KEY" instead of guessing.
//
// STRICTLY VALUE-FREE. Booleans, state CODES, and variable NAMES only. The target's
// environment values never cross the boundary, and the validator refuses a payload
// that looks like it is carrying one — Operion and Supercharged share code and share
// no secrets, and this is the one channel where that could silently stop being true.
export type TargetCapabilityEvidence = {
  /** Capability id. */
  capability: string
  /** A stable capability state code (capability_ready, capability_disabled, …). */
  state: string
  enabled: boolean
  /** null when the capability fronts no external provider. */
  configured: boolean | null
  /** Variable NAMES still needed. Never values. */
  missingVars?: string[]
}

export type TargetDeploymentEvidence = {
  /** The commit the target reports it is running. */
  commit?: string
  /** The target's own build identifier (e.g. a Vercel deployment id). */
  buildId?: string
  /** The target's application version, when it publishes one. */
  version?: string
  /** Schema version of the target's capability profile record. */
  capabilityProfileVersion?: number
  capabilities: TargetCapabilityEvidence[]
  /** The target's clock. Advisory — never used to decide freshness. */
  reportedAt?: number
  /** OUR clock, when the signed callback was accepted. Authoritative. */
  recordedAt: number
  /** How the report was authenticated. Signed callbacks are the only accepted path. */
  authentication: 'hmac-sha256'
}

// ── Evidence-based baseline adoption ────────────────────────────────────────
export type BaselineSchemaEvidence = {
  state: 'verified' | 'not_applicable' | 'unknown'
  schemaVersion?: string
  lastMigrationId?: string
  evidence?: string
}
export type BaselineFlagEvidence = {
  assessed: boolean
  flags: Record<string, boolean>
}
export type BaselineVerificationEvidence = {
  kind: 'production_deployment' | 'health_check' | 'smoke_test' | 'owner_attestation'
  reference: string
  verifiedAt?: number
}
export type BaselineCapabilityEvidence = { id: string; evidence: string }
export type BaselineAdoptionInput = {
  targetProduct: string
  proposedVersion: string
  deployedCommit: string
  capabilityManifestHash: string
  capabilities: BaselineCapabilityEvidence[]
  schemaMigrationState: BaselineSchemaEvidence
  relevantFlagState: BaselineFlagEvidence
  verificationEvidence: BaselineVerificationEvidence[]
}
export type BaselineRollbackSnapshot = {
  currentVersion?: string
  baselineSource: BaselineSource
  baselineAdoptionId?: string
  currentCommit?: string
  latestVerifiedVersion?: string
  latestVerifiedCommit?: string
  businessUpdatedAt: number
}
export type BaselineAdoptionVerdict = 'safe_to_adopt' | 'needs_review' | 'insufficient_evidence'
/** How the deployed commit was proven. A mapped provider is authoritative and required;
 *  the stored record is used only when the business has no provider mapping. */
export type BaselineCommitVerification = {
  source: 'live_production' | 'recorded_baseline' | 'live_production_unavailable'
  /** The commit the provider reports live Production is serving (when readable). */
  liveCommit?: string
  liveDeploymentId?: string
}
export type BaselineAdoptionDryRun = {
  targetProduct: string
  proposedVersion?: string
  deployedCommit?: string
  capabilityManifestHash?: string
  matchedCapabilities: BaselineCapabilityEvidence[]
  schemaMigrationState: BaselineSchemaEvidence
  relevantFlagState: BaselineFlagEvidence
  verificationEvidence: BaselineVerificationEvidence[]
  missingEvidence: string[]
  conflicts: string[]
  recordsThatWouldChange: string[]
  rollbackSnapshot: BaselineRollbackSnapshot
  baselineSource: 'adopted'
  commitVerification: BaselineCommitVerification
  verdict: BaselineAdoptionVerdict
  evidenceHash: string
  approvalToken?: string
}
export type BaselineOwnerApproval = {
  approvedBy: string
  approvedAt: number
  evidenceHash: string
  confirmationPhrase: string
}
export type BaselineAdoptionRecord = BaselineAdoptionInput & {
  recordVersion: 1
  id: string
  proposedVersion: string
  capabilityManifestHash: string
  baselineSource: 'adopted'
  adoptedBy: string
  adoptedAt: number
  ownerApproval: BaselineOwnerApproval
  rollbackSnapshot: BaselineRollbackSnapshot
  commitVerification: BaselineCommitVerification
}

// Statuses that count an update as still "pending" (owner must not forget it).
export const PENDING_STATUSES: UpdateStatus[] = [
  'discovered', 'planned', 'queued', 'in_progress', 'implemented', 'testing',
  'blocked', 'ready_for_review', 'approved', 'ready_to_release', 'included_in_release',
  'partially_deployed',
]
export const TERMINAL_STATUSES: UpdateStatus[] = ['fully_deployed', 'cancelled', 'archived']
