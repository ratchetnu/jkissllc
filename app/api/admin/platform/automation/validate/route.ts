import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../../../_lib/session'
import { getBusiness, saveBusiness } from '../../../../../lib/platform/updates/store'
import { validateGithubConnection } from '../../../../../lib/platform/automation/github-validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST — "Validate GitHub Connection". Owner only. READ-ONLY: authenticates the App and
// checks repo/branch access without mutating the repository. Records the outcome on the
// business (configurationStatus + last validation). Never returns tokens or secrets.
export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({}))
  const businessId = typeof body.businessId === 'string' ? body.businessId : ''
  const business = await getBusiness(businessId)
  if (!business) return NextResponse.json({ error: 'unknown business' }, { status: 400 })

  const result = await validateGithubConnection(business)

  // Persist the discovered GitHub metadata (installation id, repo owner/name, branch) so
  // the business record is auto-configured. Ready still requires a preview project + a
  // workflow file so preflight can later pass.
  const now = Date.now()
  if (result.discovered) {
    const d = result.discovered
    business.githubInstallationId = d.installationId
    business.repositoryOwner = d.repositoryOwner
    business.repositoryNameOnly = d.repositoryNameOnly
    business.repoName = d.repoName          // keep the canonical owner/name in sync
    business.defaultBranch = d.defaultBranch
    if (!business.allowedTargetBranches?.length) business.allowedTargetBranches = [d.defaultBranch]
    if (!business.automationWorkflowFile) business.automationWorkflowFile = 'operion-update.yml'
    business.repoProvider = 'github'
  }
  business.lastVerificationAt = now
  business.configurationStatus = result.ok && !!business.previewProjectId && !!business.automationWorkflowFile ? 'ready' : result.ok ? 'incomplete' : 'error'
  business.updatedAt = now
  await saveBusiness(business)

  return NextResponse.json({ ok: result.ok, checks: result.checks, configurationStatus: business.configurationStatus, installationDiscovered: !!result.discovered })
})
