import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../../lib/platform/tenancy/with-tenant-route'
import { getPrincipal, requirePlatformOwner } from '../../../_lib/session'
import {
  getBusiness, getCompatMap, getReleasePackage, listReleasePackages, listUpdates,
  saveReadyReleasePackage,
} from '../../../../../lib/platform/updates/store'
import { recordPlatformAudit } from '../../../../../lib/platform/updates/audit'
import { evaluateReleasePackageReadiness } from '../../../../../lib/platform/release/release-package'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withTenantRoute(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const record = await getReleasePackage((await params).id)
  return record
    ? NextResponse.json({ package: record })
    : NextResponse.json({ error: 'not_found' }, { status: 404 })
})

export const PATCH = withTenantRoute(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const record = await getReleasePackage((await params).id)
  if (!record) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const body = await req.json().catch(() => ({}))
  if (body.action !== 'mark-ready') return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  if (record.status !== 'draft' && record.status !== 'blocked') {
    return NextResponse.json({ error: `cannot mark ${record.status} ready` }, { status: 409 })
  }

  const [business, updates, packages, compatibilityMaps] = await Promise.all([
    getBusiness(record.targetProduct),
    listUpdates(500),
    listReleasePackages(500),
    Promise.all(record.updateKeys.map((key) => getCompatMap(key))),
  ])
  const compatibilityByUpdate = Object.fromEntries(
    record.updateKeys.map((key, index) => [key, compatibilityMaps[index][record.targetProduct]]),
  )
  const now = Date.now()
  const readiness = evaluateReleasePackageReadiness({
    draft: record,
    business,
    updates,
    compatibilityByUpdate,
    existingPackages: packages.filter((p) => p.id !== record.id),
    now,
  })
  if (!readiness.ok || !readiness.snapshot || !readiness.normalizedVersion || !business) {
    return NextResponse.json({ error: 'release package is not ready', readiness }, { status: 409 })
  }

  const actor = (await getPrincipal(req))?.sub || 'owner'
  const ready = {
    ...record,
    proposedVersion: readiness.normalizedVersion,
    status: 'ready_for_approval' as const,
    blockingReasons: [],
    policySnapshot: readiness.snapshot,
    readyBy: actor,
    readyAt: now,
    updatedAt: now,
  }
  const result = await saveReadyReleasePackage(ready, record.updatedAt, business.updatedAt)
  if (result !== 'saved') {
    const status = result === 'duplicate' ? 409 : 412
    return NextResponse.json({ error: result }, { status })
  }
  await recordPlatformAudit({
    actor, actorType: 'owner', source: 'release-package-api', action: 'release_package.ready',
    businessId: ready.targetProduct, releaseVersion: ready.proposedVersion,
    priorStatus: record.status, newStatus: ready.status,
    summary: `${ready.id} passed release policy and is ready for approval`,
  })
  return NextResponse.json({ ok: true, package: ready, readiness })
})
