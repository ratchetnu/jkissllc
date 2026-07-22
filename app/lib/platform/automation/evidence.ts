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

/**
 * Cap one list, recording anything dropped so a short list never reads as complete.
 *
 * Generic over the element type because not every bounded list is a list of paths:
 * `skippedModules` carries `{ module, reason }` pairs, and the reason is the entire
 * point of that field. One bounding rule for every list keeps the truncation
 * accounting uniform.
 */
export function boundList<T>(
  items: T[] | undefined,
  field: keyof EvidenceTruncation,
  truncated: EvidenceTruncation,
  max: number = EVIDENCE_MAX_PATHS,
): T[] | undefined {
  if (!items) return undefined
  if (items.length <= max) return items
  truncated[field] = items.length - max
  return items.slice(0, max)
}

type Common = { jobId: string; attempt: number; sourceCommit?: string; now: number }

/**
 * Evidence for a build that PRODUCED a manifest.
 *
 * Note what is deliberately absent: `contents`, `contentBase64` and every `sha256`.
 * The manifest's entries carry content hashes; only their `path` is copied out. The
 * true entry count is always preserved even when the path list is truncated, so a
 * capped record still tells you how big the transfer really was.
 *
 * `skippedModules` is captured alongside `symbolCheckedPaths` on purpose: together they
 * are the complete account of the symbol gate's decision — what it verified, and what
 * it knowingly failed open on.
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
    manifestPaths: boundList(data.manifest.entries.map((e) => e.path), 'manifestPaths', truncated),
    excludedPaths: boundList(data.excludedPaths, 'excludedPaths', truncated),
    driftCheckedPaths: boundList(data.driftCheckedPaths, 'driftCheckedPaths', truncated),
    closureCheckedPaths: boundList(data.closureCheckedPaths, 'closureCheckedPaths', truncated),
    symbolCheckedPaths: boundList(data.symbolCheckedPaths, 'symbolCheckedPaths', truncated),
    skippedModules: boundList(data.skippedModules, 'skippedModules', truncated),
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
