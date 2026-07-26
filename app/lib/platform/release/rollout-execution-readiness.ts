import type { UpdateAutomationJob } from '../automation/types'
import type { PlatformRelease, ReleasePackage } from '../updates/types'

export type RolloutExecutionBlockerCode =
  | 'PACKAGE_NOT_APPROVED'
  | 'PACKAGE_POLICY_STALE'
  | 'ROLLOUT_MISSING'
  | 'ROLLOUT_IDENTITY_MISMATCH'
  | 'ROLLOUT_NOT_APPROVED'
  | 'UPDATE_CANDIDATE_MISSING'
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

type CandidateJob = Pick<
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
    const candidate = input.jobs
      .filter((job) =>
        job.businessId === pkg.targetProduct &&
        job.updateId === updateKey &&
        job.status === 'awaiting_owner_review' &&
        !!job.targetCommit &&
        !!job.previewDeploymentId,
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)[0]
    if (!candidate) {
      blockers.push({
        code: 'UPDATE_CANDIDATE_MISSING',
        updateKey,
        message: `${updateKey} has no verified Preview candidate for this customer.`,
      })
    } else {
      selected.push(candidate)
    }
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
