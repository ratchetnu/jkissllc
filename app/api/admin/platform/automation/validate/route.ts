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

  // Record the validation outcome (metadata only). Ready requires connection + a preview
  // project + a workflow file so preflight can later pass.
  business.lastVerificationAt = Date.now()
  business.configurationStatus = result.ok && !!business.previewProjectId && !!business.automationWorkflowFile ? 'ready' : result.ok ? 'incomplete' : 'error'
  if (result.defaultBranch) business.defaultBranch = result.defaultBranch
  business.updatedAt = Date.now()
  await saveBusiness(business)

  return NextResponse.json({ ok: result.ok, checks: result.checks, configurationStatus: business.configurationStatus })
})
