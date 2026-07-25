import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { getPrincipal, requirePlatformOwner } from '../../_lib/session'
import {
  getBusiness, getUpdate, listReleasePackages, nextReleasePackageId, saveReleasePackage,
} from '../../../../lib/platform/updates/store'
import { recordPlatformAudit } from '../../../../lib/platform/updates/audit'
import type { ReleasePackage } from '../../../../lib/platform/updates/types'
import type { ChangeClassification, MigrationClassification } from '../../../../lib/platform/release/semver-policy'
import type { ReleaseChannel } from '../../../../lib/platform/release/versions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CHANNELS: ReleaseChannel[] = ['internal', 'alpha', 'beta', 'stable', 'lts']
const CLASSIFICATIONS: ChangeClassification[] = [
  'fix', 'ui', 'tests', 'observability', 'documentation', 'capability', 'workflow', 'breaking',
]
const MIGRATIONS: MigrationClassification[] = ['none', 'compatible', 'incompatible']
const text = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  return NextResponse.json({ packages: await listReleasePackages() })
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({}))
  const targetProduct = text(body.targetProduct, 60)
  const proposedVersion = text(body.proposedVersion, 40)
  const channel = body.channel as ReleaseChannel
  const classification = body.classification as ChangeClassification
  const migration = body.migration as MigrationClassification
  if (!targetProduct || !(await getBusiness(targetProduct))) return NextResponse.json({ error: 'unknown target product' }, { status: 400 })
  if (!proposedVersion) return NextResponse.json({ error: 'proposedVersion is required' }, { status: 400 })
  if (!CHANNELS.includes(channel)) return NextResponse.json({ error: 'invalid release channel' }, { status: 400 })
  if (!CLASSIFICATIONS.includes(classification)) return NextResponse.json({ error: 'invalid change classification' }, { status: 400 })
  if (!MIGRATIONS.includes(migration)) return NextResponse.json({ error: 'invalid migration classification' }, { status: 400 })
  if (!Array.isArray(body.updateKeys) || body.updateKeys.length < 1 || body.updateKeys.length > 100) {
    return NextResponse.json({ error: 'updateKeys must contain 1–100 update keys' }, { status: 400 })
  }
  const rawUpdateKeys = body.updateKeys as unknown[]
  const updateKeys: string[] = [...new Set(
    rawUpdateKeys
      .map((v: unknown) => text(v, 40))
      .filter((v: string | undefined): v is string => !!v),
  )]
  if (updateKeys.length !== body.updateKeys.length) return NextResponse.json({ error: 'updateKeys must be unique non-empty strings' }, { status: 400 })
  const updates = await Promise.all(updateKeys.map((key) => getUpdate(key)))
  if (updates.some((u) => !u)) return NextResponse.json({ error: 'one or more updates do not exist' }, { status: 400 })

  const actor = (await getPrincipal(req))?.sub || 'owner'
  const now = Date.now()
  const record: ReleasePackage = {
    recordVersion: 1,
    id: await nextReleasePackageId(),
    targetProduct,
    proposedVersion,
    channel,
    classification,
    breakingChange: body.breakingChange === true || updates.some((u) => u?.breakingChange),
    migration,
    updateKeys,
    name: text(body.name, 200),
    releaseNotes: text(body.releaseNotes, 8000),
    status: 'draft',
    blockingReasons: [],
    createdBy: actor,
    createdAt: now,
    updatedAt: now,
  }
  await saveReleasePackage(record)
  await recordPlatformAudit({
    actor, actorType: 'owner', source: 'release-package-api', action: 'release_package.created',
    businessId: targetProduct, releaseVersion: proposedVersion, newStatus: 'draft',
    summary: `${record.id} created as a draft for ${targetProduct}`,
  })
  return NextResponse.json({ ok: true, package: record }, { status: 201 })
})
