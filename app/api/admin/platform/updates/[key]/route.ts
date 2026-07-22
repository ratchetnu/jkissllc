import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner, getPrincipal } from '../../../_lib/session'
import {
  getUpdate, saveUpdate, getBusiness, listCompat, saveCompat,
  listDeploymentsForUpdate, getDeployment, saveDeployment, nextDeploymentId,
} from '../../../../../lib/platform/updates/store'
import { canTransitionUpdate, canMarkVerified } from '../../../../../lib/platform/updates/policy'
import { buildDeploymentPrompt } from '../../../../../lib/platform/updates/prompt'
import { PLATFORM_UPDATE_VERSION, type UpdateStatus, type CheckStatus, type CompatStatus, type DeploymentRecord, type DeploymentStatus } from '../../../../../lib/platform/updates/types'
import { isSafeRepoPath } from '../../../../../lib/platform/automation/manifest'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const s = (v: unknown, max = 4000): string | undefined => (typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined)
const CHECKS: CheckStatus[] = ['unknown', 'passed', 'failed', 'skipped', 'not_applicable']

// GET — update + compatibility + deployment coverage.
export const GET = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ key: string }> }) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const { key } = await params
  const update = await getUpdate(key)
  if (!update) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const [compat, deployments] = await Promise.all([listCompat(key), listDeploymentsForUpdate(key)])
  return NextResponse.json({ update, compat, deployments })
})

// PATCH — owner actions. Approvals/verifications are NEVER auto-set.
export const PATCH = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ key: string }> }) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const { key } = await params
  const update = await getUpdate(key)
  if (!update) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const body = await req.json().catch(() => ({}))
  const action: string = body.action ?? 'edit'
  const actor = (await getPrincipal(req))?.sub || 'owner'
  const now = Date.now()

  switch (action) {
    case 'edit': {
      const f = body.fields ?? {}
      const STR: (keyof typeof update)[] = ['title', 'summary', 'description', 'customerImpact', 'technicalImpact', 'module', 'sourceCommit', 'sourceBranch', 'sourceRepo', 'sourceDeploymentId', 'pullRequest', 'risks', 'limitations', 'exclusions', 'ownerNotes']
      for (const k of STR) if (typeof f[k] === 'string') (update as Record<string, unknown>)[k] = s(f[k], 8000)
      const BOOL: (keyof typeof update)[] = ['breakingChange', 'migrationRequired', 'environmentChangeRequired', 'secretRequired', 'featureFlagRequired', 'manualPortRequired', 'rollbackSupported']
      for (const k of BOOL) if (typeof f[k] === 'boolean') (update as Record<string, unknown>)[k] = f[k]
      for (const k of ['type', 'scope', 'severity', 'priority'] as const) if (typeof f[k] === 'string') (update as Record<string, unknown>)[k] = f[k]
      break
    }
    case 'set-validation': {
      const check = s(body.check, 40) as keyof typeof update.validation
      const value = body.value as CheckStatus
      if (!(check in update.validation) || !CHECKS.includes(value)) return NextResponse.json({ error: 'bad validation input' }, { status: 400 })
      update.validation = { ...update.validation, [check]: value }
      break
    }
    case 'set-status': {
      const to = body.status as UpdateStatus
      if (!canTransitionUpdate(update.status, to)) return NextResponse.json({ error: `cannot move ${update.status} → ${to}` }, { status: 400 })
      update.status = to
      break
    }
    case 'approve': {
      if (update.status === 'archived') return NextResponse.json({ error: 'archived update cannot be approved' }, { status: 400 })
      update.status = 'approved'; update.approvedBy = actor; update.approvedAt = now
      break
    }
    case 'block': { update.status = 'blocked'; if (s(body.reason, 2000)) update.ownerNotes = `${update.ownerNotes ? update.ownerNotes + '\n' : ''}[blocked] ${s(body.reason, 2000)}`; break }
    case 'archive': { update.status = 'archived'; break }
    case 'assess-compat': {
      const businessId = s(body.businessId, 60)
      if (!businessId || !(await getBusiness(businessId))) return NextResponse.json({ error: 'unknown business' }, { status: 400 })
      const rawPaths = body.pathsToExclude
      if (rawPaths !== undefined && (!Array.isArray(rawPaths) || rawPaths.length > 40 || rawPaths.some((x: unknown) => typeof x !== 'string' || !isSafeRepoPath(x.trim())))) {
        return NextResponse.json({ error: 'pathsToExclude must contain at most 40 exact repository-relative paths' }, { status: 400 })
      }
      const pathsToExclude = Array.isArray(rawPaths) ? [...new Set(rawPaths.map((x: string) => x.trim()))] : undefined
      await saveCompat({
        recordVersion: PLATFORM_UPDATE_VERSION, updateKey: key, businessId,
        status: (body.status as CompatStatus) ?? 'under_review', reason: s(body.reason, 2000),
        manualPortRequired: body.manualPortRequired === true, codeReconciliationRequired: body.codeReconciliationRequired === true,
        migrationRequired: body.migrationRequired === true, configurationRequired: body.configurationRequired === true,
        secretRequired: body.secretRequired === true, featureFlagRequired: body.featureFlagRequired === true,
        brandingChangesRequired: body.brandingChangesRequired === true, dataModelChangesRequired: body.dataModelChangesRequired === true,
        componentsToExclude: Array.isArray(body.componentsToExclude) ? body.componentsToExclude.filter((x: unknown) => typeof x === 'string').slice(0, 40) : undefined,
        pathsToExclude,
        blockingIssues: s(body.blockingIssues, 2000),
        overrideReason: s(body.overrideReason, 2000), // required to force a compatible status past a blocker (owner judgment)
        assessedBy: actor, createdAt: now, updatedAt: now,
      })
      update.updatedAt = now; await saveUpdate(update)
      return NextResponse.json({ ok: true, compat: await listCompat(key) })
    }
    case 'generate-prompt': {
      const targetId = s(body.targetBusinessId, 60)
      const target = targetId ? await getBusiness(targetId) : null
      const source = await getBusiness(update.sourceBusinessId ?? 'jkiss')
      if (!target || !source) return NextResponse.json({ error: 'source/target business not found' }, { status: 400 })
      const compat = (await listCompat(key)).filter((c) => c.businessId === targetId)
      const prompt = buildDeploymentPrompt({ updates: [update], source, target, compat })
      return NextResponse.json({ ok: true, prompt })
    }
    case 'record-deployment': {
      const businessId = s(body.businessId, 60)
      if (!businessId || !(await getBusiness(businessId))) return NextResponse.json({ error: 'unknown business' }, { status: 400 })
      const id = await nextDeploymentId()
      const dep: DeploymentRecord = {
        recordVersion: PLATFORM_UPDATE_VERSION, id, businessId, updateKeys: [key],
        releaseVersion: s(body.releaseVersion, 40), repo: s(body.repo, 200), branch: s(body.branch, 120),
        sourceCommit: update.sourceCommit, targetCommit: s(body.targetCommit, 80), provider: s(body.provider, 60),
        deploymentId: s(body.deploymentId, 120), deploymentUrl: s(body.deploymentUrl, 300), environment: s(body.environment, 40) ?? 'production',
        status: (body.status as DeploymentStatus) ?? 'requested',
        buildStatus: CHECKS.includes(body.buildStatus) ? body.buildStatus : 'unknown',
        healthCheckStatus: CHECKS.includes(body.healthCheckStatus) ? body.healthCheckStatus : 'unknown',
        smokeTestStatus: CHECKS.includes(body.smokeTestStatus) ? body.smokeTestStatus : 'unknown',
        verificationStatus: 'pending', rollbackAvailable: body.rollbackAvailable === true, previousCommit: s(body.previousCommit, 80),
        errorCategory: s(body.errorCategory, 60), errorSummary: s(body.errorSummary, 2000), notes: s(body.notes, 2000),
        initiatedBy: actor, createdAt: now, updatedAt: now,
      }
      await saveDeployment(dep)
      return NextResponse.json({ ok: true, deployment: dep })
    }
    case 'verify-deployment': {
      const depId = s(body.deploymentId, 40)
      const dep = depId ? await getDeployment(depId) : null
      if (!dep) return NextResponse.json({ error: 'deployment not found' }, { status: 404 })
      const waive = s(body.waiveReason, 2000)
      if (!canMarkVerified(dep, waive)) return NextResponse.json({ error: 'verification gates not met — pass build+health (+smoke) or waive with a reason' }, { status: 400 })
      dep.verificationStatus = waive && !(dep.buildStatus === 'passed' && dep.healthCheckStatus === 'passed') ? 'waived' : 'passed'
      dep.verificationWaivedReason = waive
      dep.status = 'deployed'; dep.verifiedBy = actor; dep.verifiedAt = now; dep.updatedAt = now
      await saveDeployment(dep)
      return NextResponse.json({ ok: true, deployment: dep })
    }
    default:
      return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  }

  update.updatedAt = now
  await saveUpdate(update)
  return NextResponse.json({ ok: true, update })
})
