// ── Operion rehearsal — correct git path-existence (issue: B-13) ─────────────
//
// WHY THIS EXISTS. The read-only Preview-transfer rehearsal drives the real transfer
// gates offline, using local git as a stand-in for the GitHub App provider. An early
// harness decided "does this path exist on the target?" from the exit status of
// `git show <rev>:<path>` — and that is wrong for one specific, load-bearing reason:
//
//     `git show <rev>:<path>` treats a path containing [brackets] as a PATHSPEC GLOB.
//     For a path that does NOT exist, it exits 0 with EMPTY output instead of failing.
//
// Next.js dynamic segments are exactly such paths — `app/api/portal/documents/[id]/
// route.ts`. So a missing bracketed file read as "exists, empty", which for an added
// file looks like target drift: a false gate result, produced by the harness, not by
// the gate. (A plain missing path fails loudly, which is why this went unnoticed.)
//
// THE FIX. Existence is decided by the TREE LISTING, which is authoritative and does no
// globbing; content is read only after the tree confirms the path is present. That also
// resolves the three states a boolean check collapses into one — see `PathState`.
//
// SCOPE. This is a REHEARSAL utility. It touches no transfer runtime, no production
// gate, and no PR #56 behaviour. The production path is immune by construction — it
// resolves existence through `provider.readTree` and discriminates `not_found` on
// `readFileContent`; nothing in it shells out to `git show`. This helper simply makes
// the OFFLINE stand-in as trustworthy as the online path it imitates.

import { execFileSync } from 'node:child_process'

/** The three distinct answers a naive existence check collapses into one. */
export type PathState =
  | { state: 'missing' }                                   // not in the tree at this rev
  | { state: 'empty'; bytes: 0 }                           // in the tree, zero-length — a REAL file
  | { state: 'present'; bytes: number; content: Buffer }   // in the tree, with bytes

const git = (repo: string, args: string[]): Buffer =>
  execFileSync('git', ['-C', repo, ...args], { maxBuffer: 1 << 29 })

/**
 * Every blob path at a rev — one call, authoritative, glob-free. This is the only
 * source of truth for existence; callers must not fall back to command exit status.
 */
export function treePaths(repo: string, rev: string): Set<string> {
  return new Set(git(repo, ['ls-tree', '-r', '--name-only', rev]).toString('utf8').split('\n').filter(Boolean))
}

/**
 * Resolve one path at one rev into an unambiguous state.
 *
 * `tree` must come from `treePaths(repo, rev)`. Requiring it as an argument keeps this
 * O(1) per path AND makes the authority explicit — existence is decided before any
 * `git show` runs, so the bracket-glob pathology can never be reached.
 */
export function pathState(repo: string, rev: string, path: string, tree: Set<string>): PathState {
  if (!tree.has(path)) return { state: 'missing' }
  const content = git(repo, ['show', `${rev}:${path}`])
  return content.length === 0 ? { state: 'empty', bytes: 0 } : { state: 'present', bytes: content.length, content }
}

/** The check that used to be wrong: "is this path present at this rev?" Tree-only. */
export function pathExists(path: string, tree: Set<string>): boolean {
  return tree.has(path)
}
