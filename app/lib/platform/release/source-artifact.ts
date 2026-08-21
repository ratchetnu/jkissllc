// ── The source artifact a release is built FROM (PURE) ───────────────────────
//
// An update reaches a managed target as a set of files resolved from a specific
// commit in the source repository. This module is the single place that decides
// whether the thing an operator is about to ship is a REAL, REPRODUCIBLE artifact —
// and refuses everything else.
//
// ── Why a working tree is not an artifact ────────────────────────────────────
//
// `vercel --prod` from a checkout ships whatever is on disk, including uncommitted
// edits, a half-finished rebase, and any file a tool happened to leave behind. The
// deployment that results cannot be reproduced, cannot be diffed against anything,
// and cannot be rolled back to a known point — there is no known point. The repo's
// own AGENTS.md warns about exactly this.
//
// So the guided workflow never accepts a ref that could mean "whatever is on disk
// right now". A commit SHA is the only accepted answer, because it is the only one
// that still means the same thing tomorrow.
//
// This is deliberately STRICTER than "does it resolve". A branch name resolves, and
// it resolves to something different an hour later; that is precisely the property
// that makes it unusable as the identity of a release.

import { parseRepoName, type RepoRef } from '../automation/repo-identity'

/** A full or abbreviated git object name, and nothing else. */
const COMMIT_SHA = /^[0-9a-f]{7,40}$/i

/**
 * Refs that name a moving or local position rather than a fixed one. Rejected by
 * NAME as well as by shape, so a value that happens to look hex-ish cannot sneak a
 * working-tree reference past the SHA check.
 */
const MOVING_OR_LOCAL = new Set([
  'head', 'orig_head', 'fetch_head', 'merge_head', 'working', 'workdir', 'worktree',
  'local', 'dirty', 'current', 'latest', 'main', 'master', 'develop', 'dev',
])

export type SourceArtifact = {
  /** The update this artifact belongs to. */
  updateKey: string
  repo: RepoRef
  /** A commit SHA. Never a branch, a tag, or a working-tree reference. */
  commit: string
  /** Where the identity came from, so provenance is visible rather than assumed. */
  resolvedFrom: 'update_record' | 'release_package'
}

export type SourceArtifactResult =
  | { ok: true; artifact: SourceArtifact }
  | { ok: false; code: SourceArtifactRefusal; reason: string }

export type SourceArtifactRefusal =
  | 'no_source_commit'
  | 'not_a_commit'
  | 'moving_or_local_ref'
  | 'no_source_repo'
  | 'dirty_worktree'

export type SourceArtifactInput = {
  updateKey: string
  sourceRepo?: string
  sourceCommit?: string
  /**
   * Whether the source checkout that produced this record had uncommitted changes.
   * Optional, and TRUE is the only value that changes anything: a record that does
   * not say is not assumed clean — it is assumed to have no opinion, which is what
   * every record written before this field existed genuinely has.
   */
  sourceWorktreeDirty?: boolean
  resolvedFrom?: SourceArtifact['resolvedFrom']
}

/**
 * Resolve and validate the artifact. Every refusal carries a stable code and a
 * sentence an operator can act on — "no source commit recorded" is a different
 * problem from "that is a branch name", and they have different fixes.
 */
export function resolveSourceArtifact(input: SourceArtifactInput): SourceArtifactResult {
  if (input.sourceWorktreeDirty === true) {
    return {
      ok: false,
      code: 'dirty_worktree',
      reason: 'this update was captured from a checkout with uncommitted changes — commit them and re-record it, so what ships can be reproduced and rolled back',
    }
  }

  const repo = parseRepoName(input.sourceRepo)
  if (!repo) {
    return { ok: false, code: 'no_source_repo', reason: 'this update has no source repository recorded, so there is nothing to resolve the files from' }
  }

  const raw = (input.sourceCommit ?? '').trim()
  if (!raw) {
    return { ok: false, code: 'no_source_commit', reason: 'this update has no source commit recorded — there is no exact set of files to send' }
  }
  if (MOVING_OR_LOCAL.has(raw.toLowerCase())) {
    return {
      ok: false,
      code: 'moving_or_local_ref',
      reason: `"${raw}" names a moving position rather than a fixed one — it will mean something different tomorrow. Record the exact commit instead`,
    }
  }
  if (!COMMIT_SHA.test(raw)) {
    return {
      ok: false,
      code: 'not_a_commit',
      reason: `"${raw}" is not a commit. A release is identified by the commit it was built from, because that is the only reference that still means the same thing later`,
    }
  }

  return {
    ok: true,
    artifact: { updateKey: input.updateKey, repo, commit: raw.toLowerCase(), resolvedFrom: input.resolvedFrom ?? 'update_record' },
  }
}

/** Short, stable display form: `owner/name@abc1234`. Safe to log. */
export function describeSourceArtifact(a: SourceArtifact): string {
  return `${a.repo.owner}/${a.repo.name}@${a.commit.slice(0, 7)}`
}

/**
 * Whether a Preview deployment is the SAME artifact that is about to be promoted.
 *
 * The promotion path already binds an approval to a deployment id; this is the
 * commit half of the same question, and it is the one that catches a Preview that
 * was rebuilt from a newer branch head after the owner reviewed it. Prefix-tolerant
 * in both directions, because a short SHA and a long SHA are the same commit.
 */
export function previewMatchesArtifact(
  artifact: Pick<SourceArtifact, 'commit'>,
  preview: { commit?: string } | null | undefined,
): { ok: boolean; reason?: string } {
  const p = (preview?.commit ?? '').trim().toLowerCase()
  if (!p) return { ok: false, reason: 'the Preview did not report which commit it was built from' }
  const a = artifact.commit.toLowerCase()
  if (a.startsWith(p) || p.startsWith(a)) return { ok: true }
  return { ok: false, reason: `the Preview was built from ${p.slice(0, 7)}, but the approved artifact is ${a.slice(0, 7)} — it moved after review` }
}
