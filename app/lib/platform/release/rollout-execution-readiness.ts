import type { UpdateAutomationJob } from '../automation/types'
import type { PlatformRelease, ReleasePackage } from '../updates/types'

export type RolloutExecutionBlockerCode =
  | 'PACKAGE_NOT_APPROVED'
  | 'PACKAGE_POLICY_STALE'
  | 'ROLLOUT_MISSING'
  | 'ROLLOUT_IDENTITY_MISMATCH'
  | 'ROLLOUT_NOT_APPROVED'
  | 'UPDATE_CANDIDATE_MISSING'
  | 'CANDIDATE_AMBIGUOUS'
  | 'CANDIDATE_ARTIFACT_MISMATCH'

export type RolloutExecutionBlocker = {
  code: RolloutExecutionBlockerCode
  message: string
  updateKey?: string
}

export type RolloutExecutionCandidate = {
  targetProduct: string
  targetCommit: string
  sourceDeploymentId: string
  jobIds: string[]
  updateKeys: string[]
}

export type RolloutExecutionReadiness =
  | { ready: true; blockers: []; candidate: RolloutExecutionCandidate }
  | { ready: false; blockers: RolloutExecutionBlocker[] }

export type RolloutExecutionHandoff =
  | {
      ready: true
      blocker: null
      businessId: string
      jobId: string
      releaseId: string
      sourceDeploymentId: string
    }
  | {
      ready: false
      blocker: {
        code: 'EXECUTION_NOT_READY' | 'PUBLISH_CONTEXT_MISSING' | 'PUBLISH_CONTEXT_MISMATCH'
        message: string
      }
    }

export type CandidateJob = Pick<
  UpdateAutomationJob,
  'id' | 'businessId' | 'updateId' | 'status' | 'targetCommit' | 'previewDeploymentId' | 'updatedAt'
>

const sameSet = (left: string[], right: string[]): boolean => {
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
}

/**
 * Read-only bridge between an approved rollout plan and the existing verified
 * Preview-job lane. It proves identity and artifact agreement; it never writes,
 * approves, publishes, deploys, or calls a provider.
 */
export function evaluateRolloutExecutionReadiness(input: {
  packageRecord: ReleasePackage
  rollout: PlatformRelease | null
  packagePolicyBlockers: string[]
  jobs: CandidateJob[]
}): RolloutExecutionReadiness {
  const blockers: RolloutExecutionBlocker[] = []
  const pkg = input.packageRecord
  const rollout = input.rollout

  if (pkg.status !== 'approved') {
    blockers.push({ code: 'PACKAGE_NOT_APPROVED', message: 'The release package is not approved.' })
  }
  if (input.packagePolicyBlockers.length > 0) {
    blockers.push({ code: 'PACKAGE_POLICY_STALE', message: 'The package no longer passes its release policy.' })
  }
  if (!rollout) {
    blockers.push({ code: 'ROLLOUT_MISSING', message: 'Create the rollout plan before checking execution readiness.' })
  } else {
    const identityMatches =
      rollout.id === pkg.rolloutId &&
      rollout.packageId === pkg.id &&
      rollout.targetProduct === pkg.targetProduct &&
      rollout.version === pkg.proposedVersion &&
      sameSet(rollout.updateKeys, pkg.updateKeys) &&
      sameSet(rollout.targetBusinessIds, [pkg.targetProduct])
    if (!identityMatches) {
      blockers.push({ code: 'ROLLOUT_IDENTITY_MISMATCH', message: 'The rollout plan no longer matches the approved package.' })
    }
    if (rollout.status !== 'approved') {
      blockers.push({ code: 'ROLLOUT_NOT_APPROVED', message: `The rollout is ${rollout.status}, not approved.` })
    }
  }

  const selected: CandidateJob[] = []
  if (pkg.updateKeys.length === 0) {
    blockers.push({
      code: 'UPDATE_CANDIDATE_MISSING',
      message: 'The approved package contains no updates to verify.',
    })
  }
  for (const updateKey of pkg.updateKeys) {
    const qualified = input.jobs.filter((job) =>
        job.businessId === pkg.targetProduct &&
        job.updateId === updateKey &&
        job.status === 'awaiting_owner_review' &&
        !!job.targetCommit &&
        !!job.previewDeploymentId,
      )
    if (qualified.length === 0) {
      blockers.push({
        code: 'UPDATE_CANDIDATE_MISSING',
        updateKey,
        message: `${updateKey} has no verified Preview candidate for this customer.`,
      })
      continue
    }

    const newestAt = Math.max(...qualified.map((job) => job.updatedAt))
    const newest = qualified.filter((job) => job.updatedAt === newestAt)
    const newestArtifacts = new Set(newest.map((job) => `${job.targetCommit}\n${job.previewDeploymentId}`))
    if (newestArtifacts.size > 1) {
      blockers.push({
        code: 'CANDIDATE_AMBIGUOUS',
        updateKey,
        message: `${updateKey} has equally recent Preview candidates for different artifacts.`,
      })
      continue
    }

    selected.push([...newest].sort((left, right) => left.id.localeCompare(right.id))[0])
  }

  const artifactKeys = new Set(selected.map((job) => `${job.targetCommit}\n${job.previewDeploymentId}`))
  if (selected.length === pkg.updateKeys.length && artifactKeys.size > 1) {
    blockers.push({
      code: 'CANDIDATE_ARTIFACT_MISMATCH',
      message: 'The included updates do not point to one shared commit and Preview deployment.',
    })
  }

  if (blockers.length > 0) return { ready: false, blockers }
  const first = selected[0]
  return {
    ready: true,
    blockers: [],
    candidate: {
      targetProduct: pkg.targetProduct,
      targetCommit: first.targetCommit!,
      sourceDeploymentId: first.previewDeploymentId!,
      jobIds: selected.map((job) => job.id),
      updateKeys: [...pkg.updateKeys],
    },
  }
}

/**
 * Connects package evidence to the existing controlled publish workflow without
 * creating a second executor. The publish workflow selects one active job for a
 * customer; this handoff opens only when that exact job is one of the package's
 * verified candidates and still points at the same Preview artifact.
 */
export function evaluateRolloutExecutionHandoff(input: {
  readiness: RolloutExecutionReadiness
  publishContextJob: CandidateJob | null
}): RolloutExecutionHandoff {
  if (!input.readiness.ready) {
    return {
      ready: false,
      blocker: {
        code: 'EXECUTION_NOT_READY',
        message: 'Resolve the execution-readiness blockers before opening controlled publish.',
      },
    }
  }

  const candidate = input.readiness.candidate
  const job = input.publishContextJob
  if (!job) {
    return {
      ready: false,
      blocker: {
        code: 'PUBLISH_CONTEXT_MISSING',
        message: 'No current verified job is available for this customer’s controlled publish workflow.',
      },
    }
  }

  const exactMatch =
    job.businessId === candidate.targetProduct &&
    candidate.jobIds.includes(job.id) &&
    job.status === 'awaiting_owner_review' &&
    job.targetCommit === candidate.targetCommit &&
    job.previewDeploymentId === candidate.sourceDeploymentId

  if (!exactMatch) {
    return {
      ready: false,
      blocker: {
        code: 'PUBLISH_CONTEXT_MISMATCH',
        message: 'Another job currently owns this customer’s publish workflow. Resolve it before continuing.',
      },
    }
  }

  return {
    ready: true,
    blocker: null,
    businessId: candidate.targetProduct,
    jobId: job.id,
    releaseId: candidate.targetCommit,
    sourceDeploymentId: candidate.sourceDeploymentId,
  }
}
