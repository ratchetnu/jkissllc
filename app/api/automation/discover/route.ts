import { NextRequest, NextResponse } from 'next/server'
import { verifyCallback } from '../../../lib/platform/automation/callback'
import { recordPlatformAudit } from '../../../lib/platform/updates/audit'
import { discoveryMatchesSourceBusiness, discoveredUpdateFromGitHub, validateGitHubDiscoveryPayload } from '../../../lib/platform/updates/discovery'
import {
  DISCOVERY_KEY_PLACEHOLDER, discoveryDeliverySeen, getUpdate, listBusinesses,
  markDiscoveryDelivery, saveDiscoveredUpdate,
} from '../../../lib/platform/updates/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * A refusal that tells an unauthenticated caller nothing about this deployment.
 *
 * The previous body echoed `verifyCallback`'s reason, which distinguished "bad
 * signature" from "callback secret not configured" — telling anyone who asked
 * whether discovery is provisioned here, and which of the two failure modes they
 * had hit. The reason is still recorded, on the server, where it is useful for
 * debugging and useless to a prober.
 */
function unauthorized(reason: string): NextResponse {
  console.warn('[discover] refused:', reason)
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
}

// GitHub main-branch discovery. Machine-to-machine and deliberately separate from the
// owner API: a SOURCE-ONLY HMAC secret proves the caller, while the registered source
// business binds repository + branch. Target repositories deliberately never receive
// OPERION_DISCOVERY_SECRET (the callback secret is shared with targets and is therefore
// insufficient for this boundary). The only permitted effect is a status=discovered
// update. Approval and publishing remain in their existing owner-gated routes.
export async function POST(req: NextRequest) {
  const raw = await req.text()
  const verified = verifyCallback(
    raw,
    req.headers.get('x-operion-timestamp'),
    req.headers.get('x-operion-signature'),
    process.env.OPERION_DISCOVERY_SECRET,
    Date.now(),
  )
  if (!verified.ok) return unauthorized(verified.reason ?? 'unverified')

  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }) }
  const validation = validateGitHubDiscoveryPayload(parsed)
  if (!validation.ok) return NextResponse.json({ error: 'invalid payload', reason: validation.reason }, { status: 400 })
  const payload = validation.value

  // Replay guard (defence in depth — the repository+commit marker below remains the
  // authoritative "one commit, one update" guarantee). Answered with the same body
  // the original delivery produced, so a replay is indistinguishable to the caller
  // from the success it is replaying.
  const replayed = await discoveryDeliverySeen(payload.deliveryId)
  if (replayed) {
    const prior = await getUpdate(replayed)
    return NextResponse.json({
      ok: true, created: false, deduped: true, replayed: true,
      update: prior
        ? { key: prior.key, title: prior.title, status: prior.status, sourceCommit: prior.sourceCommit }
        : { key: replayed },
    }, { status: 200 })
  }

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
  // The key is a PLACEHOLDER. It is allocated inside the store's atomic transaction,
  // and only when this turns out to be a genuine first delivery — a duplicate must
  // not consume a UPD number and leave a permanent gap in the release ledger.
  const candidate = discoveredUpdateFromGitHub(payload, {
    key: DISCOVERY_KEY_PLACEHOLDER,
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
  // Marked only after the write succeeded: a delivery that failed must stay eligible
  // for the workflow's retry.
  await markDiscoveryDelivery(payload.deliveryId, saved.update.key)
  return NextResponse.json({
    ok: true,
    created: saved.kind === 'created',
    deduped: saved.kind === 'existing',
    update: { key: saved.update.key, title: saved.update.title, status: saved.update.status, sourceCommit: saved.update.sourceCommit },
  }, { status: saved.kind === 'created' ? 201 : 200 })
}
