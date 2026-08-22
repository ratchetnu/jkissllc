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
import { touchesStoredData } from '../updates/discovery'

const FULL_SHA = /^[0-9a-f]{40}$/i
const ABBREV_SHA = /^[0-9a-f]{7,39}$/i

export type EvidenceStatus = 'ok' | 'missing' | 'contradictory'

/**
 * WHERE a fact came from. Recorded per item and carried into the adoption record,
 * because "Vercel told us" and "the owner said so" are not the same claim and must not
 * read the same afterwards.
 */
export type EvidenceSource =
  | 'provider_verified'   // read from the deployment provider or the live site
  | 'repository_derived'  // computed from repository contents at the exact commit
  | 'owner_attested'      // the owner asserted it; Operion could not establish it
  | 'unresolved'          // not established, and not attested either

export type EvidenceItem = {
  id: string
  /** What this is, in the owner's language. */
  label: string
  status: EvidenceStatus
  source: EvidenceSource
  /** True when an owner attestation would resolve this item (and only then). */
  attestable?: boolean
  /** One sentence saying what was found, or what could not be. */
  detail: string
  /** What the owner should DO. Present whenever status is not `ok`. */
  action?: string
  /** Hashes and raw diagnostics — belongs under "Technical details", never inline. */
  technical?: string
  /** Established evidence that is safe to adopt, but carries an operational caveat. */
  warning?: boolean
}

export type ReleaseReadinessEvidence = {
  status: 'ready' | 'ready_with_warnings' | 'blocked'
  blockers: string[]
  warnings: string[]
}

/** Parse only the value-free public health fields Operion understands. */
export function parsePublicHealthResponse(text: string): {
  build?: string
  reportedStatus?: string
  releaseReadiness?: ReleaseReadinessEvidence
} {
  try {
    const parsed = JSON.parse(text) as {
      build?: unknown
      status?: unknown
      releaseReadiness?: { status?: unknown; blockers?: unknown; warnings?: unknown }
    }
    const rr = parsed.releaseReadiness
    const validStatus = rr?.status === 'ready' || rr?.status === 'ready_with_warnings' || rr?.status === 'blocked'
    const validNames = (value: unknown): value is string[] => Array.isArray(value)
      && value.length <= 50
      && value.every((name) => typeof name === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(name))
    const releaseReadiness = validStatus && validNames(rr?.blockers) && validNames(rr?.warnings)
      ? { status: rr.status as ReleaseReadinessEvidence['status'], blockers: rr.blockers, warnings: rr.warnings }
      : undefined
    return {
      build: typeof parsed.build === 'string' ? parsed.build : undefined,
      reportedStatus: typeof parsed.status === 'string' ? parsed.status : undefined,
      releaseReadiness,
    }
  } catch {
    return {}
  }
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
  /** Items an owner could resolve by attesting. Empty when everything was established. */
  attestable: string[]
  /** Facts recorded on the owner's word. Non-empty ⇒ stronger confirmation is required. */
  attested: string[]
}

export type RepoRef = { owner: string; name: string }

/** Everything this module reads. Injected so the collector is testable without a network. */
export type BaselineEvidenceDeps = {
  readProduction: (business: PlatformBusiness) => Promise<{ deploymentId: string; commit?: string; url?: string; deployedAt?: number } | null>
  /** Authoritative: asks the repository what full SHA an identifier refers to. */
  readCommit: (repo: RepoRef, sha: string) => Promise<{ sha: string; message?: string } | null>
  readBranch: (repo: RepoRef, branch: string) => Promise<{ commit: string } | null>
  /** Paths in the repository AT AN EXACT COMMIT. The bootstrap path for schema state. */
  readRepoTree: (repo: RepoRef, sha: string) => Promise<string[] | null>
  fetchHealth: (url: string) => Promise<{
    ok: boolean
    status: number
    build?: string
    reportedStatus?: string
    releaseReadiness?: ReleaseReadinessEvidence
    body?: string
  } | null>
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
  id: string, label: string, status: EvidenceStatus, source: EvidenceSource, detail: string,
  extra: { action?: string; technical?: string; attestable?: boolean; warning?: boolean } = {},
): EvidenceItem => ({ id, label, status, source, detail, ...extra })

export function repoRefOf(business: Pick<PlatformBusiness, 'repoName' | 'repositoryOwner' | 'repositoryNameOnly'>): RepoRef | undefined {
  if (business.repositoryOwner && business.repositoryNameOnly) {
    return { owner: business.repositoryOwner, name: business.repositoryNameOnly }
  }
  const parts = business.repoName?.split('/')
  return parts?.length === 2 && parts[0] && parts[1] ? { owner: parts[0], name: parts[1] } : undefined
}

/** Resolve a stored health path against the business's public production origin. */
export function healthUrlOf(
  business: Pick<PlatformBusiness, 'healthEndpoint' | 'productionUrl'>,
): string {
  const productionUrl = business.productionUrl?.trim()
  const endpoint = business.healthEndpoint?.trim() || '/api/health'

  try {
    const base = productionUrl ? `${productionUrl.replace(/\/+$/, '')}/` : undefined
    const url = base ? new URL(endpoint, base) : new URL(endpoint)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}

/**
 * Read everything needed to justify a starting version. Read-only, and safe to run as
 * often as an owner presses the button.
 */
export async function collectBaselineEvidence(input: {
  business: PlatformBusiness
  now: number
  deps: BaselineEvidenceDeps
  /** Facts the owner has explicitly attested. Only ever consulted for `attestable` items. */
  attestations?: { schema?: boolean }
}): Promise<BaselineEvidenceReport> {
  const { business, now, deps } = input
  const attestations = input.attestations ?? {}
  const items: EvidenceItem[] = []
  const repo = repoRefOf(business)

  // ── 1. Repository identity ────────────────────────────────────────────────
  if (repo) {
    items.push(item('repository', 'Repository and branch', 'ok', 'provider_verified',
      `Connected to ${repo.owner}/${repo.name}, branch ${business.defaultBranch}.`))
  } else {
    items.push(item('repository', 'Repository and branch', 'missing', 'unresolved',
      'No code repository is connected to this business.',
      { action: 'Connect the repository in Business settings, then check again.' }))
  }

  // ── 2. Live production deployment ─────────────────────────────────────────
  const live = await deps.readProduction(business).catch(() => null)
  if (!live?.deploymentId) {
    items.push(item('deployment', 'Live production deployment', 'missing', 'unresolved',
      'Could not read the live production deployment for this business.',
      {
        action: 'Check that the hosting project is connected in Business settings, then check again.',
        technical: `project: ${business.productionProjectId || business.deployProject || '(none mapped)'}`,
      }))
  } else {
    items.push(item('deployment', 'Live production deployment', 'ok', 'provider_verified',
      `Serving deployment ${live.deploymentId}.`,
      { technical: `deploymentId=${live.deploymentId} url=${live.url ?? '—'} deployedAt=${live.deployedAt ?? '—'}` }))
  }

  // ── 3. The exact commit that deployment runs ──────────────────────────────
  const resolution = await resolveFullCommit({ providerCommit: live?.commit, repo }, deps)
  let fullCommit: string | undefined
  if (resolution.ok) {
    fullCommit = resolution.fullCommit
    items.push(item('commit', 'Exact code version live', 'ok', 'provider_verified',
      `Live production is running commit ${fullCommit.slice(0, 12)}.`,
      {
        technical: `full commit ${fullCommit} (resolved via ${resolution.source === 'provider_full' ? 'deployment metadata' : 'repository lookup'})`,
      }))
  } else if (!live?.deploymentId) {
    // Already reported as a missing deployment; do not scold twice for one cause.
    items.push(item('commit', 'Exact code version live', 'missing', 'unresolved',
      'Cannot identify the live code version until the deployment can be read.',
      { action: 'Resolve the deployment connection above, then check again.' }))
  } else {
    items.push(item('commit', 'Exact code version live', 'missing', 'unresolved', resolution.detail,
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
      items.push(item('commit_in_repo', 'Code version matches the repository', 'contradictory', 'repository_derived',
        `Live production is running a commit that ${repo.owner}/${repo.name} does not recognise.`,
        {
          action: 'Confirm the business is connected to the repository its site is actually deployed from.',
          technical: `commit ${fullCommit} not found in ${repo.owner}/${repo.name}`,
        }))
    } else {
      const branch = await deps.readBranch(repo, business.defaultBranch).catch(() => null)
      items.push(item('commit_in_repo', 'Code version matches the repository', 'ok', 'repository_derived',
        `Confirmed in ${repo.owner}/${repo.name}.`,
        { technical: `branch ${business.defaultBranch} head=${branch?.commit ?? 'unread'} · live=${fullCommit}` }))
    }
  }

  // ── 5. Production health ──────────────────────────────────────────────────
  const healthUrl = healthUrlOf(business)
  if (!healthUrl) {
    items.push(item('health', 'Site responding', 'missing', 'unresolved',
      'No production address is recorded for this business.',
      { action: 'Add the production URL in Business settings, then check again.' }))
  } else {
    const health = await deps.fetchHealth(healthUrl).catch(() => null)
    if (!health) {
      items.push(item('health', 'Site responding', 'missing', 'unresolved',
        'Could not reach the production site to confirm it is healthy.',
        { action: 'Check the site is online, then check again.', technical: `GET ${healthUrl} → no response` }))
    } else if (!health.ok) {
      items.push(item('health', 'Site responding', 'contradictory', 'provider_verified',
        `The production site answered, but reported a problem (HTTP ${health.status}).`,
        { action: 'Resolve the site error before recording a starting version.', technical: `GET ${healthUrl} → ${health.status}` }))
    } else if (health.build && live?.deploymentId && health.build !== live.deploymentId) {
      // Read both, and they disagree — the site is not serving the deployment the
      // provider calls current. This is checked BEFORE any warning exception so a
      // release-ready label can never waive build identity.
      items.push(item('health', 'Site responding', 'contradictory', 'provider_verified',
        'The live site is reporting a different build than the hosting provider lists as current.',
        {
          action: 'Wait for the deployment to finish rolling out, then check again.',
          technical: `health build=${health.build} · provider deployment=${live.deploymentId}`,
        }))
    } else if (health.releaseReadiness && !(
      (health.reportedStatus === 'healthy'
        && health.releaseReadiness.status === 'ready'
        && health.releaseReadiness.blockers.length === 0
        && health.releaseReadiness.warnings.length === 0)
      || (health.reportedStatus === 'degraded'
        && health.releaseReadiness.status === 'ready_with_warnings'
        && health.releaseReadiness.blockers.length === 0
        && health.releaseReadiness.warnings.length > 0)
    )) {
      items.push(item('health', 'Site responding', 'contradictory', 'provider_verified',
        'The production site reported inconsistent health and release-readiness verdicts.',
        {
          action: 'Fix the production health response before recording a starting version.',
          technical: `status=${health.reportedStatus ?? '(missing)'} releaseReadiness=${health.releaseReadiness.status} blockers=${health.releaseReadiness.blockers.join(',')} warnings=${health.releaseReadiness.warnings.join(',')}`,
        }))
    } else if (
      health.reportedStatus === 'degraded'
      && health.releaseReadiness?.status === 'ready_with_warnings'
      && health.releaseReadiness.blockers.length === 0
      && health.releaseReadiness.warnings.length > 0
    ) {
      // Overall health remains honestly degraded. The site's narrower, public
      // release-readiness projection says the artifact/build evidence is usable and
      // names the non-blocking checks. This is machine evidence, not an owner waiver.
      items.push(item('health', 'Site responding', 'ok', 'provider_verified',
        `The production site is up. It reports an operational warning that does not invalidate release evidence: ${health.releaseReadiness.warnings.join(', ')}.`,
        {
          warning: true,
          technical: `GET ${healthUrl} → ${health.status} status=degraded releaseReadiness=ready_with_warnings warnings=${health.releaseReadiness.warnings.join(',')}${health.build ? ` build=${health.build}` : ''}`,
        }))
    } else if (health.reportedStatus && health.reportedStatus !== 'healthy') {
      // Found by checking the real Supercharged deployment: /api/health answers HTTP 200
      // with {"status":"degraded"}. Treating the transport code as the answer would have
      // recorded a baseline against a site that is telling us something is wrong.
      items.push(item('health', 'Site responding', 'contradictory', 'provider_verified',
        `The production site is reachable but reports its own status as "${health.reportedStatus}".`,
        {
          action: 'Resolve what the site is reporting before recording a starting version.',
          technical: `GET ${healthUrl} → ${health.status} status=${health.reportedStatus}${health.build ? ` build=${health.build}` : ''}`,
        }))
    } else {
      items.push(item('health', 'Site responding', 'ok', 'provider_verified', 'The production site is up and reporting healthy.',
        { technical: `GET ${healthUrl} → ${health.status}${health.build ? ` build=${health.build}` : ''}` }))
    }
  }

  // ── 6. Capability profile ─────────────────────────────────────────────────
  const caps = await deps.readCapabilities(business).catch(() => null)
  const capabilities = caps?.capabilities ?? []
  if (!caps || !capabilities.length) {
    items.push(item('capabilities', 'Features detected', 'missing', 'unresolved',
      'Could not determine which features this business is running.',
      { action: 'Open the business once so it reports its features, then check again.' }))
  } else {
    items.push(item('capabilities', 'Features detected', 'ok', 'provider_verified',
      `${capabilities.length} feature${capabilities.length === 1 ? '' : 's'} detected: ${capabilities.slice(0, 6).map((c) => c.id).join(', ')}${capabilities.length > 6 ? '…' : ''}.`,
      { technical: `manifest ${caps.manifestHash ?? '(none)'} · ${capabilities.map((c) => `${c.id}=${c.evidence}`).join('; ')}` }))
  }
  if (!caps?.manifestHash) {
    items.push(item('manifest', 'Feature fingerprint', 'missing', 'unresolved',
      'Could not compute a fingerprint of this business’s feature set.',
      { action: 'This usually clears once the site has reported in. Check again shortly.' }))
  } else {
    items.push(item('manifest', 'Feature fingerprint', 'ok', 'provider_verified', 'Recorded.',
      { technical: caps.manifestHash }))
  }

  // ── 7. Schema / migration state ───────────────────────────────────────────
  // A business that predates Operion has NO prior Operion-verified deployment, so asking
  // for one is circular: it could never adopt a first baseline. Three tiers, strongest
  // first, and each records where the answer came from.
  //
  //   1. a prior Operion-verified deployment              → provider_verified
  //   2. the repository at the exact deployed commit      → repository_derived
  //   3. the owner, explicitly and visibly                → owner_attested
  //
  // Tier 2 is what breaks the circle: if the code at that commit contains no migration
  // or backfill of any kind, there is nothing outstanding to apply, and that is a fact
  // about the artifact rather than about Operion's history with it.
  const schema = await deps.readSchemaState(business).catch(() => null)
  let schemaMigrationState: BaselineSchemaEvidence = schema ?? { state: 'unknown' }
  if (schema && schema.state !== 'unknown') {
    items.push(item('schema', 'Data structure', 'ok', 'provider_verified',
      schema.state === 'not_applicable'
        ? 'No data migrations apply to this business.'
        : 'Data structure is up to date, with no outstanding migrations.',
      { technical: `state=${schema.state} ${schema.evidence ?? ''}`.trim() }))
  } else if (fullCommit && repo) {
    const tree = await deps.readRepoTree(repo, fullCommit).catch(() => null)
    const migrationPaths = tree?.filter(touchesStoredData) ?? []
    if (!tree) {
      items.push(item('schema', 'Data structure', 'missing', 'unresolved',
        'Could not read the code at the version that is live, so outstanding data changes could not be ruled out.',
        {
          action: 'Reconnect the repository so Operion can read it, then check again.',
          technical: `tree read failed for ${repo.owner}/${repo.name}@${fullCommit}`,
          attestable: true,
        }))
    } else if (!migrationPaths.length) {
      schemaMigrationState = { state: 'not_applicable', evidence: `no migration or backfill files exist at ${fullCommit.slice(0, 12)}` }
      items.push(item('schema', 'Data structure', 'ok', 'repository_derived',
        'The code running live contains no data migrations, so there is nothing outstanding to apply.',
        { technical: `${tree.length} paths scanned at ${fullCommit}; 0 migration/backfill paths` }))
    } else {
      // Migrations exist in the code. Whether they were APPLIED is not knowable from the
      // repository, and Operion has no record of running them. Unknown — and unknown is
      // never described as clean.
      items.push(item('schema', 'Data structure', 'missing', 'unresolved',
        `The code running live contains ${migrationPaths.length} data migration file${migrationPaths.length === 1 ? '' : 's'}, and Operion has no record of whether they were applied.`,
        {
          action: 'Confirm with whoever deployed this site that its data changes were applied, then attest to it below.',
          technical: migrationPaths.slice(0, 10).join(', '),
          attestable: true,
        }))
    }
  } else {
    items.push(item('schema', 'Data structure', 'missing', 'unresolved',
      'Could not confirm whether this business has any outstanding data changes.',
      { action: 'Resolve the live code version above, then check again.', attestable: true }))
  }

  // An attestation resolves an attestable item — and ONLY an attestable one. It is
  // recorded as owner_attested, never promoted to a verified reading.
  const schemaItem = items.find((i) => i.id === 'schema')!
  if (attestations.schema && schemaItem.attestable && schemaItem.status !== 'ok') {
    const attested = items.indexOf(schemaItem)
    items[attested] = item('schema', 'Data structure', 'ok', 'owner_attested',
      'You have confirmed that this site’s data changes were applied. Operion could not verify this itself.',
      { technical: `owner attestation; original finding: ${schemaItem.detail}` })
    schemaMigrationState = { state: 'verified', evidence: 'owner attestation — not verified by Operion' }
  }

  // ── 8. Feature flags ──────────────────────────────────────────────────────
  const flags = await deps.readFlagState(business).catch(() => null)
  const relevantFlagState: BaselineFlagEvidence = flags ?? { assessed: false, flags: {} }
  if (!relevantFlagState.assessed) {
    items.push(item('flags', 'Feature switches', 'missing', 'unresolved',
      'Could not read which optional features are switched on.',
      { action: 'Check again once the site has reported its settings.' }))
  } else {
    const keys = Object.keys(relevantFlagState.flags)
    const on = keys.filter((k) => relevantFlagState.flags[k])
    items.push(item('flags', 'Feature switches', 'ok', 'provider_verified',
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
    attestable: items.filter((i) => i.attestable && i.status !== 'ok').map((i) => i.id),
    attested: items.filter((i) => i.source === 'owner_attested').map((i) => i.id),
  }
}

/** Counts for a one-line owner summary ("3 things to fix", "everything checks out"). */
export function evidenceSummary(report: BaselineEvidenceReport): {
  ok: boolean; missing: number; contradictory: number; warnings: number; headline: string
} {
  const missing = report.items.filter((i) => i.status === 'missing').length
  const contradictory = report.items.filter((i) => i.status === 'contradictory').length
  const warnings = report.items.filter((i) => i.warning).length
  const headline = report.ok
    ? warnings
      ? `Everything required checks out, with ${warnings} operational warning${warnings === 1 ? '' : 's'}.`
      : 'Everything checks out.'
    : contradictory
      // Contradictions come first: something is actively wrong, and it will not clear
      // by waiting the way a missing reading might.
      ? `${contradictory} thing${contradictory === 1 ? '' : 's'} ${contradictory === 1 ? 'does not' : 'do not'} match${missing ? `, and ${missing} could not be read` : ''}.`
      : `${missing} thing${missing === 1 ? '' : 's'} could not be read yet.`
  return { ok: report.ok, missing, contradictory, warnings, headline }
}
