// ── Operion Commit-Transfer manifest (PURE, deterministic) ───────────────────
// A manifest is the EXACT, approved set of files an update transfers into a target repo —
// nothing is inferred from scanning the target. Every entry is path + action + content hash.
// This module validates a manifest and rejects anything unsafe (traversal, absolute paths,
// duplicates, outside-repo, missing hashes). No I/O — fully testable.

import crypto from 'node:crypto'

export type ManifestAction = 'add' | 'modify' | 'delete'
export type ManifestEntry = {
  path: string            // repository-relative POSIX path, e.g. "app/admin/x.tsx"
  action: ManifestAction
  sha256?: string         // required for add/modify (hash of the transferred content); absent for delete
  order?: number          // optional explicit ordering (lower first)
}
export type ApplyManifest = {
  updateKey: string
  sourceRepo: string
  sourceCommit?: string
  entries: ManifestEntry[]
}

export const MAX_MANIFEST_ENTRIES = 200
const HEX64 = /^[a-f0-9]{64}$/

export function sha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

/** A safe repository-relative path: POSIX, relative, no traversal, no absolute/home/NUL. */
export function isSafeRepoPath(p: unknown): p is string {
  if (typeof p !== 'string' || !p || p.length > 400) return false
  if (p.includes('\0') || p.includes('\\')) return false           // NUL / Windows separators
  if (p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:/.test(p)) return false // absolute / drive / home
  const segs = p.split('/')
  if (segs.some(s => s === '' || s === '.' || s === '..')) return false           // traversal / empty / current
  if (segs.some(s => !/^[A-Za-z0-9._-]+$/.test(s))) return false   // only safe chars per segment
  return true
}

export type ManifestValidation = { ok: boolean; errors: string[] }
/** Reject duplicate paths, unsafe paths, bad actions, and missing hashes. */
export function validateManifest(m: ApplyManifest): ManifestValidation {
  const errors: string[] = []
  if (!m || !Array.isArray(m.entries)) return { ok: false, errors: ['manifest has no entries array'] }
  if (m.entries.length === 0) errors.push('manifest is empty')
  if (m.entries.length > MAX_MANIFEST_ENTRIES) errors.push(`manifest exceeds ${MAX_MANIFEST_ENTRIES} entries`)
  const seen = new Set<string>()
  for (const e of m.entries) {
    if (!isSafeRepoPath(e.path)) { errors.push(`unsafe or invalid path: ${JSON.stringify(e.path)}`); continue }
    if (seen.has(e.path)) { errors.push(`duplicate path: ${e.path}`); continue }
    seen.add(e.path)
    if (e.action !== 'add' && e.action !== 'modify' && e.action !== 'delete') { errors.push(`invalid action for ${e.path}: ${String(e.action)}`); continue }
    if ((e.action === 'add' || e.action === 'modify') && !(typeof e.sha256 === 'string' && HEX64.test(e.sha256))) errors.push(`${e.action} entry ${e.path} needs a valid sha256`)
    if (e.action === 'delete' && e.sha256) errors.push(`delete entry ${e.path} must not carry content/hash`)
  }
  return { ok: errors.length === 0, errors }
}

/** Deterministic apply order: explicit order, then add/modify before delete, then path. */
export function sortEntries(entries: ManifestEntry[]): ManifestEntry[] {
  const rank = (a: ManifestAction) => (a === 'delete' ? 1 : 0)
  return [...entries].sort((a, b) =>
    (a.order ?? 1e9) - (b.order ?? 1e9) || rank(a.action) - rank(b.action) || a.path.localeCompare(b.path))
}

/** Map a GitHub commit's file list into manifest entries (content hash filled in later). */
export function manifestFromCommitFiles(files: { filename: string; status: string }[]): ManifestEntry[] {
  return files.map(f => ({
    path: f.filename,
    action: (f.status === 'removed' ? 'delete' : f.status === 'added' ? 'add' : 'modify') as ManifestAction,
  }))
}
