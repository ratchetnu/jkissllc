// ── Operion Commit-Transfer manifest builder (server-side) ───────────────────
// Turns an approved update's source commit into a deterministic, hash-verified manifest +
// the approved file contents, read read-only from the SOURCE repo via the GitHub App. The
// manifest is derived from the commit's own file list — never from scanning a repo — so the
// transfer set is exactly what the update changed and nothing else.

import { isSafeRepoPath, manifestFromCommitFiles, validateManifest, type ApplyManifest } from './manifest'
import type { UpdateAutomationProvider, RepoRef } from './provider'
import type { UpdateCompatibility } from '../updates/types'

export type BuiltManifest = {
  manifest: ApplyManifest
  contents: Record<string, { contentBase64: string; sha256: string }>
  excludedPaths: string[]
}
export type BuildResult = { ok: true; data: BuiltManifest } | { ok: false; error: string }

export async function buildCommitTransferManifest(input: {
  provider: UpdateAutomationProvider
  installationId: string
  sourceRepo: RepoRef        // {owner,name}
  sourceRepoName: string     // "owner/name" for the record
  sourceCommit: string
  updateKey: string
  compatibility?: Pick<UpdateCompatibility, 'status' | 'pathsToExclude'>
}): Promise<BuildResult> {
  const { provider, installationId, sourceRepo, sourceRepoName, sourceCommit, updateKey } = input
  if (!sourceCommit) return { ok: false, error: 'update has no source commit to transfer' }

  const compatibility = input.compatibility
  if (!compatibility) return { ok: false, error: 'target compatibility record is required to build a transfer manifest' }
  if (compatibility.status !== 'compatible' && compatibility.status !== 'compatible_with_changes') {
    return { ok: false, error: `target compatibility status does not allow deterministic transfer: ${compatibility.status}` }
  }

  const excluded = new Set<string>()
  for (const raw of compatibility.pathsToExclude ?? []) {
    const path = raw.trim()
    if (!isSafeRepoPath(path)) return { ok: false, error: `invalid excluded repository path: ${JSON.stringify(raw)}` }
    excluded.add(path)
  }

  const cf = await provider.readCommitFiles(installationId, sourceRepo, sourceCommit)
  if (!cf.ok) return { ok: false, error: `read commit files: ${cf.error}` }

  const commitEntries = manifestFromCommitFiles(cf.data.files)
  const commitPaths = new Set(commitEntries.map((entry) => entry.path))
  const unmatchedExclusions = [...excluded].filter((path) => !commitPaths.has(path))
  if (unmatchedExclusions.length) {
    return { ok: false, error: `excluded repository path not present in source commit: ${unmatchedExclusions.sort().join(', ')}` }
  }

  const contents: Record<string, { contentBase64: string; sha256: string }> = {}
  const entries: ApplyManifest['entries'] = []
  const excludedPaths: string[] = []
  for (const e of commitEntries) {
    if (excluded.has(e.path)) { excludedPaths.push(e.path); continue }
    if (e.action === 'delete') { entries.push(e); continue }
    const fc = await provider.readFileContent(installationId, sourceRepo, e.path, sourceCommit)
    if (!fc.ok) return { ok: false, error: `read ${e.path}: ${fc.error}` }
    contents[e.path] = { contentBase64: fc.data.contentBase64, sha256: fc.data.sha256 }
    entries.push({ ...e, sha256: fc.data.sha256 })
  }

  const manifest: ApplyManifest = { updateKey, sourceRepo: sourceRepoName, sourceCommit, entries }
  const v = validateManifest(manifest)
  if (!v.ok) return { ok: false, error: `invalid manifest: ${v.errors.join('; ')}` }
  return { ok: true, data: { manifest, contents, excludedPaths: excludedPaths.sort() } }
}
