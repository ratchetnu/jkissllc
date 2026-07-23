// ── Operion rehearsal — offline dry-run of one Preview transfer ──────────────
//
// Drives the REAL production modules — `buildCommitTransferManifest` and
// `buildTransferEvidence` — against a read-only local-git provider, so the outcome of a
// transfer (gate verdicts, the manifest, the audit evidence PR #56 would persist) can be
// confirmed WITHOUT enabling a flag, dispatching a workflow, or writing to any repo.
//
// It imports the transfer runtime; it does not modify it. Every mutating provider method
// throws (see local-git-provider), so a rehearsal is structurally incapable of a write.

import {
  buildCommitTransferManifest, type BuiltManifest,
} from '../../app/lib/platform/automation/manifest-builder'
import { buildTransferEvidence } from '../../app/lib/platform/automation/evidence'
import type { TransferEvidence } from '../../app/lib/platform/automation/types'
import { makeLocalGitProvider, type RehearsalProvider, type ProviderCall } from './local-git-provider'
import { execFileSync } from 'node:child_process'

export type RehearsalInput = {
  sourceRepoPath: string
  targetRepoPath: string
  targetRef: string
  sourceRepoName: string       // "owner/name" recorded in the manifest
  sourceCommit: string         // may be short; resolved to full below
  updateKey: string
  /** The business id the target provider answers as (drives source/target routing). */
  targetBusinessId: string
  targetRepoOwner: string
  targetRepoName: string
  pathsToExclude?: string[]
  /** Fixed timestamp so a rehearsal is deterministic. */
  now?: number
}

export type RehearsalResult =
  | {
      ok: true
      sourceCommit: string
      targetBaseCommit: string
      manifest: BuiltManifest
      evidence: TransferEvidence
      /** What the CI runner WOULD receive — never sent. */
      runnerPayloadKeys: string[]
      providerReads: number
      providerCalls: ProviderCall[]
      mutatingCallsAttempted: 0
    }
  | { ok: false; reason: string; providerCalls: ProviderCall[]; mutatingCallsAttempted: 0 }

const gitStr = (repo: string, args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 29 }).trim()

/**
 * Rehearse one transfer. Pure w.r.t. the outside world: it only READS the two clones.
 * Returns the manifest, the evidence PR #56 would store, and the provider call log so a
 * caller can assert that no write was attempted and no file was read twice.
 */
export async function rehearseTransfer(input: RehearsalInput): Promise<RehearsalResult> {
  const provider: RehearsalProvider = makeLocalGitProvider({
    sourceRepoPath: input.sourceRepoPath,
    targetRepoPath: input.targetRepoPath,
    targetRef: input.targetRef,
  })
  const sourceCommit = gitStr(input.sourceRepoPath, ['rev-parse', input.sourceCommit])

  const built = await buildCommitTransferManifest({
    provider: provider as never,
    installationId: 'operion-rehearsal',
    sourceRepo: { owner: input.sourceRepoName.split('/')[0], name: input.sourceRepoName.split('/')[1] },
    sourceRepoName: input.sourceRepoName,
    sourceCommit,
    targetRepo: { owner: input.targetRepoOwner, name: input.targetRepoName },
    targetBranch: 'main',
    updateKey: input.updateKey,
    compatibility: { status: 'compatible', pathsToExclude: input.pathsToExclude ?? [] },
  })

  if (!built.ok) {
    return { ok: false, reason: built.error, providerCalls: provider.calls, mutatingCallsAttempted: 0 }
  }

  const evidence = buildTransferEvidence(built.data, {
    jobId: `AUTO-rehearsal-${input.updateKey}`,
    attempt: 0,
    sourceCommit,
    now: input.now ?? 1_700_000_000_000,
  })

  return {
    ok: true,
    sourceCommit,
    targetBaseCommit: built.data.targetBaseCommit,
    manifest: built.data,
    evidence,
    runnerPayloadKeys: Object.keys({ jobId: 'x', ...built.data }).sort(),
    providerReads: provider.reads,
    providerCalls: provider.calls,
    mutatingCallsAttempted: 0,
  }
}
