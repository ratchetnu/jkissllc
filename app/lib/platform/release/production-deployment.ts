// ── Operion Release Center — current production deployment (server-only, READ) ──
//
// Increment 3B.4 fix. The promotion eligibility engine needs the CURRENT production
// deployment id to clear `PRODUCTION_DEPLOYMENT_UNKNOWN` / `ROLLBACK_TARGET_MISSING` /
// `AUDIT_CONTEXT_MISSING`. Without it, eligibility is permanently false, so the approval
// and publish gates (which require `eligibility.eligible`) can NEVER pass — the whole
// controlled-publish workflow is inert. This ONE read-only helper resolves that id from
// the live Vercel production deployment and is shared by the approval / publish /
// publish-review routes so there is a single eligibility-snapshot path (no second path,
// no fabricated data). It performs GETs only — no promote/redeploy/alias/mutation.

import { getPreviewProvider, type VercelProviderDeps } from '../automation/vercel-provider'

export type CurrentProductionDeployment = {
  deploymentId: string
  commit?: string
  url?: string
  deployedAt?: number
}

/**
 * The current READY Vercel production deployment for a business's mapped project, or null
 * when no project is mapped, Vercel is not configured, or none is found. Fail-soft: never
 * throws — a null result simply leaves eligibility's production checks unsatisfied (exactly
 * as before this fix), so the gates stay safe rather than falsely eligible.
 */
export async function readCurrentProductionDeployment(
  business: { productionProjectId?: string; deployProject?: string } | null | undefined,
  env: Record<string, string | undefined> = process.env,
  deps: VercelProviderDeps = {},
): Promise<CurrentProductionDeployment | null> {
  const project = business?.productionProjectId || business?.deployProject
  if (!project) return null
  const vercel = getPreviewProvider(env, deps)
  if (!vercel.configured) return null
  const r = await vercel.readProductionForReview(project)
  if (!r.ok || !r.data) return null
  return { deploymentId: r.data.deploymentId, commit: r.data.commitSha, url: r.data.url, deployedAt: r.data.createdAt ?? r.data.readyAt }
}
