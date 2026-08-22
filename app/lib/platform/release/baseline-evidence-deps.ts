// ── Live wiring for baseline evidence (server-only) ─────────────────────────
//
// Every dependency here is a READ. The collector in baseline-evidence.ts is pure
// orchestration over these, so it can be tested exhaustively without a network while
// this file stays a thin, obvious adapter.

import { createHash } from 'node:crypto'
import type { PlatformBusiness, BaselineFlagEvidence, BaselineSchemaEvidence } from '../updates/types'
import type { BaselineEvidenceDeps, RepoRef } from './baseline-evidence'
import { readCurrentProductionDeployment } from './production-deployment'
import { GitHubActionsProvider } from '../automation/github-provider'
import { resolveTenantCapabilities } from '../capabilities/tenant-profile-store'
import { listDeployments } from '../updates/store'

/** A stable fingerprint of the capability set we actually detected. */
export function capabilityManifestHash(capabilities: { id: string; evidence: string }[]): string {
  const stable = capabilities.map((c) => `${c.id}=${c.evidence}`).sort().join('\n')
  return `sha256:${createHash('sha256').update(stable).digest('hex')}`
}

export function liveBaselineEvidenceDeps(business: PlatformBusiness): BaselineEvidenceDeps {
  const github = new GitHubActionsProvider()
  const installation = business.githubInstallationId

  return {
    readProduction: (b) => readCurrentProductionDeployment(b),

    // The repository is the ONLY authority for what a commit identifier means. Without a
    // GitHub App installation there is no authority, so this returns null and the
    // collector fails closed rather than trusting an abbreviation.
    readCommit: async (repo: RepoRef, sha: string) => {
      if (!installation) return null
      const r = await github.readCommit(installation, repo, sha)
      return r.ok && r.data?.sha ? { sha: r.data.sha, message: r.data.message } : null
    },
    readBranch: async (repo: RepoRef, branch: string) => {
      if (!installation) return null
      const r = await github.readBranch(installation, repo, branch)
      return r.ok && r.data?.commit ? { commit: r.data.commit } : null
    },

    fetchHealth: async (url: string) => {
      try {
        const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(8000) })
        const text = await res.text().catch(() => '')
        let build: string | undefined
        try { build = (JSON.parse(text) as { build?: string }).build } catch { /* not JSON — fine */ }
        return { ok: res.ok, status: res.status, build, body: text.slice(0, 500) }
      } catch { return null }
    },

    // Capabilities come from the tenant's own resolved profile — what the business has
    // chosen and what its providers can actually do — never from a guess about the code.
    readCapabilities: async (b) => {
      const resolved = await resolveTenantCapabilities(b.id).catch(() => null)
      if (!resolved || !resolved.initialized) return null
      // `operational` is the honest axis: the capability is installed, enabled by this
      // tenant, and its provider is actually configured. Anything less is not something
      // the business is running today.
      const capabilities = Object.values(resolved.capabilities)
        .filter((c) => c?.operational)
        .map((c) => ({ id: c.id, evidence: `${c.displayName}: ${c.state}` }))
      if (!capabilities.length) return null
      return { manifestHash: capabilityManifestHash(capabilities), capabilities }
    },

    // A migration state Operion can stand behind: the most recent verified deployment
    // record for this business carries whether its migrations were applied. Unknown when
    // no verified deployment exists — never assumed clean.
    readSchemaState: async (b): Promise<BaselineSchemaEvidence | null> => {
      const all = await listDeployments(200).catch(() => [])
      const latest = all
        .filter((d) => d.businessId === b.id && d.verificationStatus === 'passed')
        .sort((a, c) => (c.verifiedAt ?? 0) - (a.verifiedAt ?? 0))[0]
      // No verified deployment ⇒ genuinely unknown. Never assumed clean: "we have not
      // checked" and "there is nothing to apply" are different answers, and only one of
      // them is safe to record as provenance.
      if (!latest) return null
      return {
        state: 'verified',
        evidence: `deployment ${latest.id} verified${latest.verifiedAt ? ` at ${new Date(latest.verifiedAt).toISOString()}` : ''}`,
      }
    },

    // Release-relevant switches for this business, read from the resolved profile's
    // provider availability rather than from process env (which describes THIS app).
    readFlagState: async (b): Promise<BaselineFlagEvidence | null> => {
      const resolved = await resolveTenantCapabilities(b.id).catch(() => null)
      if (!resolved || !resolved.initialized) return null
      const flags: Record<string, boolean> = {}
      for (const [id, available] of Object.entries(resolved.providers)) flags[id] = !!available
      return { assessed: true, flags }
    },
  }
}
