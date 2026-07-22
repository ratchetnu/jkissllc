// ── Operion transfer evidence — PURE shaping (§4 #7) ─────────────────────────
//
// The manifest builder decides a great deal and then throws all of it away. This module
// turns a build outcome into the bounded, secret-free record that `store.saveTransferEvidence`
// persists. It is pure — no I/O, no clock (the caller supplies `now`) — so the two
// properties that actually matter can be asserted without a provider or a network:
//
//   1. the record NEVER carries file contents, content hashes, or secrets, and
//   2. truncation is NEVER silent.
//
// Those are safety properties of the shape, not of the handler, so they belong here
// where they can be tested exhaustively.

import {
  TRANSFER_EVIDENCE_VERSION, EVIDENCE_MAX_PATHS, EVIDENCE_MAX_REASON,
  type TransferEvidence, type EvidenceTruncation,
} from './types'
import type { BuiltManifest } from './manifest-builder'

/** Cap one path list, recording anything dropped so a short list never reads as complete. */
export function boundPaths(
  paths: string[] | undefined,
  field: keyof EvidenceTruncation,
  truncated: EvidenceTruncation,
  max: number = EVIDENCE_MAX_PATHS,
): string[] | undefined {
  if (!paths) return undefined
  if (paths.length <= max) return paths
  truncated[field] = paths.length - max
  return paths.slice(0, max)
}

type Common = { jobId: string; attempt: number; sourceCommit?: string; now: number }

/**
 * Evidence for a build that PRODUCED a manifest.
 *
 * Note what is deliberately absent: `contents`, `contentBase64` and every `sha256`.
 * The manifest's entries carry content hashes; only their `path` is copied out. The
 * true entry count is always preserved even when the path list is truncated, so a
 * capped record still tells you how big the transfer really was.
 */
export function buildTransferEvidence(data: BuiltManifest, c: Common): TransferEvidence {
  const truncated: EvidenceTruncation = {}
  const evidence: TransferEvidence = {
    evidenceVersion: TRANSFER_EVIDENCE_VERSION,
    recordedAt: c.now,
    jobId: c.jobId,
    attempt: c.attempt,
    outcome: 'built',
    sourceCommit: c.sourceCommit,
    targetBaseCommit: data.targetBaseCommit,
    manifestEntryCount: data.manifest.entries.length,
    manifestPaths: boundPaths(data.manifest.entries.map((e) => e.path), 'manifestPaths', truncated),
    excludedPaths: boundPaths(data.excludedPaths, 'excludedPaths', truncated),
    driftCheckedPaths: boundPaths(data.driftCheckedPaths, 'driftCheckedPaths', truncated),
    closureCheckedPaths: boundPaths(data.closureCheckedPaths, 'closureCheckedPaths', truncated),
    symbolCheckedPaths: boundPaths(data.symbolCheckedPaths, 'symbolCheckedPaths', truncated),
  }
  if (Object.keys(truncated).length) evidence.truncated = truncated
  return evidence
}

/**
 * Evidence for a build that was REFUSED.
 *
 * This is the case that previously left no trace whatsoever — the route returned 422
 * and stored nothing, so reconstructing why a transfer was rejected meant reading git
 * history. No manifest field is claimed here, because none was produced.
 */
export function buildRefusalEvidence(reason: string, c: Common): TransferEvidence {
  return {
    evidenceVersion: TRANSFER_EVIDENCE_VERSION,
    recordedAt: c.now,
    jobId: c.jobId,
    attempt: c.attempt,
    outcome: 'refused',
    sourceCommit: c.sourceCommit,
    failureReason: reason.slice(0, EVIDENCE_MAX_REASON),
  }
}
