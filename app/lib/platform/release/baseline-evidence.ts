// ── Baseline evidence collection (server-side, READ-ONLY) ───────────────────
//
// Adopting a starting version used to ask a non-technical owner to type a production
// commit, a capability manifest SHA-256, a schema state, a flag assessment and two
// verification references. They could not know any of it, and the one field the form
// helpfully pre-filled — the commit — came from `business.currentCommit`, which only
// advances when an Operion job finalizes. For anything deployed outside the pipeline
// it is simply stale, so the form confidently proposed adopting a baseline against a
// commit Production had long since moved past.
//
// Operion can read every one of those facts itself. This module does, and it does it
// in ONE place so the answer shown to an owner and the answer the decision engine
// evaluates cannot differ.
//
// Three rules hold throughout:
//
//   1. NOTHING here writes. Checking evidence is a read, always, no exceptions.
//   2. A commit is either an exact 40-character SHA resolved from the repository, or
//      it is absent. An abbreviation is never extended, padded, or "matched" into a
//      full one — see resolveFullCommit().
//   3. "We could not read it" and "we read it and it disagrees" are different
//      answers, reported differently, because they need different actions from the
//      owner.

import type {
  BaselineFlagEvidence, BaselineSchemaEvidence, BaselineVerificationEvidence, PlatformBusiness,
} from '../updates/types'

const FULL_SHA = /^[0-9a-f]{40}$/i
const ABBREV_SHA = /^[0-9a-f]{7,39}$/i

export type EvidenceStatus = 'ok' | 'missing' | 'contradictory'

export type EvidenceItem = {
  id: string
  /** What this is, in the owner's language. */
  label: string
  status: EvidenceStatus
  /** One sentence saying what was found, or what could not be. */
  detail: string
  /** What the owner should DO. Present whenever status is not `ok`. */
  action?: string
  /** Hashes and raw diagnostics — belongs under "Technical details", never inline. */
  technical?: string
}

export type LiveCommitResolution =
  | { ok: true; fullCommit: string; source: 'provider_full' | 'repository_lookup' }
  | { ok: false; reason: 'no_deployment' | 'no_commit' | 'unresolvable'; detail: string; technical?: string }

export type BaselineEvidenceReport = {
  /** True only when every item is `ok`. Anything else fails closed. */
  ok: boolean
  items: EvidenceItem[]
  verifiedAt: number
  live?: { fullCommit: string; deploymentId: string; deployedAt?: number; url?: string }
  repo?: { owner: string; name: string; branch: string; branchHead?: string }
  capabilities: { id: string; evidence: string }[]
  capabilityManifestHash?: string
  schemaMigrationState: BaselineSchemaEvidence
  relevantFlagState: BaselineFlagEvidence
  verificationEvidence: BaselineVerificationEvidence[]
}

export type RepoRef = { owner: string; name: string }

/** Everything this module reads. Injected so the collector is testable without a network. */
export type BaselineEvidenceDeps = {
  readProduction: (business: PlatformBusiness) => Promise<{ deploymentId: string; commit?: string; url?: string; deployedAt?: number } | null>
  /** Authoritative: asks the repository what full SHA an identifier refers to. */
  readCommit: (repo: RepoRef, sha: string) => Promise<{ sha: string; message?: string } | null>
  readBranch: (repo: RepoRef, branch: string) => Promise<{ commit: string } | null>
  fetchHealth: (url: string) => Promise<{ ok: boolean; status: number; build?: string; body?: string } | null>
  readCapabilities: (business: PlatformBusiness) => Promise<{ manifestHash?: string; capabilities: { id: string; evidence: string }[] } | null>
  readSchemaState: (business: PlatformBusiness) => Promise<BaselineSchemaEvidence | null>
  readFlagState: (business: PlatformBusiness) => Promise<BaselineFlagEvidence | null>
}

/**
 * Resolve the exact commit a live deployment is running.
 *
 * FAILS CLOSED. A provider may report a full SHA, an abbreviation, or nothing. Only the
 * first is usable as-is; an abbreviation is resolved by ASKING THE REPOSITORY what it
 * refers to, and the repository's answer is what gets recorded. If the repository cannot
 * be reached, or does not know that identifier, the result is `unresolvable` — never a
 * padded, guessed, or prefix-matched SHA.
 *
 * This matters more than it looks. `2200620` and `2200620…` differ by 33 characters of
 * unverified assumption, and a baseline records which commit a business is running as
 * durable provenance. Recording a commit nobody confirmed would put a precise-looking
 * lie in the release ledger forever.
 */
export async function resolveFullCommit(
  input: { providerCommit?: string; repo?: RepoRef },
  deps: Pick<BaselineEvidenceDeps, 'readCommit'>,
): Promise<LiveCommitResolution> {
  const raw = input.providerCommit?.trim().toLowerCase() ?? ''
  if (!raw) {
    return {
      ok: false, reason: 'no_commit',
      detail: 'The live deployment did not report which commit it was built from.',
    }
  }
  if (FULL_SHA.test(raw)) return { ok: true, fullCommit: raw, source: 'provider_full' }
  if (!ABBREV_SHA.test(raw)) {
    return {
      ok: false, reason: 'unresolvable',
      detail: 'The live deployment reported a build reference that is not a commit identifier.',
      technical: `provider reported: ${raw.slice(0, 80)}`,
    }
  }
  // An abbreviation. The ONLY way to a full SHA is to ask the repository.
  if (!input.repo) {
    return {
      ok: false, reason: 'unresolvable',
      detail: 'The live deployment reported a shortened commit, and no repository is connected to look up the full one.',
      technical: `abbreviated commit: ${raw}`,
    }
  }
  const found = await deps.readCommit(input.repo, raw).catch(() => null)
  if (!found?.sha || !FULL_SHA.test(found.sha)) {
    return {
      ok: false, reason: 'unresolvable',
      detail: 'The repository could not confirm which commit the live site is running.',
      technical: `abbreviated commit ${raw} in ${input.repo.owner}/${input.repo.name} → ${found?.sha ?? 'no answer'}`,
    }
  }
  return { ok: true, fullCommit: found.sha.toLowerCase(), source: 'repository_lookup' }
}

const item = (
  id: string, label: string, status: EvidenceStatus, detail: string,
  extra: { action?: string; technical?: string } = {},
): EvidenceItem => ({ id, label, status, detail, ...extra })

export function repoRefOf(business: Pick<PlatformBusiness, 'repoName' | 'repositoryOwner' | 'repositoryNameOnly'>): RepoRef | undefined {
  if (business.repositoryOwner && business.repositoryNameOnly) {
    return { owner: business.repositoryOwner, name: business.repositoryNameOnly }
  }
  const parts = business.repoName?.split('/')
  return parts?.length === 2 && parts[0] && parts[1] ? { owner: parts[0], name: parts[1] } : undefined
}

/**
 * Read everything needed to justify a starting version. Read-only, and safe to run as
 * often as an owner presses the button.
 */
export async function collectBaselineEvidence(input: {
  business: PlatformBusiness
  now: number
  deps: BaselineEvidenceDeps
}): Promise<BaselineEvidenceReport> {
  const { business, now, deps } = input
  const items: EvidenceItem[] = []
  const repo = repoRefOf(business)

  // ── 1. Repository identity ────────────────────────────────────────────────
  if (repo) {
    items.push(item('repository', 'Repository and branch', 'ok',
      `Connected to ${repo.owner}/${repo.name}, branch ${business.defaultBranch}.`))
  } else {
    items.push(item('repository', 'Repository and branch', 'missing',
      'No code repository is connected to this business.',
      { action: 'Connect the repository in Business settings, then check again.' }))
  }

  // ── 2. Live production deployment ─────────────────────────────────────────
  const live = await deps.readProduction(business).catch(() => null)
  if (!live?.deploymentId) {
    items.push(item('deployment', 'Live production deployment', 'missing',
      'Could not read the live production deployment for this business.',
      {
        action: 'Check that the hosting project is connected in Business settings, then check again.',
        technical: `project: ${business.productionProjectId || business.deployProject || '(none mapped)'}`,
      }))
  } else {
    items.push(item('deployment', 'Live production deployment', 'ok',
      `Serving deployment ${live.deploymentId}.`,
      { technical: `deploymentId=${live.deploymentId} url=${live.url ?? '—'} deployedAt=${live.deployedAt ?? '—'}` }))
  }

  // ── 3. The exact commit that deployment runs ──────────────────────────────
  const resolution = await resolveFullCommit({ providerCommit: live?.commit, repo }, deps)
  let fullCommit: string | undefined
  if (resolution.ok) {
    fullCommit = resolution.fullCommit
    items.push(item('commit', 'Exact code version live', 'ok',
      `Live production is running commit ${fullCommit.slice(0, 12)}.`,
      {
        technical: `full commit ${fullCommit} (resolved via ${resolution.source === 'provider_full' ? 'deployment metadata' : 'repository lookup'})`,
      }))
  } else if (!live?.deploymentId) {
    // Already reported as a missing deployment; do not scold twice for one cause.
    items.push(item('commit', 'Exact code version live', 'missing',
      'Cannot identify the live code version until the deployment can be read.',
      { action: 'Resolve the deployment connection above, then check again.' }))
  } else {
    items.push(item('commit', 'Exact code version live', 'missing', resolution.detail,
      {
        action: 'Redeploy production from the connected repository so the exact code version can be confirmed, then check again.',
        technical: resolution.technical,
      }))
  }

  // ── 4. Is that commit actually in the connected repository? ───────────────
  // A commit the repository does not recognise is a CONTRADICTION, not a gap: the live
  // site is running something that did not come from the code Operion is tracking.
  if (fullCommit && repo) {
    const known = await deps.readCommit(repo, fullCommit).catch(() => null)
    if (!known?.sha) {
      items.push(item('commit_in_repo', 'Code version matches the repository', 'contradictory',
        `Live production is running a commit that ${repo.owner}/${repo.name} does not recognise.`,
        {
          action: 'Confirm the business is connected to the repository its site is actually deployed from.',
          technical: `commit ${fullCommit} not found in ${repo.owner}/${repo.name}`,
        }))
    } else {
      const branch = await deps.readBranch(repo, business.defaultBranch).catch(() => null)
      items.push(item('commit_in_repo', 'Code version matches the repository', 'ok',
        `Confirmed in ${repo.owner}/${repo.name}.`,
        { technical: `branch ${business.defaultBranch} head=${branch?.commit ?? 'unread'} · live=${fullCommit}` }))
    }
  }

  // ── 5. Production health ──────────────────────────────────────────────────
  const healthUrl = business.healthEndpoint || (business.productionUrl ? `${business.productionUrl.replace(/\/$/, '')}/api/health` : '')
  if (!healthUrl) {
    items.push(item('health', 'Site responding', 'missing',
      'No production address is recorded for this business.',
      { action: 'Add the production URL in Business settings, then check again.' }))
  } else {
    const health = await deps.fetchHealth(healthUrl).catch(() => null)
    if (!health) {
      items.push(item('health', 'Site responding', 'missing',
        'Could not reach the production site to confirm it is healthy.',
        { action: 'Check the site is online, then check again.', technical: `GET ${healthUrl} → no response` }))
    } else if (!health.ok) {
      items.push(item('health', 'Site responding', 'contradictory',
        `The production site answered, but reported a problem (HTTP ${health.status}).`,
        { action: 'Resolve the site error before recording a starting version.', technical: `GET ${healthUrl} → ${health.status}` }))
    } else if (health.build && live?.deploymentId && health.build !== live.deploymentId) {
      // Read both, and they disagree — the site is not serving the deployment the
      // provider calls current. Recording a baseline now would attribute one build's
      // evidence to another.
      items.push(item('health', 'Site responding', 'contradictory',
        'The live site is reporting a different build than the hosting provider lists as current.',
        {
          action: 'Wait for the deployment to finish rolling out, then check again.',
          technical: `health build=${health.build} · provider deployment=${live.deploymentId}`,
        }))
    } else {
      items.push(item('health', 'Site responding', 'ok', 'The production site is up and reporting healthy.',
        { technical: `GET ${healthUrl} → ${health.status}${health.build ? ` build=${health.build}` : ''}` }))
    }
  }

  // ── 6. Capability profile ─────────────────────────────────────────────────
  const caps = await deps.readCapabilities(business).catch(() => null)
  const capabilities = caps?.capabilities ?? []
  if (!caps || !capabilities.length) {
    items.push(item('capabilities', 'Features detected', 'missing',
      'Could not determine which features this business is running.',
      { action: 'Open the business once so it reports its features, then check again.' }))
  } else {
    items.push(item('capabilities', 'Features detected', 'ok',
      `${capabilities.length} feature${capabilities.length === 1 ? '' : 's'} detected: ${capabilities.slice(0, 6).map((c) => c.id).join(', ')}${capabilities.length > 6 ? '…' : ''}.`,
      { technical: `manifest ${caps.manifestHash ?? '(none)'} · ${capabilities.map((c) => `${c.id}=${c.evidence}`).join('; ')}` }))
  }
  if (!caps?.manifestHash) {
    items.push(item('manifest', 'Feature fingerprint', 'missing',
      'Could not compute a fingerprint of this business’s feature set.',
      { action: 'This usually clears once the site has reported in. Check again shortly.' }))
  } else {
    items.push(item('manifest', 'Feature fingerprint', 'ok', 'Recorded.',
      { technical: caps.manifestHash }))
  }

  // ── 7. Schema / migration state ───────────────────────────────────────────
  const schema = await deps.readSchemaState(business).catch(() => null)
  const schemaMigrationState: BaselineSchemaEvidence = schema ?? { state: 'unknown' }
  if (schemaMigrationState.state === 'unknown') {
    items.push(item('schema', 'Data structure', 'missing',
      'Could not confirm whether this business has any outstanding data changes.',
      { action: 'Check again once the site has reported its data state.' }))
  } else {
    items.push(item('schema', 'Data structure', 'ok',
      schemaMigrationState.state === 'not_applicable'
        ? 'No data migrations apply to this business.'
        : 'Data structure is up to date, with no outstanding migrations.',
      { technical: `state=${schemaMigrationState.state} ${schemaMigrationState.evidence ?? ''}`.trim() }))
  }

  // ── 8. Feature flags ──────────────────────────────────────────────────────
  const flags = await deps.readFlagState(business).catch(() => null)
  const relevantFlagState: BaselineFlagEvidence = flags ?? { assessed: false, flags: {} }
  if (!relevantFlagState.assessed) {
    items.push(item('flags', 'Feature switches', 'missing',
      'Could not read which optional features are switched on.',
      { action: 'Check again once the site has reported its settings.' }))
  } else {
    const keys = Object.keys(relevantFlagState.flags)
    const on = keys.filter((k) => relevantFlagState.flags[k])
    items.push(item('flags', 'Feature switches', 'ok',
      keys.length
        ? `${keys.length} relevant switch${keys.length === 1 ? '' : 'es'} assessed, ${on.length} on.`
        : 'No release-relevant switches apply.',
      { technical: keys.map((k) => `${k}=${relevantFlagState.flags[k] ? 'on' : 'off'}`).join('; ') || '(none)' }))
  }

  // ── 9. Verification record ────────────────────────────────────────────────
  const verificationEvidence: BaselineVerificationEvidence[] = []
  if (live?.deploymentId) {
    verificationEvidence.push({ kind: 'production_deployment', reference: live.deploymentId, verifiedAt: live.deployedAt ?? now })
  }
  const healthOk = items.find((i) => i.id === 'health')?.status === 'ok'
  if (healthOk && healthUrl) {
    verificationEvidence.push({ kind: 'health_check', reference: healthUrl, verifiedAt: now })
  }

  return {
    ok: items.every((i) => i.status === 'ok'),
    items,
    verifiedAt: now,
    live: live?.deploymentId && fullCommit
      ? { fullCommit, deploymentId: live.deploymentId, deployedAt: live.deployedAt, url: live.url }
      : undefined,
    repo: repo ? { owner: repo.owner, name: repo.name, branch: business.defaultBranch } : undefined,
    capabilities,
    capabilityManifestHash: caps?.manifestHash,
    schemaMigrationState,
    relevantFlagState,
    verificationEvidence,
  }
}

/** Counts for a one-line owner summary ("3 things to fix", "everything checks out"). */
export function evidenceSummary(report: BaselineEvidenceReport): {
  ok: boolean; missing: number; contradictory: number; headline: string
} {
  const missing = report.items.filter((i) => i.status === 'missing').length
  const contradictory = report.items.filter((i) => i.status === 'contradictory').length
  const headline = report.ok
    ? 'Everything checks out.'
    : contradictory
      // Contradictions come first: something is actively wrong, and it will not clear
      // by waiting the way a missing reading might.
      ? `${contradictory} thing${contradictory === 1 ? '' : 's'} ${contradictory === 1 ? 'does not' : 'do not'} match${missing ? `, and ${missing} could not be read` : ''}.`
      : `${missing} thing${missing === 1 ? '' : 's'} could not be read yet.`
  return { ok: report.ok, missing, contradictory, headline }
}
