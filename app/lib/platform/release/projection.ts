// ── Business release projection (internal, read-only) ────────────────────────
//
// Assembles ONE calm per-Business view for Release Center by READING the systems that
// already own the data — Sync Status (drift/deployment/health/history), the updates
// registry (versions/edition), and automation state (in-flight update). It adds no
// store and duplicates no logic; it maps those signals into the tiny Version/Status/
// Update vocabulary via resolveReleaseState. Fail-soft: any read error yields an empty
// list rather than throwing. Nothing here is product-facing jargon.

import { listProducts, getLatest, listHistory } from '../sync/store'
import { listBusinesses } from '../updates/store'
import { listJobs } from '../automation/store'
import { resolveReleaseState, type JobPhase, type ReleaseSignals, type ReleaseState } from './state'
import { isBehind } from './versions'
import type { SyncProduct, ReconciliationRecord } from '../sync/types'
import type { PlatformBusiness } from '../updates/types'
import type { UpdateAutomationJob } from '../automation/types'

export type BusinessReleaseView = ReleaseState & {
  id: string
  name: string
  edition: string
  detail: {
    updateSummary: string
    previewStatus: string
    validationSummary: string
    history: { at: number; label: string }[]
    attention: string[]           // human, jargon-free — only when there's a problem
    lastCheckedAt?: number
    connection: 'Connected' | 'Not connected' | 'Not applicable'
  }
}

const FRIENDLY_TYPE: Record<string, string> = {
  platform_source: 'Platform', branded_clone: 'Branded edition', standalone: 'Standalone', library: 'Library', other: 'Business',
}

/** Map the (internal) automation job status to the collapsed phase the resolver reads. */
function jobPhase(status: string): JobPhase {
  switch (status) {
    case 'validating': case 'queued': case 'creating_branch': case 'applying_update': case 'testing': return 'running'
    case 'preview_deploying': return 'preview_deploying'
    case 'preview_ready': case 'preview': return 'preview_ready'
    case 'awaiting_owner_review': case 'owner_review': return 'awaiting_approval'
    case 'production': case 'verification': return 'promoting'
    case 'preview_failed': case 'merge_conflict': case 'commit_drift': case 'promotion_failed': case 'failed': return 'failed'
    default: return 'none'
  }
}

/**
 * Resolve the one automation phase that may influence the CURRENT release status.
 *
 * History is intentionally retained in the automation store, but an older failure must
 * not remain the current state forever. The newest job is authoritative, and a successful
 * reconciliation performed after a failed job supersedes that failure with live provider
 * state. Cancelled/completed jobs remain available in History without acting like active
 * failures on the Businesses dashboard.
 */
export function effectiveJobPhase(
  job: Pick<UpdateAutomationJob, 'status' | 'updatedAt'> | undefined,
  latestCheckedAt?: number,
): JobPhase {
  if (!job) return 'none'
  const phase = jobPhase(job.status)
  if (phase === 'none') return 'none'
  if (phase === 'failed' && latestCheckedAt != null && latestCheckedAt >= job.updatedAt) return 'none'
  return phase
}

function isInitialized(p: SyncProduct, biz: PlatformBusiness | undefined): boolean {
  if (p.status !== 'active') return false
  return !!(p.githubRepo || p.productionUrl || p.vercelProject || biz?.currentVersion)
}

/** Human, jargon-free drift notes (never "commit/config/migration drift"). Details-only. */
function attentionNotes(rec: ReconciliationRecord | null): string[] {
  if (!rec) return []
  const out: string[] = []
  if (rec.platformSync.applicable && rec.platformSync.state === 'attention' && !rec.platformSync.updateAvailable) {
    out.push('This business is behind the latest platform baseline.')
  }
  if (rec.deployment.applicable && rec.deployment.state === 'attention' && !rec.deployment.upToDate && rec.deployment.gitConnected) {
    out.push('A newer build is ready to go live.')
  }
  if (rec.deployment.health === 'down') out.push('The live site is not responding to health checks.')
  return out
}

function blockers(rec: ReconciliationRecord | null): string[] {
  if (!rec) return []
  const out: string[] = []
  // A provider error surfaces as a friendly "needs a connection" — never the raw message.
  if (rec.platformSync.error || rec.deployment.error) out.push('A service connection needs attention before this can update.')
  return out
}

function historyLabel(rec: ReconciliationRecord): string {
  if (rec.failed) return 'Check didn’t complete'
  if (rec.platformSync.applicable && rec.platformSync.updateAvailable) return 'Update available'
  if (rec.deployment.applicable && !rec.deployment.upToDate && rec.deployment.gitConnected) return 'New build ready'
  return 'Up to date'
}

function previewStatus(job: UpdateAutomationJob | undefined): string {
  if (!job) return 'No preview in progress'
  const p = jobPhase(job.status)
  if (p === 'running' || p === 'preview_deploying') return 'Preparing preview…'
  if (p === 'preview_ready') return job.previewUrl ? 'Preview ready to review' : 'Preview ready'
  if (p === 'awaiting_approval') return 'Preview verified — awaiting approval'
  if (p === 'promoting') return 'Publishing…'
  if (p === 'failed') return 'Last attempt didn’t finish'
  return 'No preview in progress'
}

/** Build the per-Business views. Owner-gated at the API layer; this is a pure read. */
export async function buildBusinessReleaseViews(): Promise<BusinessReleaseView[]> {
  let products: SyncProduct[] = []
  let businesses: PlatformBusiness[] = []
  let jobs: UpdateAutomationJob[] = []
  try { [products, businesses, jobs] = await Promise.all([listProducts(), listBusinesses(), listJobs()]) }
  catch { return [] }

  const bizById = new Map(businesses.map(b => [b.id, b]))
  const newestJobById = new Map<string, UpdateAutomationJob>()
  for (const j of jobs) {
    const prev = newestJobById.get(j.businessId)
    if (!prev || j.updatedAt > prev.updatedAt) newestJobById.set(j.businessId, j)
  }

  const views: BusinessReleaseView[] = []
  for (const p of products.filter(x => x.status !== 'archived')) {
    let rec: ReconciliationRecord | null = null
    let history: ReconciliationRecord[] = []
    try { rec = await getLatest(p.id); history = await listHistory(p.id, 5) } catch { /* fail-soft */ }

    const biz = bizById.get(p.id)
    const newestJob = newestJobById.get(p.id)
    const currentPhase = effectiveJobPhase(newestJob, rec?.checkedAt)
    const job = currentPhase === 'none' ? undefined : newestJob
    const ps = rec?.platformSync
    const dep = rec?.deployment

    const installedVersion = biz?.currentVersion || ps?.currentBaselineVersion
    const latestVersion = ps?.latestBaselineVersion || biz?.latestVerifiedVersion || installedVersion
    const updateAvailable = ps?.applicable ? ps.updateAvailable : isBehind(installedVersion, latestVersion)
    const health: ReleaseSignals['health'] = dep?.health
      ?? (biz?.healthStatus === 'healthy' ? 'healthy' : biz?.healthStatus === 'down' ? 'down' : biz?.healthStatus === 'degraded' ? 'degraded' : 'unknown')
    const attention = attentionNotes(rec)
    const blocking = blockers(rec)

    const signals: ReleaseSignals = {
      initialized: isInitialized(p, biz),
      installedVersion, latestVersion, health, updateAvailable,
      job: currentPhase,
      previewVerified: false,
      verificationFailed: currentPhase === 'failed',
      blocking,
      driftReasons: attention,
      lastUpdatedAt: Math.max(biz?.lastDeploymentAt ?? 0, dep?.deployedAt ?? 0, rec?.checkedAt ?? 0) || undefined,
    }
    const rs = resolveReleaseState(signals)

    const edition = biz?.edition || FRIENDLY_TYPE[p.productType] || 'Business'
    const connection: BusinessReleaseView['detail']['connection'] =
      !p.supportsPlatformSync && !p.supportsDeploymentTracking ? 'Not applicable'
      : rec && !rec.failed ? 'Connected' : 'Not connected'

    const updateSummary =
      rs.status === 'not_initialized' ? 'This business isn’t set up yet.'
      : rs.status === 'action_required' ? (attention[0] || blocking[0] || 'Something needs your attention.')
      : updateAvailable ? (rs.latestVersion !== '—' ? `A newer version (${rs.latestVersion}) is available.` : 'A newer version is available.')
      : rs.status === 'ready_to_publish' ? 'A verified preview is ready to publish.'
      : rs.status === 'updating' ? 'An update is in progress.'
      : 'You’re on the latest version.'

    const validationSummary =
      !rec ? 'Not checked yet'
      : rec.failed ? 'Couldn’t complete the last check'
      : (ps?.state === 'attention' || dep?.state === 'attention') ? 'Needs attention'
      : 'All checks passing'

    views.push({
      ...rs, id: p.id, name: p.displayName, edition,
      detail: {
        updateSummary,
        previewStatus: previewStatus(job),
        validationSummary,
        history: history.map(h => ({ at: h.checkedAt, label: historyLabel(h) })),
        attention: [...blocking, ...attention],
        lastCheckedAt: rec?.checkedAt,
        connection,
      },
    })
  }

  // Calmest ordering: things needing attention first, then updatable, then the rest.
  const rank = (v: BusinessReleaseView) =>
    v.tone === 'critical' ? 0 : v.status === 'update_available' ? 1 : v.status === 'not_initialized' ? 2 : 3
  return views.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}
