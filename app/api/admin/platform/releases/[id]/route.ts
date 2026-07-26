import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../../lib/platform/tenancy/with-tenant-route'
import { getPrincipal, requirePlatformOwner } from '../../../_lib/session'
import {
  getBusiness, getCompatMap, getReleasePackage, getUpdate, listReleasePackages,
  saveApprovedReleasePackage, saveReadyReleasePackage,
} from '../../../../../lib/platform/updates/store'
import { recordPlatformAudit } from '../../../../../lib/platform/updates/audit'
import {
  evaluateReleasePackageReadiness, releasePackageApprovalPhrase,
} from '../../../../../lib/platform/release/release-package'
import type { ReleasePackage } from '../../../../../lib/platform/updates/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function currentReadiness(record: ReleasePackage) {
  const [business, selectedUpdates, packages, compatibilityMaps] = await Promise.all([
    getBusiness(record.targetProduct),
    Promise.all(record.updateKeys.map((key) => getUpdate(key))),
    listReleasePackages(500),
    Promise.all(record.updateKeys.map((key) => getCompatMap(key))),
  ])
  const updates = selectedUpdates.filter((update) => update !== null)
  const compatibilityByUpdate = Object.fromEntries(
    record.updateKeys.map((key, index) => [key, compatibilityMaps[index][record.targetProduct]]),
  )
  const readiness = evaluateReleasePackageReadiness({
    draft: record,
    business,
    updates,
    compatibilityByUpdate,
    existingPackages: packages.filter((p) => p.id !== record.id),
    now: Date.now(),
  })
  return { business, updates, compatibilityByUpdate, readiness }
}

export const GET = withTenantRoute(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const record = await getReleasePackage((await params).id)
  return record
    ? NextResponse.json({
      package: record,
      approval: record.status === 'ready_for_approval'
        ? { requiredPhrase: releasePackageApprovalPhrase(record) }
        : null,
    })
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
  if (body.action !== 'mark-ready' && body.action !== 'approve') {
    return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  }

  if (body.action === 'approve') {
    const requiredPhrase = releasePackageApprovalPhrase(record)
    if (body.phrase !== requiredPhrase) {
      return NextResponse.json({ error: 'confirmation phrase does not match', requiredPhrase }, { status: 400 })
    }
    if (record.status === 'approved') {
      return NextResponse.json({ ok: true, idempotent: true, package: record })
    }
    if (record.status !== 'ready_for_approval') {
      return NextResponse.json({ error: `cannot approve ${record.status} package` }, { status: 409 })
    }
    if (!record.policySnapshot || !record.readyAt || !record.readyBy) {
      return NextResponse.json({ error: 'package has no readiness evidence; run readiness again' }, { status: 409 })
    }

    const { business, updates, compatibilityByUpdate, readiness } = await currentReadiness(record)
    if (!readiness.ok || !readiness.snapshot || !readiness.normalizedVersion || !business) {
      return NextResponse.json({ error: 'release package is no longer ready', readiness }, { status: 409 })
    }
    const updatesByKey = new Map(updates.map((update) => [update.key, update]))
    const evidence = record.updateKeys.flatMap((key) => {
      const update = updatesByKey.get(key)
      const compatibility = compatibilityByUpdate[key]
      return update && compatibility ? [{
        updateKey: key,
        updateUpdatedAt: update.updatedAt,
        compatibilityUpdatedAt: compatibility.updatedAt,
      }] : []
    })
    if (evidence.length !== record.updateKeys.length) {
      return NextResponse.json({ error: 'approval evidence changed; run readiness again' }, { status: 409 })
    }

    const actor = (await getPrincipal(req))?.sub || 'owner'
    const now = Date.now()
    const approved = {
      ...record,
      status: 'approved' as const,
      approvalSnapshot: readiness.snapshot,
      approvedBy: actor,
      approvedAt: now,
      updatedAt: now,
    }
    const result = await saveApprovedReleasePackage(
      approved,
      record.updatedAt,
      business.updatedAt,
      evidence,
    )
    if (result !== 'saved') {
      const status = result === 'invalid_status' ? 409 : 412
      return NextResponse.json({ error: result }, { status })
    }
    await recordPlatformAudit({
      actor, actorType: 'owner', source: 'release-package-api', action: 'release_package.approved',
      businessId: approved.targetProduct, releaseVersion: approved.proposedVersion,
      priorStatus: record.status, newStatus: approved.status,
      summary: `${approved.id} approved as an immutable release package; no rollout was started`,
    })
    return NextResponse.json({ ok: true, idempotent: false, package: approved, readiness })
  }

  if (record.status !== 'draft' && record.status !== 'blocked') {
    return NextResponse.json({ error: `cannot mark ${record.status} ready` }, { status: 409 })
  }

  const { business, readiness } = await currentReadiness(record)
  const now = Date.now()
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
