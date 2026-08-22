import { NextRequest, NextResponse } from 'next/server'
import { verifyCallback } from '../../../lib/platform/automation/callback'
import { recordPlatformAudit } from '../../../lib/platform/updates/audit'
import { discoveryMatchesSourceBusiness, discoveredUpdateFromGitHub, validateGitHubDiscoveryPayload } from '../../../lib/platform/updates/discovery'
import { listBusinesses, nextUpdateKey, saveDiscoveredUpdate } from '../../../lib/platform/updates/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GitHub main-branch discovery. Machine-to-machine and deliberately separate from the
// owner API: a SOURCE-ONLY HMAC secret proves the caller, while the registered source
// business binds repository + branch. Target repositories deliberately never receive
// OPERION_DISCOVERY_SECRET (the callback secret is shared with targets and is therefore
// insufficient for this boundary). The only
// permitted effect is a status=discovered update. Approval and publishing remain in
// their existing owner-gated routes.
export async function POST(req: NextRequest) {
  const raw = await req.text()
  const verified = verifyCallback(
    raw,
    req.headers.get('x-operion-timestamp'),
    req.headers.get('x-operion-signature'),
    process.env.OPERION_DISCOVERY_SECRET,
    Date.now(),
  )
  if (!verified.ok) return NextResponse.json({ error: 'unauthorized', reason: verified.reason }, { status: 401 })

  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }) }
  const validation = validateGitHubDiscoveryPayload(parsed)
  if (!validation.ok) return NextResponse.json({ error: 'invalid payload', reason: validation.reason }, { status: 400 })
  const payload = validation.value

  const businesses = await listBusinesses()
  const repositorySource = businesses.find((business) =>
    (business.role === 'source' || business.role === 'source_and_target') &&
    business.repoName?.toLowerCase() === payload.repository.toLowerCase(),
  )
  if (!repositorySource) return NextResponse.json({ error: 'repository is not a registered Operion source' }, { status: 409 })
  if (!discoveryMatchesSourceBusiness(payload, repositorySource)) {
    return NextResponse.json({ error: 'only the registered source branch may create updates' }, { status: 409 })
  }
  const source = repositorySource

  const now = Date.now()
  const candidate = discoveredUpdateFromGitHub(payload, {
    key: await nextUpdateKey(),
    sourceBusinessId: source.id,
    sourceBranch: source.defaultBranch,
    now,
  })
  const saved = await saveDiscoveredUpdate(candidate, { repository: payload.repository, commit: payload.after })
  if (saved.kind === 'created') {
    await recordPlatformAudit({
      actor: 'github-actions', actorType: 'system', source: 'automatic-update-discovery',
      action: 'update.discovered', businessId: source.id, updateKey: saved.update.key,
      commit: saved.update.sourceCommit, newStatus: 'discovered',
      summary: `${saved.update.key} discovered from ${payload.repository}@${payload.after.slice(0, 12)}`,
      traceId: payload.workflowRunId,
      meta: { deliveryId: payload.deliveryId, changedFileCount: payload.changedFileCount, pullRequestNumber: payload.pullRequestNumber },
    })
  }
  return NextResponse.json({
    ok: true,
    created: saved.kind === 'created',
    deduped: saved.kind === 'existing',
    update: { key: saved.update.key, title: saved.update.title, status: saved.update.status, sourceCommit: saved.update.sourceCommit },
  }, { status: saved.kind === 'created' ? 201 : 200 })
}
