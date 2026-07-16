// ── Operion automation — GitHub connection validation (read-only) ────────────
// Owner action: prove the App can authenticate + reach the target repo/branch WITHOUT
// mutating anything. Returns pass/fail checks with safe details only (never a token).

import type { PlatformBusiness } from '../updates/types'
import { getAutomationProvider } from './provider'
import { isRepoAllowed, isBranchAllowed } from './preflight'

export type ConnCheck = { name: string; ok: boolean; detail?: string }
export type ValidateResult = { ok: boolean; checks: ConnCheck[]; defaultBranch?: string; providerConfigured: boolean }

export async function validateGithubConnection(b: PlatformBusiness, env: Record<string, string | undefined> = process.env): Promise<ValidateResult> {
  const checks: ConnCheck[] = []
  const push = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail })

  const configured = !!b.githubInstallationId && !!b.repositoryOwner && !!b.repositoryNameOnly
  push('Business automation configured', configured, configured ? undefined : 'set installation id + repo owner/name in the business record')
  if (!configured) return { ok: false, checks, providerConfigured: false }

  const provider = getAutomationProvider(env)
  const providerConfigured = provider.name === 'github'
  push('Server has GitHub App credentials', providerConfigured, providerConfigured ? undefined : 'GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY not present on this server')
  if (!providerConfigured) return { ok: false, checks, providerConfigured: false }

  const repo = { owner: b.repositoryOwner!, name: b.repositoryNameOnly! }
  // Defence-in-depth: only validate a repo/branch that Operion has registered.
  push('Repository allowlisted in Operion', isRepoAllowed(b, repo.owner, repo.name), 'repo must match the registered business record')

  const auth = await provider.validateConnection(b.githubInstallationId!)
  push('App authentication + installation token', auth.ok, auth.ok ? undefined : (auth as { error: string }).error)
  if (!auth.ok) return { ok: false, checks, providerConfigured }

  const repoRes = await provider.readRepository(b.githubInstallationId!, repo)
  push('Repository access', repoRes.ok, repoRes.ok ? `default branch: ${repoRes.data.defaultBranch}` : (repoRes as { error: string }).error)
  const defaultBranch = repoRes.ok ? repoRes.data.defaultBranch : b.defaultBranch

  if (repoRes.ok) {
    push('Base branch allowlisted', isBranchAllowed(b, defaultBranch, 'target'), `branch: ${defaultBranch}`)
    const br = await provider.readBranch(b.githubInstallationId!, repo, defaultBranch)
    push('Branch access', br.ok, br.ok ? `head: ${br.data.commit.slice(0, 7)}` : (br as { error: string }).error)
  }

  return { ok: checks.every(c => c.ok), checks, defaultBranch, providerConfigured }
}
