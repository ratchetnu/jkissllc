// ── Baseline evidence collection ────────────────────────────────────────────
//
// The workflow this replaces asked a non-technical owner to type a production commit,
// a SHA-256 manifest hash, a schema state and a flag assessment. The one field it
// pre-filled — the commit — came from `business.currentCommit`, which only advances on
// Operion job finalization, so it was stale for anything deployed outside the pipeline.
// Observed in production: the form offered dd8f6586… while Supercharged was serving
// 220062081e66…, and adopting would have recorded the wrong commit as provenance.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectBaselineEvidence, evidenceSummary, repoRefOf, resolveFullCommit,
  type BaselineEvidenceDeps,
} from '../app/lib/platform/release/baseline-evidence'
import type { PlatformBusiness } from '../app/lib/platform/updates/types'

const LIVE_FULL = '220062081e66a2b1c3d4e5f60718293a4b5c6d7e'
const STALE = 'dd8f6586d53b54b20e144162f93c5b3911bad644'
const NOW = 1_700_000_000_000

const business = (patch: Partial<PlatformBusiness> = {}): PlatformBusiness => ({
  recordVersion: 1, id: 'supercharged', slug: 'supercharged', name: 'Supercharged',
  status: 'active', role: 'target', repoName: 'ratchetnu/supercharged', defaultBranch: 'main',
  releaseChannel: 'stable', updatePolicy: 'owner_approval', updatesPaused: false,
  manualApprovalRequired: true, autoDeployAllowed: false, healthStatus: 'healthy',
  productionUrl: 'https://superchargedenterprise.com', productionProjectId: 'prj_sc',
  currentCommit: STALE, latestVerifiedCommit: STALE,
  createdAt: 0, updatedAt: 0, ...patch,
})

const deps = (patch: Partial<BaselineEvidenceDeps> = {}): BaselineEvidenceDeps => ({
  readProduction: async () => ({ deploymentId: 'dpl_live', commit: LIVE_FULL, url: 'https://sc.app', deployedAt: NOW - 1000 }),
  readCommit: async (_repo, sha) => (sha.toLowerCase() === LIVE_FULL || LIVE_FULL.startsWith(sha.toLowerCase()) ? { sha: LIVE_FULL } : null),
  readBranch: async () => ({ commit: LIVE_FULL }),
  readRepoTree: async () => ['app/lib/booking.ts', 'app/page.tsx', 'README.md'],
  fetchHealth: async () => ({ ok: true, status: 200, build: 'dpl_live', reportedStatus: 'healthy' }),
  readCapabilities: async () => ({ manifestHash: `sha256:${'a'.repeat(64)}`, capabilities: [{ id: 'booking', evidence: 'route present' }] }),
  readSchemaState: async () => ({ state: 'verified', evidence: 'no pending migrations' }),
  readFlagState: async () => ({ assessed: true, flags: { BOOKING_ASSIGNMENT_ENABLED: true } }),
  ...patch,
})

const run = (b = business(), d = deps()) => collectBaselineEvidence({ business: b, now: NOW, deps: d })
const byId = (r: Awaited<ReturnType<typeof run>>, id: string) => r.items.find((i) => i.id === id)!

// ── The defect this workflow exists to remove ──────────────────────────────

test('the stored (stale) commit is never used — evidence comes from the live deployment', async () => {
  const report = await run()
  assert.equal(report.live?.fullCommit, LIVE_FULL)
  assert.notEqual(report.live?.fullCommit, STALE, 'the stored commit must not reach the evidence')
  assert.ok(!JSON.stringify(report).includes(STALE), 'and must not appear anywhere in the report')
})

test('a business whose stored commit is stale still reports OK on live evidence', async () => {
  // The stored commit being behind is not an error. It is the normal state for anything
  // deployed outside the pipeline, and it is exactly why the form must not offer it.
  const report = await run(business({ currentCommit: STALE }))
  assert.equal(report.ok, true)
  assert.equal(byId(report, 'commit').status, 'ok')
})

// ── Full-SHA resolution: fail closed, never construct ──────────────────────

test('an abbreviated commit is resolved from the repository, never extended', async () => {
  const r = await resolveFullCommit({ providerCommit: '220062081e66', repo: { owner: 'r', name: 's' } },
    { readCommit: async () => ({ sha: LIVE_FULL }) })
  assert.equal(r.ok, true)
  assert.equal((r as { fullCommit: string }).fullCommit, LIVE_FULL)
  assert.equal((r as { source: string }).source, 'repository_lookup')
})

test('an abbreviation the repository cannot confirm FAILS CLOSED', async () => {
  // The rule: 2200620 and 2200620… differ by 33 characters of assumption. A baseline is
  // durable provenance, so an unconfirmed commit must never be recorded.
  const r = await resolveFullCommit({ providerCommit: '220062081e66', repo: { owner: 'r', name: 's' } },
    { readCommit: async () => null })
  assert.equal(r.ok, false)
  assert.equal((r as { reason: string }).reason, 'unresolvable')
})

test('a repository answer that is not a full SHA is refused', async () => {
  for (const bad of ['220062081e66', '', 'HEAD', 'x'.repeat(40)]) {
    const r = await resolveFullCommit({ providerCommit: '220062081e66', repo: { owner: 'r', name: 's' } },
      { readCommit: async () => ({ sha: bad }) })
    assert.equal(r.ok, false, `accepted ${bad}`)
  }
})

test('an abbreviation with no connected repository cannot be resolved', async () => {
  const r = await resolveFullCommit({ providerCommit: '220062081e66' }, { readCommit: async () => ({ sha: LIVE_FULL }) })
  assert.equal(r.ok, false)
  assert.match((r as { detail: string }).detail, /no repository is connected/i)
})

test('a provider full SHA is taken as-is without a lookup', async () => {
  let looked = false
  const r = await resolveFullCommit({ providerCommit: LIVE_FULL.toUpperCase(), repo: { owner: 'r', name: 's' } },
    { readCommit: async () => { looked = true; return null } })
  assert.equal(r.ok, true)
  assert.equal((r as { fullCommit: string }).fullCommit, LIVE_FULL, 'normalized to lower case')
  assert.equal(looked, false)
})

test('no commit at all is missing evidence, and the whole check fails closed', async () => {
  const report = await run(business(), deps({ readProduction: async () => ({ deploymentId: 'dpl_live' }) }))
  assert.equal(report.ok, false)
  assert.equal(byId(report, 'commit').status, 'missing')
  assert.equal(report.live, undefined, 'no live evidence is published without an exact commit')
})

// ── Missing vs contradictory ───────────────────────────────────────────────

test('unreadable evidence is MISSING; disagreeing evidence is CONTRADICTORY', async () => {
  const unreadable = await run(business(), deps({ readProduction: async () => null }))
  assert.equal(byId(unreadable, 'deployment').status, 'missing')
  assert.ok(byId(unreadable, 'deployment').action, 'missing evidence tells the owner what to do')

  // The site answers, but reports a different build than the provider calls current.
  const disagreeing = await run(business(), deps({ fetchHealth: async () => ({ ok: true, status: 200, build: 'dpl_SOMETHING_ELSE' }) }))
  assert.equal(byId(disagreeing, 'health').status, 'contradictory')
  assert.match(byId(disagreeing, 'health').detail, /different build/i)

  // A commit the repository does not recognise is a contradiction, not a gap.
  const foreign = await run(business(), deps({ readCommit: async () => null, readProduction: async () => ({ deploymentId: 'dpl_live', commit: LIVE_FULL }) }))
  assert.equal(byId(foreign, 'commit_in_repo').status, 'contradictory')
  assert.match(byId(foreign, 'commit_in_repo').detail, /does not recognise/i)
})

test('a failing site is contradictory, not merely missing', async () => {
  const report = await run(business(), deps({ fetchHealth: async () => ({ ok: false, status: 503 }) }))
  assert.equal(byId(report, 'health').status, 'contradictory')
  assert.equal(report.ok, false)
})

test('the summary leads with contradictions, which will not clear by waiting', async () => {
  const report = await run(business(), deps({
    fetchHealth: async () => ({ ok: false, status: 500 }),
    readCapabilities: async () => null,
  }))
  const s = evidenceSummary(report)
  assert.equal(s.ok, false)
  assert.ok(s.contradictory >= 1 && s.missing >= 1)
  assert.match(s.headline, /do not match|does not match/i)
})

test('a clean read says so plainly', async () => {
  assert.equal(evidenceSummary(await run()).headline, 'Everything checks out.')
})

// ── Owner-facing shape ─────────────────────────────────────────────────────

test('every not-ok item carries an action, and hashes stay in technical details', async () => {
  const report = await run(business(), deps({ readProduction: async () => null, readCapabilities: async () => null, readSchemaState: async () => null, readFlagState: async () => null }))
  for (const i of report.items.filter((x) => x.status !== 'ok')) {
    assert.ok(i.action, `${i.id} has no action for the owner`)
    assert.ok(!/sha256:|[0-9a-f]{40}/.test(i.detail), `${i.id} leaks a hash into owner-facing text: ${i.detail}`)
  }
  const manifest = report.items.find((i) => i.id === 'manifest')
  assert.ok(manifest)
})

test('the manifest hash is never shown in the owner-facing sentence', async () => {
  const report = await run()
  const manifest = byId(report, 'manifest')
  assert.equal(manifest.status, 'ok')
  assert.equal(manifest.detail, 'Recorded.')
  assert.match(manifest.technical ?? '', /^sha256:/, 'the hash lives under Technical details')
})

test('collecting evidence performs no writes — it only reads', async () => {
  // Every dependency is a reader. This asserts the contract at the type level in code:
  // if a writer were added to BaselineEvidenceDeps, this list would need to change.
  const names = Object.keys(deps())
  assert.deepEqual(names.sort(), [
    'fetchHealth', 'readBranch', 'readCapabilities', 'readCommit',
    'readFlagState', 'readProduction', 'readRepoTree', 'readSchemaState',
  ])
  for (const n of names) assert.match(n, /^(read|fetch)/, `${n} is not a read-only dependency`)
})

// ── Legacy / degraded records ──────────────────────────────────────────────

test('a business with no repository reports it plainly instead of failing obscurely', async () => {
  const report = await run(business({ repoName: undefined, repositoryOwner: undefined, repositoryNameOnly: undefined }))
  assert.equal(byId(report, 'repository').status, 'missing')
  assert.match(byId(report, 'repository').action ?? '', /Connect the repository/i)
  assert.equal(report.ok, false)
})

test('a legacy business with no production URL still reports every other fact', async () => {
  const report = await run(business({ productionUrl: undefined, healthEndpoint: undefined }))
  assert.equal(byId(report, 'health').status, 'missing')
  assert.equal(byId(report, 'commit').status, 'ok', 'the other readings are unaffected')
  assert.equal(report.ok, false)
})

test('repoRefOf prefers the split fields and falls back to owner/name', () => {
  assert.deepEqual(repoRefOf({ repositoryOwner: 'a', repositoryNameOnly: 'b', repoName: 'x/y' }), { owner: 'a', name: 'b' })
  assert.deepEqual(repoRefOf({ repoName: 'x/y' }), { owner: 'x', name: 'y' })
  assert.equal(repoRefOf({ repoName: 'nope' }), undefined)
  assert.equal(repoRefOf({}), undefined)
})

test('a dependency that throws degrades to missing, never to a crash', async () => {
  const report = await run(business(), deps({
    readProduction: async () => { throw new Error('provider down') },
    fetchHealth: async () => { throw new Error('network') },
  }))
  assert.equal(report.ok, false)
  assert.equal(byId(report, 'deployment').status, 'missing')
  assert.equal(byId(report, 'health').status, 'missing')
})

test('an UNRESOLVABLE abbreviation never reaches the published evidence', async () => {
  // The dangerous shape, and the one a weaker test misses: the provider DOES report a
  // commit, but only an abbreviation the repository cannot confirm. Publishing it would
  // put a 12-character identifier into a field every consumer reads as a full SHA.
  const report = await run(business(), deps({
    readProduction: async () => ({ deploymentId: 'dpl_live', commit: '220062081e66' }),
    readCommit: async () => null,   // repository cannot confirm it
  }))
  assert.equal(report.ok, false)
  assert.equal(byId(report, 'commit').status, 'missing')
  assert.equal(report.live, undefined, 'no live evidence at all without an exact commit')
  assert.ok(!JSON.stringify(report.live ?? {}).includes('220062081e66'))
  assert.match(byId(report, 'commit').action ?? '', /Redeploy production/i)
})

test('BOOTSTRAP: a business with NO prior Operion deployment can still be established', () => {
  // The circularity this removes: schema state used to require a previous
  // Operion-VERIFIED deployment. Supercharged predates Operion, so no such record can
  // exist, and the baseline could never be adopted — the prerequisite for the first
  // evidence record was an earlier evidence record.
  //
  // The repository at the exact deployed commit answers it without Operion history.
  assert.ok(true) // (behaviour asserted in the two tests below)
})

test('BOOTSTRAP: no prior record + no migrations in the code = established from the repository', async () => {
  const report = await run(business(), deps({
    readSchemaState: async () => null,                                  // pre-Operion: nothing recorded
    readRepoTree: async () => ['app/lib/booking.ts', 'app/page.tsx'],   // and no migrations exist
  }))
  const schema = byId(report, 'schema')
  assert.equal(schema.status, 'ok')
  assert.equal(schema.source, 'repository_derived', 'derived from the artifact, not from Operion history')
  assert.equal(report.schemaMigrationState.state, 'not_applicable')
  assert.equal(report.ok, true, 'a pre-Operion business reaches a complete check')
  assert.equal(report.attested.length, 0, 'and needs no attestation to get there')
})

test('BOOTSTRAP: migrations in the code are UNKNOWN, never described as clean', async () => {
  const report = await run(business(), deps({
    readSchemaState: async () => null,
    readRepoTree: async () => ['scripts/pay-backfill.ts', 'db/migrations/001.sql', 'app/lib/x.ts'],
  }))
  const schema = byId(report, 'schema')
  assert.equal(schema.status, 'missing')
  assert.equal(schema.source, 'unresolved')
  assert.equal(schema.attestable, true, 'the owner can resolve it, deliberately')
  assert.match(schema.detail, /no record of whether they were applied/i)
  assert.ok(!/up to date|no outstanding|clean/i.test(schema.detail), 'unknown must not read as clean')
  assert.equal(report.ok, false)
  assert.deepEqual(report.attestable, ['schema'])
})

test('ATTESTATION resolves an attestable item, and is recorded as the owner’s word', async () => {
  const d = deps({ readSchemaState: async () => null, readRepoTree: async () => ['db/migrations/001.sql'] })
  const report = await collectBaselineEvidence({ business: business(), now: NOW, deps: d, attestations: { schema: true } })
  const schema = byId(report, 'schema')
  assert.equal(schema.status, 'ok')
  assert.equal(schema.source, 'owner_attested', 'never promoted to a verified reading')
  assert.match(schema.detail, /Operion could not verify this itself/i)
  assert.deepEqual(report.attested, ['schema'])
  assert.equal(report.schemaMigrationState.evidence, 'owner attestation — not verified by Operion')
  assert.equal(report.ok, true)
})

test('an attestation cannot resolve an item that is NOT attestable', async () => {
  // The owner may not attest their way past a provider reading. Only items Operion has
  // marked attestable — because it genuinely cannot establish them — can be attested.
  const report = await collectBaselineEvidence({
    business: business(), now: NOW,
    deps: deps({ readProduction: async () => null }),
    attestations: { schema: true },
  })
  assert.equal(byId(report, 'deployment').status, 'missing', 'the deployment gap stands')
  assert.equal(byId(report, 'deployment').source, 'unresolved')
  assert.equal(report.ok, false)
})

test('a repository that cannot be read is attestable, not silently clean', async () => {
  const report = await run(business(), deps({ readSchemaState: async () => null, readRepoTree: async () => null }))
  const schema = byId(report, 'schema')
  assert.equal(schema.status, 'missing')
  assert.equal(schema.attestable, true)
  assert.equal(report.schemaMigrationState.state, 'unknown')
})

test('a prior Operion-verified deployment still wins, and is labelled as provider-verified', async () => {
  const report = await run()
  assert.equal(byId(report, 'schema').source, 'provider_verified')
})

test('every item declares where its fact came from', async () => {
  const report = await run()
  const SOURCES = ['provider_verified', 'repository_derived', 'owner_attested', 'unresolved']
  for (const i of report.items) assert.ok(SOURCES.includes(i.source), `${i.id} has source ${i.source}`)
})


test('an unread flag assessment is MISSING — never assumed assessed', async () => {
  const report = await run(business(), deps({ readFlagState: async () => null }))
  assert.equal(byId(report, 'flags').status, 'missing')
  assert.equal(report.relevantFlagState.assessed, false)
  assert.equal(report.ok, false)
})

test('a 200 response that reports "degraded" is CONTRADICTORY, not healthy', async () => {
  // Found by checking the real Supercharged deployment: /api/health answers HTTP 200
  // with {"status":"degraded"}. Reading the transport code as the answer would have
  // recorded a baseline against a site that is telling us something is wrong.
  const report = await run(business(), deps({
    fetchHealth: async () => ({ ok: true, status: 200, build: 'dpl_live', reportedStatus: 'degraded' }),
  }))
  const health = byId(report, 'health')
  assert.equal(health.status, 'contradictory')
  assert.match(health.detail, /reports its own status as "degraded"/)
  assert.equal(report.ok, false)
  assert.equal(health.attestable, undefined, 'and it is NOT something an owner may attest away')
})

test('only an explicitly healthy body passes', async () => {
  for (const reported of ['healthy', undefined]) {
    const report = await run(business(), deps({
      fetchHealth: async () => ({ ok: true, status: 200, build: 'dpl_live', reportedStatus: reported }),
    }))
    assert.equal(byId(report, 'health').status, 'ok', String(reported))
  }
  for (const reported of ['degraded', 'down', 'unhealthy', 'error']) {
    const report = await run(business(), deps({
      fetchHealth: async () => ({ ok: true, status: 200, build: 'dpl_live', reportedStatus: reported }),
    }))
    assert.equal(byId(report, 'health').status, 'contradictory', reported)
  }
})

test('an attestation cannot OVERWRITE a fact Operion actually verified', async () => {
  // The hazard: a stray attestation flag downgrading a real reading to hearsay. The
  // schema here is provider-verified from a prior deployment record, so the attestation
  // must be ignored entirely — the record must keep saying it was measured.
  const report = await collectBaselineEvidence({
    business: business(), now: NOW,
    deps: deps(),                       // readSchemaState returns a verified state
    attestations: { schema: true },
  })
  const schema = byId(report, 'schema')
  assert.equal(schema.status, 'ok')
  assert.equal(schema.source, 'provider_verified', 'a verified reading must not become an attestation')
  assert.deepEqual(report.attested, [], 'and nothing is recorded as resting on the owner’s word')
  assert.ok(!/could not verify/i.test(schema.detail))
})

test('an attestation cannot resolve a repository-derived item either', async () => {
  const report = await collectBaselineEvidence({
    business: business(), now: NOW,
    deps: deps({ readSchemaState: async () => null, readRepoTree: async () => ['app/lib/x.ts'] }),
    attestations: { schema: true },
  })
  assert.equal(byId(report, 'schema').source, 'repository_derived')
  assert.deepEqual(report.attested, [])
})
