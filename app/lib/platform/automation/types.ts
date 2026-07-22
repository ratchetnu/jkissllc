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
  // Commit-transfer apply stats (counts only — never filesystem paths).
  filesApplied?: number
  filesSkipped?: number
  filesFailed?: number
  adaptationReport?: string      // short, safe summary from the AI-adaptation strategy
  warnings?: string[]
}

// ── Transfer evidence (§4 #7 — the audit-trail gap) ──────────────────────────
//
// The manifest builder decides a great deal and then throws all of it away:
// `targetBaseCommit`, the excluded paths, the paths whose drift was compared, the
// files whose imports were resolved, and the target modules whose exports were
// verified are computed server-side, returned to the CI runner, and never stored.
// The runner's own record is counts-only BY DESIGN ("counts only, no paths",
// operion-apply.mjs), and the signed callback reports `filesApplied: 41` with no
// list. So reconstructing the UPD-1004 manifest for issue #48 required sweeping
// every ref in J KISS history to find the one 41-file commit. This record is what
// makes the next incident readable instead of archaeological.
//
// PATHS, COUNTS AND STATUS ONLY. Never file contents, never hashes of contents,
// never a token or secret — the same discipline `describeClosureProblems` and the
// assignment audit ledger follow: say what and where, never what was inside.
//
// STORED UNDER ITS OWN KEY (`platform:autoev:<jobId>`), not on the job. Jobs are
// read in bulk on the preflight hot path (`activeJobForBusiness` → `listJobs(500)`
// loads whole records), so a bounded-but-large blob on the job record would be
// multiplied by 500 on every readiness check. The job carries only a timestamp
// marker; the evidence itself is fetched on demand.

export const TRANSFER_EVIDENCE_VERSION = 1
/** Per-array entry cap. UPD-1004 was 41 paths; closure's own module cap is 200. */
export const EVIDENCE_MAX_PATHS = 250
/** A path is already bounded to 400 chars upstream by `isSafeRepoPath`. */
export const EVIDENCE_MAX_REASON = 2000
/** Evidence outlives the incident review, not the repository. */
export const EVIDENCE_TTL_MS = 90 * 24 * 60 * 60_000

/** Which bounded lists were truncated, and by how many entries. Never silent. */
export type EvidenceTruncation = Partial<Record<
  'manifestPaths' | 'excludedPaths' | 'driftCheckedPaths' | 'closureCheckedPaths' | 'symbolCheckedPaths',
  number
>>

export type TransferEvidence = {
  evidenceVersion: number
  recordedAt: number
  jobId: string
  attempt: number                      // job.attemptCount at capture
  /** Did the builder produce a manifest, or refuse one? Both are worth keeping. */
  outcome: 'built' | 'refused'
  sourceCommit?: string
  /** The pinned target commit the manifest was built against (TOCTOU handshake). */
  targetBaseCommit?: string
  manifestEntryCount?: number
  manifestPaths?: string[]
  excludedPaths?: string[]
  driftCheckedPaths?: string[]
  closureCheckedPaths?: string[]
  symbolCheckedPaths?: string[]
  truncated?: EvidenceTruncation
  /** The refusal reason, verbatim and length-capped, when outcome is 'refused'. */
  failureReason?: string
}

export type UpdateAutomationJob = {
  jobVersion: number
  id: string                     // AUTO-{uuid}; globally unique across Preview/Production
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
  recordsFinalizedAt?: number    // when post-deploy reconciliation propagated this job to all related records (idempotency marker)
  /** When transfer evidence was last recorded for this job. A marker only — the
   *  evidence itself lives under `platform:autoev:<id>` so bulk job reads stay cheap.
   *  Absent on every record written before §4 #7 closed; readers must tolerate that. */
  transferEvidenceAt?: number
  // production promotion (Sprint 2)
  mergeCommit?: string
  rollbackTargetDeploymentId?: string   // the known-good production deployment captured before promoting
  rollbackAttemptCount?: number         // rollback retries are bounded independently from Preview retries
  rolledBackAt?: number
  // failure / rollback
  failureCategory?: AutomationFailure
  failureSummary?: string
  automaticRollbackEligible?: boolean   // computed at prepare from OPERION_AUTOMATIC_ROLLBACK_ENABLED + a verified rollback path
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
