import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../../../_lib/session'
import { getBusiness, saveBusiness, listUpdates, listDeployments } from '../../../../../lib/platform/updates/store'
import type { PlatformBusiness, ReleaseChannel, UpdatePolicy, HealthStatus, BusinessStatus, AutomationMode } from '../../../../../lib/platform/updates/types'
import { parseRepoName } from '../../../../../lib/platform/automation/repo-identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const s = (v: unknown, max = 400): string | undefined => (typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined)
const CHANNELS: ReleaseChannel[] = ['internal', 'alpha', 'beta', 'stable', 'lts', 'custom']
const POLICIES: UpdatePolicy[] = ['manual', 'owner_approval', 'scheduled_manual', 'security_only', 'pinned', 'paused']
const HEALTH: HealthStatus[] = ['unknown', 'healthy', 'degraded', 'down']
const STATUSES: BusinessStatus[] = ['active', 'onboarding', 'paused', 'archived']
const MODES: AutomationMode[] = ['manual_prompt', 'automated_preparation', 'automated_preview', 'approved_production', 'fully_manual']

// GET — business + deployment history + which updates it's on/behind (via deployments).
export const GET = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const { id } = await params
  const biz = await getBusiness(id)
  if (!biz) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const [updates, deployments] = await Promise.all([listUpdates(), listDeployments()])
  const bizDeployments = deployments.filter((d) => d.businessId === id)
  const installedKeys = new Set(bizDeployments.filter((d) => d.status === 'deployed').flatMap((d) => d.updateKeys))
  const pendingUpdates = updates.filter((u) => u.status !== 'archived' && u.status !== 'cancelled' && !installedKeys.has(u.key))
  return NextResponse.json({ business: biz, deployments: bizDeployments, pendingUpdates })
})

// PATCH — owner controls. Every change is confirmed client-side + audited via updatedAt/notes.
export const PATCH = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const { id } = await params
  const biz = await getBusiness(id)
  if (!biz) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const f = (await req.json().catch(() => ({})))?.fields ?? {}

  const next: PlatformBusiness = { ...biz }
  if (CHANNELS.includes(f.releaseChannel)) next.releaseChannel = f.releaseChannel
  if (POLICIES.includes(f.updatePolicy)) next.updatePolicy = f.updatePolicy
  if (HEALTH.includes(f.healthStatus)) next.healthStatus = f.healthStatus
  if (STATUSES.includes(f.status)) next.status = f.status
  if (typeof f.updatesPaused === 'boolean') next.updatesPaused = f.updatesPaused
  if (typeof f.manualApprovalRequired === 'boolean') next.manualApprovalRequired = f.manualApprovalRequired
  if (typeof f.autoDeployAllowed === 'boolean') next.autoDeployAllowed = f.autoDeployAllowed // inert in Phase 1 (no auto-deploy exists)
  for (const k of ['name', 'industry', 'edition', 'defaultBranch', 'deployProject', 'productionUrl', 'healthEndpoint', 'currentVersion', 'currentCommit', 'latestVerifiedVersion', 'notes'] as const) {
    if (typeof f[k] === 'string') (next as Record<string, unknown>)[k] = s(f[k], 400)
  }
  // Repository identity is canonicalized on save: accept only "owner/name" (a GitHub URL is
  // normalized). Reject a bare name / URL / path / junk so bad data never reaches dispatch.
  // Persist the canonical repoName AND derive repositoryOwner/repositoryNameOnly in lockstep.
  if (typeof f.repoName === 'string' && f.repoName.trim()) {
    const ref = parseRepoName(f.repoName)
    if (!ref) return NextResponse.json({ error: 'invalid repository — use "owner/name" (e.g. ratchetnu/supercharged)' }, { status: 400 })
    next.repoName = `${ref.owner}/${ref.name}`
    next.repositoryOwner = ref.owner
    next.repositoryNameOnly = ref.name
    next.repoProvider = next.repoProvider ?? 'github'
  }
  // ── Automation / Preview configuration (for automated Preview pilots) ────────
  if (MODES.includes(f.automationMode)) next.automationMode = f.automationMode
  for (const k of ['previewDeploymentProvider', 'previewProjectId', 'productionProjectId', 'automationWorkflowFile'] as const) {
    if (typeof f[k] === 'string') (next as Record<string, unknown>)[k] = s(f[k], 200)
  }
  // previewRepoId is a numeric GitHub repo id — accept only digits (or clear it).
  if (typeof f.previewRepoId === 'string') {
    const v = f.previewRepoId.trim()
    if (v && !/^\d+$/.test(v)) return NextResponse.json({ error: 'previewRepoId must be the numeric GitHub repo id (digits only)' }, { status: 400 })
    next.previewRepoId = v || undefined
  }
  for (const k of ['requirePullRequest', 'requireOwnerApproval', 'requirePreview', 'requirePassingChecks', 'allowAutomatedMerge', 'allowProductionPromotion'] as const) {
    if (typeof f[k] === 'boolean') (next as Record<string, unknown>)[k] = f[k]
  }
  next.updatedAt = Date.now()
  await saveBusiness(next)
  return NextResponse.json({ ok: true, business: next })
})
