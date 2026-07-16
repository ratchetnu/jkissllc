// ── Operion automation — canonical repository identity (PURE) ────────────────
// ONE source of truth for "which repository" a business targets. Validation, the repo
// allowlist, workflow dispatch, and branch reads all resolve the repo through here, so
// there is exactly one accepted shape: `owner/name`. Strict — rejects a bare name, URLs
// (other than a GitHub remote, which is normalized), filesystem paths, extra slashes, and
// unsupported characters. No I/O, fully testable.

export type RepoRef = { owner: string; name: string }

// GitHub allows [A-Za-z0-9._-] in owner and repo names.
const SEGMENT = /^[A-Za-z0-9._-]+$/

/** Parse any accepted repository input into a canonical {owner,name}, or null if invalid. */
export function parseRepoName(raw: string | null | undefined): RepoRef | null {
  if (typeof raw !== 'string') return null
  let s = raw.trim()
  if (!s) return null
  // Normalize a GitHub HTTPS/SSH remote → owner/name (strip scheme+host, optional .git, /).
  const https = s.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i)
  const ssh = s.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i)
  if (https) s = `${https[1]}/${https[2]}`
  else if (ssh) s = `${ssh[1]}/${ssh[2]}`
  else if (/:\/\//.test(s) || s.startsWith('git@')) return null   // any other URL/scheme → reject
  const parts = s.split('/')
  if (parts.length !== 2) return null                              // bare name OR extra slashes
  const [owner, name] = parts
  if (!SEGMENT.test(owner) || !SEGMENT.test(name)) return null     // unsupported characters
  if ([owner, name].some((p) => p === '.' || p === '..')) return null // path traversal guard
  return { owner, name }
}

/** Canonical "owner/name" string, or null when the input is not a valid repo identifier. */
export function canonicalRepoName(raw: string | null | undefined): string | null {
  const r = parseRepoName(raw)
  return r ? `${r.owner}/${r.name}` : null
}

/** The canonical repo for a business: prefer repoName, fall back to explicit owner+name.
 *  Whichever is present must still parse to a valid owner/name — no partial/loose matches. */
export function businessRepoRef(b: { repoName?: string; repositoryOwner?: string; repositoryNameOnly?: string }): RepoRef | null {
  return parseRepoName(b.repoName) ?? (b.repositoryOwner && b.repositoryNameOnly ? parseRepoName(`${b.repositoryOwner}/${b.repositoryNameOnly}`) : null)
}
