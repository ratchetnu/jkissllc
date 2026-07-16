// ── Operion automation — GitHub connection validation + auto-discovery ───────
// Owner action: prove the App can authenticate + reach the target repo/branch WITHOUT
// mutating anything, AND discover the installation id so the PlatformBusiness record can
// be populated automatically. Returns pass/fail checks + safe discovered metadata only
// (never a token or key).

import type { PlatformBusiness } from '../updates/types'
import { getAutomationProvider } from './provider'
import { isBranchAllowed } from './preflight'

export type ConnCheck = { name: string; ok: boolean; detail?: string }
export type DiscoveredConfig = { installationId: string; repositoryOwner: string; repositoryNameOnly: string; defaultBranch: string }
export type ValidateResult = { ok: boolean; checks: ConnCheck[]; providerConfigured: boolean; discovered?: DiscoveredConfig }

/** owner/name from the explicit fields, else split repoName ("ratchetnu/jkissllc"). */
function repoRefOf(b: PlatformBusiness): { owner: string; name: string } | null {
  if (b.repositoryOwner && b.repositoryNameOnly) return { owner: b.repositoryOwner, name: b.repositoryNameOnly }
  const parts = (b.repoName ?? '').split('/')
  if (parts.length === 2 && parts[0] && parts[1]) return { owner: parts[0], name: parts[1] }
  return null
}

export async function validateGithubConnection(b: PlatformBusiness, env: Record<string, string | undefined> = process.env): Promise<ValidateResult> {
  const checks: ConnCheck[] = []
  const push = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail })

  const repo = repoRefOf(b)
  push('Repository configured', !!repo, repo ? undefined : 'set repoName as "owner/name" (e.g. ratchetnu/supercharged)')
  if (!repo) return { ok: false, checks, providerConfigured: false }

  const provider = getAutomationProvider(env)
  const providerConfigured = provider.name === 'github'
  push('Server has GitHub App credentials', providerConfigured, providerConfigured ? undefined : 'GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY not present on this server')
  if (!providerConfigured) return { ok: false, checks, providerConfigured: false }

  // Discover the installation covering this repo (or use the configured id).
  let installationId = b.githubInstallationId
  if (!installationId) {
    const disc = await provider.getRepoInstallation(repo)
    push('Installation discovery', disc.ok, disc.ok ? `installation ${disc.data.installationId}` : (disc as { error: string }).error)
    if (!disc.ok) return { ok: false, checks, providerConfigured }
    installationId = disc.data.installationId
  } else {
    push('Installation configured', true, `installation ${installationId}`)
  }

  const auth = await provider.validateConnection(installationId)
  push('App authentication + installation token', auth.ok, auth.ok ? undefined : (auth as { error: string }).error)
  if (!auth.ok) return { ok: false, checks, providerConfigured }

  const repoRes = await provider.readRepository(installationId, repo)
  push('Repository access', repoRes.ok, repoRes.ok ? `default branch: ${repoRes.data.defaultBranch}` : (repoRes as { error: string }).error)
  const defaultBranch = repoRes.ok ? repoRes.data.defaultBranch : b.defaultBranch

  if (repoRes.ok) {
    push('Base branch allowlisted', isBranchAllowed(b, defaultBranch, 'target'), `branch: ${defaultBranch}`)
    const br = await provider.readBranch(installationId, repo, defaultBranch)
    push('Branch access', br.ok, br.ok ? `head: ${br.data.commit.slice(0, 7)}` : (br as { error: string }).error)
  }

  const ok = checks.every(c => c.ok)
  const discovered: DiscoveredConfig | undefined = repoRes.ok ? { installationId, repositoryOwner: repo.owner, repositoryNameOnly: repo.name, defaultBranch } : undefined
  return { ok, checks, providerConfigured, discovered }
}
