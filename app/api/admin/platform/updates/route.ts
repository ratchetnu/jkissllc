import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner, getPrincipal } from '../../_lib/session'
import { listUpdates, saveUpdate, nextUpdateKey, getBusiness } from '../../../../lib/platform/updates/store'
import { computeUpdateKpis } from '../../../../lib/platform/updates/policy'
import { PLATFORM_UPDATE_VERSION, type PlatformUpdate, type ValidationChecklist } from '../../../../lib/platform/updates/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const s = (v: unknown, max = 4000): string | undefined => (typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined)
const b = (v: unknown): boolean => v === true
const BLANK_VALIDATION: ValidationChecklist = {
  typecheck: 'unknown', lint: 'unknown', tests: 'unknown', build: 'unknown', securityReview: 'unknown',
  accessibilityReview: 'unknown', e2e: 'unknown', smokeTest: 'unknown', ownerVerification: 'unknown',
}

// GET /api/admin/platform/updates — list + KPIs. Platform-owner only.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const updates = await listUpdates()
  return NextResponse.json({ updates, kpis: computeUpdateKpis(updates, Date.now()) })
})

// POST /api/admin/platform/updates — register a new update. Never auto-approved.
export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({}))
  const title = s(body.title, 200)
  if (!title) return NextResponse.json({ error: 'Title is required.' }, { status: 400 })
  const actor = (await getPrincipal(req))?.sub || 'owner'
  const now = Date.now()
  const key = await nextUpdateKey()
  const u: PlatformUpdate = {
    recordVersion: PLATFORM_UPDATE_VERSION, key,
    title, summary: s(body.summary, 1000) ?? title, description: s(body.description, 8000),
    customerImpact: s(body.customerImpact, 2000), technicalImpact: s(body.technicalImpact, 2000),
    type: body.type ?? 'feature', scope: body.scope ?? 'platform_core',
    severity: body.severity ?? 'medium', priority: body.priority ?? 'normal',
    status: 'discovered', // NEVER auto-approved on registration
    module: s(body.module, 120),
    sourceBusinessId: s(body.sourceBusinessId, 60) ?? 'jkiss', sourceRepo: s(body.sourceRepo, 200),
    sourceBranch: s(body.sourceBranch, 120), sourceCommit: s(body.sourceCommit, 80),
    sourceDeploymentId: s(body.sourceDeploymentId, 120), pullRequest: s(body.pullRequest, 200),
    breakingChange: b(body.breakingChange), migrationRequired: b(body.migrationRequired),
    environmentChangeRequired: b(body.environmentChangeRequired), secretRequired: b(body.secretRequired),
    featureFlagRequired: b(body.featureFlagRequired), manualPortRequired: b(body.manualPortRequired),
    rollbackSupported: b(body.rollbackSupported),
    requiredModules: Array.isArray(body.requiredModules) ? body.requiredModules.filter((x: unknown) => typeof x === 'string').slice(0, 40) : undefined,
    validation: BLANK_VALIDATION, risks: s(body.risks, 2000), limitations: s(body.limitations, 2000),
    exclusions: s(body.exclusions, 2000), ownerNotes: s(body.ownerNotes, 4000),
    createdBy: actor, createdAt: now, updatedAt: now,
  }
  // Derive the source repo from the source business when not given — commit transfer reads
  // files from this repo at sourceCommit, so the update must carry it.
  if (!u.sourceRepo && u.sourceBusinessId) {
    const sb = await getBusiness(u.sourceBusinessId)
    if (sb?.repoName) u.sourceRepo = sb.repoName
  }
  await saveUpdate(u)
  return NextResponse.json({ ok: true, update: u })
})
