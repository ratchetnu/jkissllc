// ── The version lifecycle ───────────────────────────────────────────────────
//
// A business-facing version is a PROMISE: "Supercharged is on v1.4.0". It may change
// only when that promise is true — after an update is published, deployed and
// verified. Discovery files a record for every merge to main, so the failure this
// guards against is concrete: a version marching forward for changes nobody approved,
// none of which are live.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  applyBump, displayVersion, proposeNextVersion, updateChangeShape,
} from '../app/lib/platform/release/version-proposal'
import { deriveBusinessProvenance } from '../app/lib/platform/automation/finalize'
import { releaseIdentity, releaseIdentityLines, formatVerifiedAt } from '../app/lib/platform/updates/business-view'
import { parseSemanticVersion, evaluateVersionBump } from '../app/lib/platform/release/semver-policy'
import type { PlatformUpdate } from '../app/lib/platform/updates/types'

const upd = (patch: Partial<PlatformUpdate> = {}) =>
  ({ type: 'feature', breakingChange: false, migrationRequired: false, ...patch } as PlatformUpdate)

// ── The invariant ───────────────────────────────────────────────────────────

test('a discovered update proposes a version and changes NOTHING', () => {
  const business = { name: 'Supercharged', currentVersion: '1.3.2', currentCommit: 'abc', lastVerificationAt: 1 }
  const before = JSON.stringify(business)
  const p = proposeNextVersion({ currentVersion: business.currentVersion, update: upd({ status: 'discovered' } as Partial<PlatformUpdate>) })
  assert.equal(p.ok, true)
  assert.equal(JSON.stringify(business), before, 'proposing must not mutate the business')
  assert.equal(business.currentVersion, '1.3.2', 'and certainly must not advance it')
})

test('only the two evidence-based writers may PERSIST a version', () => {
  // An architectural guard, not a unit test. The rule is already stated in
  // api/admin/platform/businesses/[id]/route.ts ("Version fields are intentionally
  // absent"), but a rule stated in a comment is one refactor from being gone. The
  // signal here is precise: a file that both persists a business AND names
  // currentVersion is claiming the right to set one.
  const APP = path.resolve(import.meta.dirname, '..', 'app')
  const files = (function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((e) => {
      const full = path.join(dir, e)
      return statSync(full).isDirectory() ? walk(full) : (full.endsWith('.ts') || full.endsWith('.tsx') ? [full] : [])
    })
  })(APP)

  const ALLOWED = new Set([
    // 1. Verified release finalization — the version follows a deployment that was
    //    published, deployed and proven healthy.
    'lib/platform/automation/reconcile-records.ts',
    // 2. Evidence-based baseline adoption — an owner establishing a first baseline
    //    against real deployment evidence, not typing a number.
    'lib/platform/release/baseline-adoption-service.ts',
    // Fixtures, not a live path.
    'lib/platform/sandbox/service.ts',
    'lib/platform/updates/seed.ts',
  ])

  const persists = /\b(saveBusiness|saveBaselineAdoption)\s*\(/
  const claimants = files
    .filter((file) => {
      const src = readFileSync(file, 'utf8')
      return persists.test(src) && /currentVersion/.test(src)
    })
    .map((f) => path.relative(APP, f))
    .filter((rel) => !ALLOWED.has(rel))

  assert.deepEqual(claimants, [], `new version writer(s): ${claimants.join(', ')} — a business-facing version may be persisted only from verified deployment evidence or owner baseline adoption`)
})

test('the owner-editable business fields still cannot include a version', () => {
  // The complementary half: the PATCH route copies an allowlist of fields, and a
  // version is not in it. Adding one there would let an owner type any number they
  // liked over evidence-derived state.
  const src = readFileSync(new URL('../app/api/admin/platform/businesses/[id]/route.ts', import.meta.url), 'utf8')
  const allowlist = /for \(const k of \[([^\]]*)\] as const\)/.exec(src)?.[1] ?? ''
  assert.ok(allowlist.length > 0, 'the field allowlist should still exist')
  for (const forbidden of ['currentVersion', 'latestVerifiedVersion', 'currentDeploymentId', 'latestVerifiedCommit']) {
    assert.ok(!allowlist.includes(forbidden), `${forbidden} became owner-editable`)
  }
  assert.ok(allowlist.includes('currentCommit'), 'the allowlist itself was found (sanity)')
})

test('the verified path writes version, commit and deployment id as ONE fact', () => {
  const patch = deriveBusinessProvenance({
    facts: { deploymentId: 'dpl_abc123', deploymentUrl: 'https://x', commit: 'c'.repeat(40), verifiedAt: 1_700_000_000_000, buildPassed: true, healthPassed: true },
    releaseVersion: '1.4.0',
  })
  assert.equal(patch.currentVersion, '1.4.0')
  assert.equal(patch.latestVerifiedVersion, '1.4.0')
  assert.equal(patch.currentCommit, 'c'.repeat(40))
  assert.equal(patch.currentDeploymentId, 'dpl_abc123', 'the evidence travels with the claim')
  assert.equal(patch.lastVerificationAt, 1_700_000_000_000)
})

test('a verified deployment with NO release version advances evidence but not the version', () => {
  // Deploying a commit is not the same as releasing a version. The commit and the
  // deployment id are facts; the version is a decision, and nobody made one here.
  const patch = deriveBusinessProvenance({
    facts: { deploymentId: 'dpl_xyz', commit: 'd'.repeat(40), verifiedAt: 2, buildPassed: true, healthPassed: true },
  })
  assert.equal(patch.currentVersion, undefined)
  assert.equal(patch.latestVerifiedVersion, undefined)
  assert.equal(patch.currentCommit, 'd'.repeat(40))
  assert.equal(patch.currentDeploymentId, 'dpl_xyz')
})

test('an invalid release version is refused rather than written', () => {
  assert.throws(() => deriveBusinessProvenance({
    facts: { commit: 'e'.repeat(40), verifiedAt: 3, buildPassed: true, healthPassed: true },
    releaseVersion: 'v-not-a-version',
  }), /invalid semantic version/)
})

// ── The proposal ────────────────────────────────────────────────────────────

test('bump arithmetic resets the lower components', () => {
  const v = parseSemanticVersion('1.4.7')
  assert.ok(v.ok)
  assert.deepEqual(applyBump(v.version, 'major'), { major: 2, minor: 0, patch: 0 })
  assert.deepEqual(applyBump(v.version, 'minor'), { major: 1, minor: 5, patch: 0 })
  assert.deepEqual(applyBump(v.version, 'patch'), { major: 1, minor: 4, patch: 8 })
  assert.deepEqual(applyBump(v.version, 'none'), { major: 1, minor: 4, patch: 7 })
})

test('the proposed bump follows the shape of the change', () => {
  const cases: [Partial<PlatformUpdate>, string][] = [
    [{ type: 'feature' }, '1.4.0'],
    [{ type: 'enhancement' }, '1.4.0'],
    [{ type: 'bug_fix' }, '1.3.3'],
    [{ type: 'security' }, '1.3.3'],
    [{ type: 'documentation' }, '1.3.3'],
    [{ type: 'design' }, '1.3.3'],
    [{ type: 'infrastructure' }, '1.3.3'],
    [{ type: 'feature', breakingChange: true }, '2.0.0'],
    [{ type: 'bug_fix', breakingChange: true }, '2.0.0'],
  ]
  for (const [patch, expected] of cases) {
    const p = proposeNextVersion({ currentVersion: '1.3.2', update: upd(patch) })
    assert.equal(p.ok, true, JSON.stringify(patch))
    assert.equal((p as { proposed: string }).proposed, expected, JSON.stringify(patch))
  }
})

test('a migration flag alone does not force a major', () => {
  // On a DISCOVERED record `migrationRequired` is a path-name heuristic, and a
  // truncated file list sets it too. Proposing a major from a guess would be a
  // number nobody can retract.
  const p = proposeNextVersion({ currentVersion: '1.3.2', update: upd({ type: 'bug_fix', migrationRequired: true }) })
  assert.equal((p as { proposed: string }).proposed, '1.3.3')
  assert.equal(updateChangeShape(upd({ migrationRequired: true })).migration, 'compatible')
})

test('under-proposing is safe because approval enforces the minimum', () => {
  // The proposal is advisory; evaluateVersionBump is the gate. A patch proposal for
  // a breaking change must be REFUSED there, which is why proposing small is the
  // safe direction to be wrong in.
  const verdict = evaluateVersionBump({
    proposedVersion: '1.3.3', previousVersion: '1.3.2',
    classification: 'fix', breakingChange: true, channel: 'stable',
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'breaking_change_requires_major')
})

test('no baseline means no proposal — never an invented first version', () => {
  for (const current of [undefined, null, '']) {
    const p = proposeNextVersion({ currentVersion: current, update: upd() })
    assert.equal(p.ok, false, String(current))
    assert.equal((p as { reason: string }).reason, 'baseline_required')
    assert.match((p as { detail: string }).detail, /baseline/i)
    assert.ok(!/1\.0\.0|0\.1\.0/.test((p as { detail: string }).detail), 'and does not suggest one either')
  }
})

test('a corrupt recorded version is reported, not worked around', () => {
  const p = proposeNextVersion({ currentVersion: 'latest', update: upd() })
  assert.equal(p.ok, false)
  assert.equal((p as { reason: string }).reason, 'invalid_current_version')
})

// ── The display ─────────────────────────────────────────────────────────────

test('release identity shows the version with the evidence behind it', () => {
  const identity = releaseIdentity({
    name: 'Supercharged', currentVersion: '1.4.0',
    latestVerifiedCommit: 'abc1234def5678', currentDeploymentId: 'dpl_6qmrz',
    lastVerificationAt: Date.UTC(2026, 6, 18),
  })
  assert.equal(identity.version, 'v1.4.0')
  assert.equal(identity.unversioned, false)
  assert.equal(identity.shortCommit, 'abc1234…')
  assert.equal(identity.deploymentId, 'dpl_6qmrz')
  const lines = releaseIdentityLines(identity)
  assert.deepEqual(lines.map((l) => l.label), ['Version', 'Verified commit', 'Production deployment', 'Verified'])
  assert.equal(lines[0].value, 'v1.4.0')
  // The verified date is EVIDENCE, so it reads the same for every viewer. Rendered in
  // local time, a deployment verified near midnight UTC shows a different day
  // depending on who is looking, and the evidence stops being a shared fact.
  assert.equal(lines[3].value, '18 Jul 2026 (UTC)')
})

test('an unversioned business SAYS so instead of showing a fake number', () => {
  const identity = releaseIdentity({ name: 'Supercharged' })
  assert.equal(identity.unversioned, true)
  assert.equal(identity.version, '—')
  assert.equal(releaseIdentityLines(identity)[0].value, 'No baseline established')
  assert.equal(releaseIdentityLines(identity).length, 1, 'no evidence rows invented')
})

test('evidence rows appear only when the evidence exists', () => {
  const partial = releaseIdentity({ name: 'S', currentVersion: '1.0.0', latestVerifiedCommit: 'f'.repeat(40) })
  assert.deepEqual(releaseIdentityLines(partial).map((l) => l.label), ['Version', 'Verified commit'])
})

test('displayVersion never renders a bad value as if it were a version', () => {
  assert.equal(displayVersion('1.4.0'), 'v1.4.0')
  assert.equal(displayVersion('v1.4.0'), 'v1.4.0')
  assert.equal(displayVersion('nightly'), '—')
  assert.equal(displayVersion(undefined), '—')
})

test('the page shows the proposal as advisory and never writes it', () => {
  const src = readFileSync(new URL('../app/admin/operations/platform/page.tsx', import.meta.url), 'utf8')
  assert.match(src, /would propose v/, 'the wording is conditional, not a statement of fact')
  assert.ok(!/setCurrentVersion|currentVersion:\s*p\.proposed|currentVersion = /.test(src), 'the page must never assign a version')
})

test('the verified date is the same fact in every timezone', () => {
  // 23:30 UTC — the hour where local rendering silently changes the day.
  const lateUtc = Date.UTC(2026, 6, 18, 23, 30)
  assert.equal(formatVerifiedAt(lateUtc), '18 Jul 2026 (UTC)')
  assert.equal(formatVerifiedAt(Date.UTC(2026, 0, 1, 0, 5)), '1 Jan 2026 (UTC)')
})

// ── Evidence may never outlive the version it proves ────────────────────────

test('adopting a version REPLACES its evidence — an earlier deployment id is never inherited', () => {
  // The defect this pins: `currentVersion` and `currentDeploymentId` were set by two
  // independent conditions, and the record assembly inherited any field the patch did
  // not carry. `productionDeploymentId` is optional on a job, so a verified promotion
  // that adopted v1.4.0 without one kept the dpl_ from v1.3.2 — and the UI presented
  // it as the deployment that proves v1.4.0. Someone rolling back "to the deployment
  // behind v1.4.0" would have rolled back to the wrong build.
  //
  // No evidence is honest ("not recorded for this version"). Wrong evidence is not.
  const patch = deriveBusinessProvenance({
    facts: { commit: 'b'.repeat(40), verifiedAt: 2, buildPassed: true, healthPassed: true }, // no deploymentId
    releaseVersion: '1.4.0',
  })
  assert.equal(patch.currentVersion, '1.4.0')
  assert.ok('currentDeploymentId' in patch, 'the key must be PRESENT so it clears a stale id')
  assert.equal(patch.currentDeploymentId, undefined, 'and carry no id, because this release has none')

  const business = { currentVersion: '1.3.2', currentCommit: 'a'.repeat(40), currentDeploymentId: 'dpl_OLD_1_3_2' }
  const next = { ...business, ...patch }
  assert.equal(next.currentVersion, '1.4.0')
  assert.equal(next.currentDeploymentId, undefined, 'v1.3.2 evidence must not survive onto v1.4.0')
})

test('a version and its evidence always describe the same release', () => {
  const patch = deriveBusinessProvenance({
    facts: { commit: 'c'.repeat(40), deploymentId: 'dpl_NEW', verifiedAt: 9, buildPassed: true, healthPassed: true },
    releaseVersion: '2.0.0',
  })
  const next = { ...{ currentVersion: '1.9.9', currentCommit: 'z', currentDeploymentId: 'dpl_OLD' }, ...patch }
  assert.equal(next.currentVersion, '2.0.0')
  assert.equal(next.currentCommit, 'c'.repeat(40))
  assert.equal(next.currentDeploymentId, 'dpl_NEW')
  assert.equal(patch.lastVerificationAt, 9, 'and the timestamp is that same moment')
})

test('evidence-only verification does NOT clear an existing version', () => {
  // The complementary direction: a deployment with no release version must leave the
  // version and its evidence alone rather than blanking them.
  const patch = deriveBusinessProvenance({
    facts: { commit: 'd'.repeat(40), deploymentId: 'dpl_EV', verifiedAt: 3, buildPassed: true, healthPassed: true },
  })
  assert.ok(!('currentVersion' in patch), 'no version key at all — nothing to clobber')
  const next = { ...{ currentVersion: '1.3.2', currentDeploymentId: 'dpl_OLD' }, ...patch }
  assert.equal(next.currentVersion, '1.3.2', 'the version survives')
  assert.equal(next.currentDeploymentId, 'dpl_EV', 'while the evidence advances to what was actually verified')
})

test('the record assembly applies the WHOLE patch — no field can be dropped in transit', () => {
  // This REPLACED a weaker guard that parsed the field list of BusinessProvenancePatch
  // and checked each name appeared in the assembly. That guard could only ever catch a
  // field somebody forgot to transcribe; it could not catch `?? business.x` inheriting
  // the previous release's value, which was the actual defect. Spreading the patch
  // makes both impossible by construction, so the check here is that the construction
  // itself has not regressed — a much smaller claim, and a true one.
  const reconcile = readFileSync(new URL('../app/lib/platform/automation/reconcile-records.ts', import.meta.url), 'utf8')
  const assembly = /const nextBiz: PlatformBusiness = \{([\s\S]*?)\n  \}/.exec(reconcile)?.[1] ?? ''
  assert.match(assembly, /\.\.\.plan\.business/, 'the whole patch is spread, not transcribed')
  assert.ok(!/currentVersion\s*:\s*plan\.business\.currentVersion\s*\?\?/.test(assembly),
    'field-by-field inheritance is what let stale evidence survive a version change')
})

test('every proposal this module makes is ACCEPTED by the approval gate', () => {
  // The property that matters for "reuses the existing policy": the number an owner is
  // shown must be one the gate would actually accept. If the proposal and
  // evaluateVersionBump() ever disagreed, the UI would advertise a version that is
  // refused the moment it is used — and the two live in different modules, so nothing
  // but this test keeps them aligned. Exhaustive over the type union × breaking.
  const TYPES: PlatformUpdate['type'][] = [
    'feature', 'enhancement', 'bug_fix', 'security', 'performance', 'accessibility',
    'design', 'infrastructure', 'migration', 'configuration', 'documentation',
    'deprecation', 'emergency_hotfix',
  ]
  for (const type of TYPES) {
    for (const breakingChange of [false, true]) {
      for (const migrationRequired of [false, true]) {
        const update = upd({ type, breakingChange, migrationRequired })
        const proposal = proposeNextVersion({ currentVersion: '1.3.2', update })
        assert.equal(proposal.ok, true, `${type}/${breakingChange}`)
        const shape = updateChangeShape(update)
        const verdict = evaluateVersionBump({
          proposedVersion: (proposal as { proposed: string }).proposed,
          previousVersion: '1.3.2',
          classification: shape.classification,
          breakingChange: shape.breakingChange,
          migration: shape.migration,
          channel: 'stable',
        })
        assert.equal(verdict.ok, true,
          `${type} breaking=${breakingChange} migration=${migrationRequired} → proposed ${(proposal as { proposed: string }).proposed} but the gate said ${verdict.reason}`)
      }
    }
  }
})

test('a breaking change proposes major for EVERY update type', () => {
  // The one direction that must never under-propose: if the record says breaking, the
  // proposal has to be a major regardless of how the commit was classified.
  for (const type of ['documentation', 'design', 'bug_fix', 'infrastructure'] as PlatformUpdate['type'][]) {
    const p = proposeNextVersion({ currentVersion: '1.3.2', update: upd({ type, breakingChange: true }) })
    assert.equal((p as { proposed: string }).proposed, '2.0.0', type)
  }
})

test('an ambiguous commit fails toward review, not toward a major', () => {
  // A subject with no conventional prefix classifies as `enhancement` → minor. It must
  // never reach major on ambiguity alone: a major is the one bump that cannot be walked
  // back once a business has been told it, and the record is parked for review anyway.
  const ambiguous = upd({ type: 'enhancement', breakingChange: false, migrationRequired: true })
  const p = proposeNextVersion({ currentVersion: '1.3.2', update: ambiguous })
  assert.equal((p as { proposed: string }).proposed, '1.4.0')
  assert.notEqual((p as { proposed: string }).proposed, '2.0.0')
  assert.match((p as { detail: string }).detail, /Not applied/, 'and it says out loud that nothing was applied')
})
