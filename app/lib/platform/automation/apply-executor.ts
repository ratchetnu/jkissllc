// ── Operion Commit-Transfer apply engine (deterministic; injectable fs) ──────
// Given a validated manifest + the approved file contents, apply exactly those files into a
// checked-out target working tree — nothing else is touched. Every add/modify verifies the
// content hash before writing; a mismatch or missing source is a structured failure and the
// caller MUST abort before committing. `fs` is injected so the whole engine is testable
// against an in-memory tree (no real disk, no network).

import { type ApplyManifest, type ManifestEntry, isSafeRepoPath, sortEntries, sha256, validateManifest } from './manifest'

export interface FsAdapter {
  exists(path: string): boolean
  read(path: string): string | null
  write(path: string, content: Buffer): void   // creates parent dirs
  remove(path: string): void
}

/** Approved content for add/modify entries, keyed by repo-relative path. */
export type ContentMap = Record<string, { contentBase64: string; sha256: string }>

export type ApplyResult = {
  ok: boolean
  changed: boolean
  applied: { path: string; action: ManifestEntry['action'] }[]
  skipped: { path: string; reason: string }[]
  failed: { path: string; reason: string }[]
}

/** Deterministically apply a manifest. Returns structured results; never throws on a bad
 *  entry — it records a failure so the workflow can abort cleanly and leave the branch
 *  recoverable (only touched files were written; the caller resets on ok=false). */
export function applyManifest(manifest: ApplyManifest, contents: ContentMap, fs: FsAdapter): ApplyResult {
  const applied: ApplyResult['applied'] = []
  const skipped: ApplyResult['skipped'] = []
  const failed: ApplyResult['failed'] = []

  // Defence in depth: re-validate the whole manifest before touching anything.
  const v = validateManifest(manifest)
  if (!v.ok) return { ok: false, changed: false, applied, skipped, failed: v.errors.map(e => ({ path: '(manifest)', reason: e })) }

  for (const e of sortEntries(manifest.entries)) {
    if (!isSafeRepoPath(e.path)) { failed.push({ path: e.path, reason: 'unsafe path' }); continue }
    try {
      if (e.action === 'delete') {
        if (!fs.exists(e.path)) { skipped.push({ path: e.path, reason: 'already absent' }); continue }
        fs.remove(e.path); applied.push({ path: e.path, action: 'delete' }); continue
      }
      // add / modify
      const c = contents[e.path]
      if (!c) { failed.push({ path: e.path, reason: 'missing source content' }); continue }
      const buf = Buffer.from(c.contentBase64, 'base64')
      const actual = sha256(buf)
      if (actual !== e.sha256) { failed.push({ path: e.path, reason: 'hash mismatch' }); continue }
      if (c.sha256 && c.sha256 !== e.sha256) { failed.push({ path: e.path, reason: 'content hash disagrees with manifest' }); continue }
      fs.write(e.path, buf); applied.push({ path: e.path, action: e.action })
    } catch (err) {
      failed.push({ path: e.path, reason: err instanceof Error ? err.message : 'write error' })
    }
  }
  return { ok: failed.length === 0, changed: applied.length > 0, applied, skipped, failed }
}

/** Compact, path-free summary for callbacks/telemetry (no filesystem paths leaked upward). */
export function applySummary(r: ApplyResult): { applied: number; skipped: number; failed: number; changed: boolean } {
  return { applied: r.applied.length, skipped: r.skipped.length, failed: r.failed.length, changed: r.changed }
}
