// ── Operion automation — job contract (controlled release orchestration) ─────
//
// A dedicated record + status space, SEPARATE from the generic DeploymentRecord. The
// job walks a fixed pipeline (preflight → branch → apply → tests → build → preview →
// owner review → production → verify), with an explicit owner-approval gate before any
// production promotion. There is NO fully-autonomous production mode.
//
// Everything here is types; the state machine (machine.ts) reasons over them and the
// store (store.ts) persists them under the `platform:autojob:*` key family.

export const AUTOMATION_JOB_VERSION = 1

// Statuses are automation-specific (never reuse DeploymentStatus for these).
export type AutomationStatus =
  | 'draft' | 'validating' | 'blocked' | 'queued'
  | 'creating_branch' | 'applying_update' | 'testing' | 'build_failed'
  | 'preview_deploying' | 'preview_ready' | 'awaiting_owner_review'
  | 'approved_for_production' | 'merging' | 'production_deploying' | 'verifying'
  | 'completed' | 'failed' | 'cancelled'
  | 'rollback_required' | 'rolling_back' | 'rolled_back'

// The visible stepper groups (UI). Maps many statuses onto a few steps.
export type AutomationStep =
  | 'preflight' | 'branch' | 'implementation' | 'tests' | 'build'
  | 'preview' | 'owner_review' | 'production' | 'verification'

export type ExecutionStrategy = 'commit_transfer' | 'file_manifest' | 'ai_adaptation'

export type AutomationFailure =
  | 'preflight_failed' | 'branch_failed' | 'apply_failed' | 'tests_failed' | 'build_failed'
  | 'preview_failed' | 'merge_conflict' | 'commit_drift' | 'promotion_failed'
  | 'health_failed' | 'smoke_failed' | 'provider_error' | 'timeout' | 'cancelled' | 'internal_error'

/** Machine-readable result reported by the CI workflow via the signed callback. */
export type WorkflowResult = {
  testsPassed?: boolean
  testTotal?: number
  testFailed?: number
  buildPassed?: boolean
  lintPassed?: boolean
  changedFiles?: number
  adaptationReport?: string      // short, safe summary from the AI-adaptation strategy
  warnings?: string[]
}

export type UpdateAutomationJob = {
  jobVersion: number
  id: string                     // AUTO-{n}
  deploymentRequestId?: string
  releaseTargetId?: string
  updateId: string               // PlatformUpdate.key
  businessId: string
  mode: string                   // the AutomationMode at creation time
  strategy: ExecutionStrategy
  status: AutomationStatus
  // repo/branch/commit provenance (all from the registered business record — never user input)
  sourceRepository?: string
  sourceCommit?: string
  targetRepository?: string
  baseBranch?: string
  workBranch?: string
  pullRequestNumber?: number
  pullRequestUrl?: string
  targetCommit?: string
  approvedCommit?: string        // the PR head the owner approved (for commit-drift lock)
  workflowRunId?: string
  workflowRunUrl?: string
  previewDeploymentId?: string
  previewUrl?: string
  productionDeploymentId?: string
  productionUrl?: string
  result?: WorkflowResult
  // lifecycle
  attemptCount: number
  currentStep: AutomationStep
  queuedAt?: number
  startedAt?: number
  heartbeatAt?: number
  completedAt?: number
  approvedAt?: number
  approvedBy?: string
  // failure / rollback
  failureCategory?: AutomationFailure
  failureSummary?: string
  rollbackJobId?: string
  traceId?: string
  idempotencyKey: string
  createdBy?: string
  createdAt: number
  updatedAt: number
}

export const AUTOMATION_ACTIVE: AutomationStatus[] = [
  'validating', 'queued', 'creating_branch', 'applying_update', 'testing',
  'preview_deploying', 'preview_ready', 'awaiting_owner_review',
  'approved_for_production', 'merging', 'production_deploying', 'verifying', 'rolling_back',
]
export const AUTOMATION_TERMINAL: AutomationStatus[] = ['completed', 'failed', 'cancelled', 'rolled_back']
