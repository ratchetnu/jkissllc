// ── Operion rehearsal — read-only local-git provider ─────────────────────────
//
// A stand-in for the GitHub App `UpdateAutomationProvider` that reads two local clones
// instead of the network, so the real transfer gates can be rehearsed offline. It
// implements ONLY the read methods the manifest builder calls; every mutating capability
// throws, so a rehearsal can never create a branch, dispatch a workflow, open a PR,
// merge, or promote — the harness is structurally incapable of a write.
//
// Existence comes exclusively from `git-path-state` (B-13): the target's file set is a
// tree listing, and a per-file read is discriminated into found / not_found the same way
// the production provider discriminates a 404. No `git show` decides existence.

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import { treePaths, pathState } from './git-path-state'

export type RehearsalRepos = {
  /** Local path to the SOURCE clone (where the update's commit lives). */
  sourceRepoPath: string
  /** Local path to the TARGET clone (the business being rehearsed against). */
  targetRepoPath: string
  /** The target ref to pin as the base — e.g. 'origin/main'. */
  targetRef: string
}

const REHEARSAL_VIOLATION = (op: string) => { throw new Error(`operion-rehearsal is read-only: ${op} must never run in a rehearsal`) }

const git = (repo: string, args: string[]): Buffer => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 1 << 29 })
const gitStr = (repo: string, args: string[]): string => git(repo, args).toString('utf8').trim()
const sha256hex = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex')

/** Every provider read that actually happened — the harness asserts against this. */
export type ProviderCall = { op: string; repo: 'source' | 'target'; path?: string; ref?: string }

export type RehearsalProvider = {
  name: string
  calls: ProviderCall[]
  reads: number
  // The subset of UpdateAutomationProvider the manifest builder uses. Structurally
  // compatible; `as never` at the call site keeps this file free of the app import.
  readCommit(installationId: string, repo: unknown, sha: string): Promise<unknown>
  readBranch(installationId: string, repo: unknown, branch: string): Promise<unknown>
  readTree(installationId: string, repo: unknown, sha: string): Promise<unknown>
  readCommitFiles(installationId: string, repo: unknown, sha: string): Promise<unknown>
  readFileContent(installationId: string, repo: unknown, path: string, ref: string): Promise<unknown>
  createBranch(): never
  dispatchWorkflow(): never
  createPullRequest(): never
  mergePullRequest(): never
  promoteProduction(): never
  createPreviewDeployment(): never
}

export function makeLocalGitProvider(repos: RehearsalRepos): RehearsalProvider {
  const { sourceRepoPath, targetRepoPath, targetRef } = repos
  const targetTree = treePaths(targetRepoPath, targetRef)
  const targetCommit = gitStr(targetRepoPath, ['rev-parse', targetRef])
  const calls: ProviderCall[] = []
  const state = { reads: 0 }

  const provider: RehearsalProvider = {
    name: 'operion-rehearsal:local-git',
    calls,
    get reads() { return state.reads },

    async readCommit(_i, _r, sha) {
      calls.push({ op: 'readCommit', repo: 'source', ref: sha })
      const parentSha = gitStr(sourceRepoPath, ['rev-parse', `${sha}^`])
      const message = gitStr(sourceRepoPath, ['log', '-1', '--format=%s', sha])
      return { ok: true, data: { sha, message, parentSha, parentCount: 1 } }
    },

    // Fewer params than the interface is legal in TS and keeps eslint quiet on the
    // args these read methods genuinely ignore.
    async readBranch() {
      calls.push({ op: 'readBranch', repo: 'target', ref: targetRef })
      return { ok: true, data: { commit: targetCommit } }
    },

    async readTree() {
      calls.push({ op: 'readTree', repo: 'target', ref: targetRef })
      return { ok: true, data: { paths: [...targetTree] } }
    },

    async readCommitFiles(_i, _r, sha) {
      calls.push({ op: 'readCommitFiles', repo: 'source', ref: sha })
      const files = gitStr(sourceRepoPath, ['diff-tree', '-r', '--no-commit-id', '--name-status', `${sha}^`, sha])
        .split('\n').filter(Boolean).map((l) => {
          const parts = l.split('\t')
          const st = parts[0][0]
          const filename = parts[parts.length - 1]
          const status = st === 'A' ? 'added' : st === 'D' ? 'removed' : st === 'R' ? 'renamed' : 'modified'
          return { filename, status }
        })
      return { ok: true, data: { files } }
    },

    async readFileContent(_i, repo, path, ref) {
      state.reads++
      const isTarget = (repo as { name?: string })?.name === 'supercharged' || (repo as { isTarget?: boolean })?.isTarget === true
      calls.push({ op: 'readFileContent', repo: isTarget ? 'target' : 'source', path, ref })
      if (isTarget) {
        // Existence via the TREE, never via `git show` exit status (B-13). This mirrors
        // the production provider returning `not_found` for a 404.
        const st = pathState(targetRepoPath, targetRef, path, targetTree)
        if (st.state === 'missing') return { ok: false, error: 'not found', category: 'not_found' }
        const buf = st.state === 'empty' ? Buffer.alloc(0) : st.content
        return { ok: true, data: { contentBase64: buf.toString('base64'), sha256: sha256hex(buf) } }
      }
      // Source side: the ref is either the commit or its first parent (drift baseline).
      let buf: Buffer
      try { buf = git(sourceRepoPath, ['show', `${ref}:${path}`]) } catch { return { ok: false, error: 'not found', category: 'not_found' } }
      return { ok: true, data: { contentBase64: buf.toString('base64'), sha256: sha256hex(buf) } }
    },

    createBranch: () => REHEARSAL_VIOLATION('createBranch'),
    dispatchWorkflow: () => REHEARSAL_VIOLATION('dispatchWorkflow'),
    createPullRequest: () => REHEARSAL_VIOLATION('createPullRequest'),
    mergePullRequest: () => REHEARSAL_VIOLATION('mergePullRequest'),
    promoteProduction: () => REHEARSAL_VIOLATION('promoteProduction'),
    createPreviewDeployment: () => REHEARSAL_VIOLATION('createPreviewDeployment'),
  }
  return provider
}
