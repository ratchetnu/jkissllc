// ── Operion Commit-Transfer manifest builder (server-side) ───────────────────
// Turns an approved update's source commit into a deterministic, hash-verified manifest +
// the approved file contents, read read-only via the GitHub App. Before returning any
// payload it performs a three-way source-baseline/source-new/target-current comparison,
// so target-owned changes fail closed instead of being overwritten. The manifest is derived
// from the commit's own file list — never from scanning a repo.

import { isSafeRepoPath, manifestFromCommitFiles, validateManifest, type ApplyManifest } from './manifest'
import { analyzeClosure, describeClosureProblems, isCodePath, type ClosureProblem } from './closure'
import type { UpdateAutomationProvider, RepoRef } from './provider'
import type { UpdateCompatibility } from '../updates/types'

export type BuiltManifest = {
  manifest: ApplyManifest
  contents: Record<string, { contentBase64: string; sha256: string }>
  excludedPaths: string[]
  driftCheckedPaths: string[]
  targetBaseCommit: string
  /** Manifest code files whose local imports were verified against the target. */
  closureCheckedPaths: string[]
}
export type BuildResult = { ok: true; data: BuiltManifest } | { ok: false; error: string }

export async function buildCommitTransferManifest(input: {
  provider: UpdateAutomationProvider
  installationId: string
  sourceRepo: RepoRef        // {owner,name}
  sourceRepoName: string     // "owner/name" for the record
  sourceCommit: string
  targetRepo: RepoRef
  targetBranch: string
  updateKey: string
  compatibility?: Pick<UpdateCompatibility, 'status' | 'pathsToExclude'>
}): Promise<BuildResult> {
  const { provider, installationId, sourceRepo, sourceRepoName, sourceCommit, targetRepo, targetBranch, updateKey } = input
  if (!sourceCommit) return { ok: false, error: 'update has no source commit to transfer' }
  if (!targetBranch) return { ok: false, error: 'target has no base branch for drift validation' }

  const compatibility = input.compatibility
  if (!compatibility) return { ok: false, error: 'target compatibility record is required to build a transfer manifest' }
  if (compatibility.status !== 'compatible' && compatibility.status !== 'compatible_with_changes') {
    return { ok: false, error: `target compatibility status does not allow deterministic transfer: ${compatibility.status}` }
  }

  const [sourceCommitInfo, targetBase] = await Promise.all([
    provider.readCommit(installationId, sourceRepo, sourceCommit),
    provider.readBranch(installationId, targetRepo, targetBranch),
  ])
  if (!sourceCommitInfo.ok) return { ok: false, error: `read source commit: ${sourceCommitInfo.error}` }
  if (!targetBase.ok) return { ok: false, error: `read target base branch: ${targetBase.error}` }

  const excluded = new Set<string>()
  for (const raw of compatibility.pathsToExclude ?? []) {
    const path = raw.trim()
    if (!isSafeRepoPath(path)) return { ok: false, error: `invalid excluded repository path: ${JSON.stringify(raw)}` }
    excluded.add(path)
  }

  const cf = await provider.readCommitFiles(installationId, sourceRepo, sourceCommit)
  if (!cf.ok) return { ok: false, error: `read commit files: ${cf.error}` }
  const renamed = cf.data.files.filter((file) => file.status === 'renamed').map((file) => file.filename).sort()
  if (renamed.length) {
    return { ok: false, error: `renamed files require a separate reviewed update: ${renamed.join(', ')}` }
  }

  const commitEntries = manifestFromCommitFiles(cf.data.files)
  const commitPaths = new Set(commitEntries.map((entry) => entry.path))
  const unmatchedExclusions = [...excluded].filter((path) => !commitPaths.has(path))
  if (unmatchedExclusions.length) {
    return { ok: false, error: `excluded repository path not present in source commit: ${unmatchedExclusions.sort().join(', ')}` }
  }

  // ── Dependency closure (issue #48 P1-1) ─────────────────────────────────────
  // Runs AFTER compatibility, refs, exclusions and the rename guard, and BEFORE any
  // drift comparison or target read — so an update that cannot possibly compile on
  // the target costs one tree call and never touches the target repository.
  //
  // It needs the source text of the manifest's own code files to see their imports.
  // Those reads are CACHED and reused by the transfer loop below, so a closure-clean
  // build makes exactly the same number of content reads it made before this gate
  // existed, and a closure-blocked build makes zero target-side reads.
  const kept = commitEntries.filter((e) => !excluded.has(e.path))
  const targetTree = await provider.readTree(installationId, targetRepo, targetBase.data.commit)
  if (!targetTree.ok) return { ok: false, error: `read target tree: ${targetTree.error}` }

  const sourceCache = new Map<string, { contentBase64: string; sha256: string }>()
  for (const e of kept) {
    // A delete removes a file; it cannot introduce an import, so it needs no source.
    if (e.action === 'delete' || !isCodePath(e.path)) continue
    const fc = await provider.readFileContent(installationId, sourceRepo, e.path, sourceCommit)
    if (!fc.ok) return { ok: false, error: `read ${e.path}: ${fc.error}` }
    sourceCache.set(e.path, fc.data)
  }

  const closure = analyzeClosure({
    manifestPaths: kept.filter((e) => e.action !== 'delete').map((e) => e.path),
    excludedPaths: [...excluded],
    targetPaths: targetTree.data.paths,
    sourceOf: (path) => {
      const hit = sourceCache.get(path)
      return hit ? Buffer.from(hit.contentBase64, 'base64').toString('utf8') : undefined
    },
  })
  if (!closure.ok) {
    return { ok: false, error: `dependency closure failed — ${describeClosureProblems(closure.problems as ClosureProblem[])}` }
  }

  const contents: Record<string, { contentBase64: string; sha256: string }> = {}
  const entries: ApplyManifest['entries'] = []
  const excludedPaths: string[] = []
  const driftCheckedPaths: string[] = []
  for (const e of commitEntries) {
    if (excluded.has(e.path)) { excludedPaths.push(e.path); continue }

    const targetFile = await provider.readFileContent(installationId, targetRepo, e.path, targetBase.data.commit)
    if (!targetFile.ok && targetFile.category !== 'not_found') return { ok: false, error: `read target ${e.path}: ${targetFile.error}` }
    const targetHash = targetFile.ok ? targetFile.data.sha256 : undefined

    let baselineHash: string | undefined
    if (e.action !== 'add') {
      if (!sourceCommitInfo.data.parentSha) return { ok: false, error: `source commit has no parent for drift validation of ${e.path}` }
      const baseline = await provider.readFileContent(installationId, sourceRepo, e.path, sourceCommitInfo.data.parentSha)
      if (!baseline.ok) return { ok: false, error: `read source baseline ${e.path}: ${baseline.error}` }
      baselineHash = baseline.data.sha256
    }

    if (e.action === 'delete') {
      if (targetHash && targetHash !== baselineHash) return { ok: false, error: `target drift detected for ${e.path}` }
      driftCheckedPaths.push(e.path)
      entries.push(e)
      continue
    }

    // Reuse the bytes the closure pass already fetched — no file is read twice.
    const cached = sourceCache.get(e.path)
    const fc = cached ? { ok: true as const, data: cached } : await provider.readFileContent(installationId, sourceRepo, e.path, sourceCommit)
    if (!fc.ok) return { ok: false, error: `read ${e.path}: ${fc.error}` }
    if (e.action === 'add') {
      if (targetHash && targetHash !== fc.data.sha256) return { ok: false, error: `target drift detected for ${e.path}` }
    } else if (!targetHash || (targetHash !== baselineHash && targetHash !== fc.data.sha256)) {
      return { ok: false, error: `target drift detected for ${e.path}` }
    }
    driftCheckedPaths.push(e.path)
    contents[e.path] = { contentBase64: fc.data.contentBase64, sha256: fc.data.sha256 }
    entries.push({ ...e, sha256: fc.data.sha256 })
  }

  const manifest: ApplyManifest = { updateKey, sourceRepo: sourceRepoName, sourceCommit, entries }
  const v = validateManifest(manifest)
  if (!v.ok) return { ok: false, error: `invalid manifest: ${v.errors.join('; ')}` }
  return { ok: true, data: {
    manifest,
    contents,
    excludedPaths: excludedPaths.sort(),
    driftCheckedPaths: driftCheckedPaths.sort(),
    targetBaseCommit: targetBase.data.commit,
    closureCheckedPaths: closure.scannedPaths,
  } }
}
