// Required updates — issue #48 Phase B.
//
// UPD-1004 failed because its files needed two modules from an EARLIER update that
// Supercharged had never received. Phase A caught that at manifest-build time, after
// a job existed and a workflow run had been spent. These tests pin the guarantee one
// step earlier: an update whose prerequisites are not installed and verified on the
// target, or whose exact transfer would not resolve there, never creates a job at all.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  validateDependencies, resolveDependencies, describeDependencyProblems,
  prerequisiteSatisfied, evaluateRequiredUpdates, describeRequiredUpdates, MAX_DEPENDENCIES,
} from '../app/lib/platform/updates/policy'
import { evaluatePreflight } from '../app/lib/platform/automation/preflight'
import type { PlatformUpdate, PlatformBusiness, DeploymentRecord } from '../app/lib/platform/updates/types'

// ── Pure validation ──────────────────────────────────────────────────────────

const KNOWN = new Set(['UPD-1001', 'UPD-1002', 'UPD-1003', 'UPD-1004'])
const noDeps = () => undefined

test('a valid dependency list is accepted, trimmed and de-duplicated', () => {
  const r = validateDependencies({ key: 'UPD-1004', submitted: [' UPD-1001 ', 'UPD-1002', 'UPD-1001'], knownKeys: KNOWN, dependenciesOf: noDeps })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.deepEqual(r.dependencies, ['UPD-1001', 'UPD-1002'])
})

test('an unknown update key is refused', () => {
  const r = validateDependencies({ key: 'UPD-1004', submitted: ['UPD-9999', 'UPD-1001'], knownKeys: KNOWN, dependenciesOf: noDeps })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.deepEqual(r.problems, [{ kind: 'unknown_update', keys: ['UPD-9999'] }])
  assert.match(describeDependencyProblems(r.problems), /unknown required update: UPD-9999/)
})

test('an update cannot require itself', () => {
  const r = validateDependencies({ key: 'UPD-1004', submitted: ['UPD-1004'], knownKeys: KNOWN, dependenciesOf: noDeps })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.problems[0].kind, 'self_dependency')
  assert.match(describeDependencyProblems(r.problems), /UPD-1004 cannot require itself/)
})

test('a dependency cycle is detected and the loop is reported', () => {
  // UPD-1004 → UPD-1002 → UPD-1003 → UPD-1004
  const graph: Record<string, string[]> = { 'UPD-1002': ['UPD-1003'], 'UPD-1003': ['UPD-1004'] }
  const r = validateDependencies({ key: 'UPD-1004', submitted: ['UPD-1002'], knownKeys: KNOWN, dependenciesOf: (k) => graph[k] })
  assert.equal(r.ok, false)
  if (r.ok) return
  const cycle = r.problems.find((p) => p.kind === 'cycle')
  assert.ok(cycle && cycle.kind === 'cycle')
  assert.deepEqual(cycle.path, ['UPD-1004', 'UPD-1002', 'UPD-1003', 'UPD-1004'])
  assert.match(describeDependencyProblems(r.problems), /form a loop/)
})

test('a two-node cycle is detected', () => {
  const r = validateDependencies({ key: 'UPD-1004', submitted: ['UPD-1001'], knownKeys: KNOWN, dependenciesOf: (k) => (k === 'UPD-1001' ? ['UPD-1004'] : undefined) })
  assert.equal(r.ok, false)
})

test('a diamond is not a cycle', () => {
  const graph: Record<string, string[]> = { 'UPD-1002': ['UPD-1001'], 'UPD-1003': ['UPD-1001'] }
  const r = validateDependencies({ key: 'UPD-1004', submitted: ['UPD-1002', 'UPD-1003'], knownKeys: KNOWN, dependenciesOf: (k) => graph[k] })
  assert.equal(r.ok, true, 'two paths to the same prerequisite is legitimate')
})

test('malformed lists fail closed rather than storing "no requirements"', () => {
  for (const bad of ['UPD-1001', 42, null, {}]) {
    const r = validateDependencies({ key: 'UPD-1004', submitted: bad, knownKeys: KNOWN, dependenciesOf: noDeps })
    assert.equal(r.ok, false, JSON.stringify(bad))
  }
  const nonString = validateDependencies({ key: 'UPD-1004', submitted: ['UPD-1001', 7], knownKeys: KNOWN, dependenciesOf: noDeps })
  assert.equal(nonString.ok, false)
  const tooMany = validateDependencies({ key: 'UPD-1004', submitted: Array.from({ length: MAX_DEPENDENCIES + 1 }, (_, i) => `UPD-${i}`), knownKeys: KNOWN, dependenciesOf: noDeps })
  assert.equal(tooMany.ok, false)
  if (!tooMany.ok) assert.equal(tooMany.problems[0].kind, 'too_many')
})

test('PATCH semantics: omitted preserves, explicit [] clears, a new list replaces', () => {
  const existing = ['UPD-1001']
  assert.deepEqual(resolveDependencies(existing, undefined), existing)
  assert.deepEqual(resolveDependencies(existing, []), [])
  assert.deepEqual(resolveDependencies(existing, ['UPD-1002']), ['UPD-1002'])
  assert.deepEqual(resolveDependencies(undefined, undefined), undefined)
})

// ── Target-specific prerequisite verification ───────────────────────────────

const dep = (o: Partial<DeploymentRecord> = {}): DeploymentRecord => ({
  recordVersion: 1, id: 'dep_1', businessId: 'supercharged', updateKeys: ['UPD-1001'],
  status: 'deployed', verificationStatus: 'passed', rollbackAvailable: false,
  createdAt: 1, updatedAt: 1, ...o,
} as DeploymentRecord)

test('already_present compatibility satisfies a prerequisite', () => {
  const r = prerequisiteSatisfied({ updateKey: 'UPD-1001', compatStatus: 'already_present', deployments: [], businessId: 'supercharged' })
  assert.deepEqual(r, { satisfied: true, via: 'already_present' })
})

test('a deployed + verified deployment satisfies a prerequisite', () => {
  for (const verificationStatus of ['passed', 'waived'] as const) {
    const r = prerequisiteSatisfied({ updateKey: 'UPD-1001', deployments: [dep({ verificationStatus })], businessId: 'supercharged' })
    assert.deepEqual(r, { satisfied: true, via: 'verified_deployment' }, verificationStatus)
  }
})

test('missing, unfinished or unverified deployments do NOT satisfy a prerequisite', () => {
  const cases: Array<[string, DeploymentRecord[], RegExp]> = [
    ['no deployment at all', [], /not installed/],
    ['for a different business', [dep({ businessId: 'other' })], /not installed/],
    ['for a different update', [dep({ updateKeys: ['UPD-9999'] })], /not installed/],
    ['still in progress', [dep({ status: 'in_progress' })], /never finished deploying/],
    ['rolled back', [dep({ status: 'rolled_back' })], /never finished deploying/],
    ['deployed but pending verification', [dep({ verificationStatus: 'pending' })], /not verified yet/],
    ['deployed but verification failed', [dep({ verificationStatus: 'failed' })], /not verified yet/],
  ]
  for (const [label, deployments, reason] of cases) {
    const r = prerequisiteSatisfied({ updateKey: 'UPD-1001', deployments, businessId: 'supercharged' })
    assert.equal(r.satisfied, false, label)
    assert.match(r.reason ?? '', reason, label)
  }
})

test('evaluateRequiredUpdates rolls the per-dependency verdicts up', () => {
  const r = evaluateRequiredUpdates({
    dependencies: ['UPD-1001', 'UPD-1002'],
    businessId: 'supercharged',
    compatStatusFor: (k) => (k === 'UPD-1002' ? 'already_present' : undefined),
    deployments: [dep({})],
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.verdicts.map((v) => v.via), ['verified_deployment', 'already_present'])

  const blocked = evaluateRequiredUpdates({
    dependencies: ['UPD-1001', 'UPD-1003'],
    businessId: 'supercharged',
    compatStatusFor: () => undefined,
    deployments: [dep({})],
  })
  assert.equal(blocked.ok, false)
  assert.deepEqual(blocked.missing, ['UPD-1003'])
  assert.match(describeRequiredUpdates(blocked.verdicts), /UPD-1003 \(not installed on this business yet\)/)
})

test('an update with NO dependencies is satisfied with zero work — backward compatible', () => {
  for (const dependencies of [undefined, []]) {
    const r = evaluateRequiredUpdates({ dependencies, businessId: 'supercharged', compatStatusFor: () => undefined, deployments: [] })
    assert.equal(r.ok, true)
    assert.deepEqual(r.verdicts, [])
    assert.deepEqual(r.missing, [])
  }
})

// ── Preflight gates ─────────────────────────────────────────────────────────

const PASS = { typecheck: 'passed', lint: 'passed', tests: 'passed', build: 'passed', securityReview: 'not_applicable', accessibilityReview: 'not_applicable', e2e: 'not_applicable', smokeTest: 'passed', ownerVerification: 'passed' }
const update = (p: Partial<PlatformUpdate> = {}): PlatformUpdate => ({
  recordVersion: 1, key: 'UPD-1004', title: 'T', summary: 'S', type: 'feature', scope: 'platform_core',
  severity: 'low', priority: 'normal', status: 'approved', breakingChange: false, migrationRequired: false,
  environmentChangeRequired: false, secretRequired: false, featureFlagRequired: false, manualPortRequired: false,
  rollbackSupported: true, validation: PASS, sourceCommit: 'abc1234', createdAt: 1, updatedAt: 1, ...p,
} as PlatformUpdate)
const business = (p: Partial<PlatformBusiness> = {}): PlatformBusiness => ({
  recordVersion: 1, id: 'supercharged', name: 'Supercharged', role: 'target',
  repoName: 'ratchetnu/supercharged', defaultBranch: 'main', githubInstallationId: '999',
  automationWorkflowFile: 'operion-update.yml', configurationStatus: 'ready',
  previewProjectId: 'prj', previewDeploymentProvider: 'vercel', healthStatus: 'healthy',
  createdAt: 1, updatedAt: 1, ...p,
} as PlatformBusiness)
const base = {
  update: update(), business: business(), compat: { status: 'compatible' } as never, hasActiveJob: false,
  flags: { automation: true, preview: true, githubActions: true, controlPlane: true },
}
const gate = (r: ReturnType<typeof evaluatePreflight>, id: string) => r.gates.find((g) => g.id === id)!

test('required_updates blocks with an actionable reason and passes when satisfied', () => {
  const blocked = evaluatePreflight({ ...base, requiredUpdates: { ok: false, missing: ['UPD-1001'], detail: 'UPD-1001 (deployed but not verified yet)' } })
  const g = gate(blocked, 'required_updates')
  assert.equal(g.ok, false)
  assert.equal(g.blocking, true)
  assert.match(g.reason ?? '', /needs UPD-1001 on this business first — UPD-1001 \(deployed but not verified yet\)/)
  assert.equal(blocked.ok, false)

  assert.equal(gate(evaluatePreflight({ ...base, requiredUpdates: { ok: true, missing: [] } }), 'required_updates').ok, true)
})

test('transfer_ready blocks with the builder reason and passes when the transfer resolves', () => {
  const reason = 'dependency closure failed — the target is missing 2 required modules: app/lib/intake-workflow.ts (imported by app/lib/record-payment.ts as "./intake-workflow")'
  const blocked = evaluatePreflight({ ...base, transferReady: { ok: false, reason } })
  const g = gate(blocked, 'transfer_ready')
  assert.equal(g.ok, false)
  assert.equal(g.blocking, true)
  assert.equal(g.reason, reason)
  assert.equal(blocked.ok, false)

  assert.equal(gate(evaluatePreflight({ ...base, transferReady: { ok: true } }), 'transfer_ready').ok, true)
})

test('an update with no dependencies keeps its previous preflight outcome', () => {
  // Neither field supplied — exactly what every pre-existing record produces.
  const r = evaluatePreflight(base)
  assert.equal(gate(r, 'required_updates').ok, true)
  assert.equal(gate(r, 'transfer_ready').ok, true)
  assert.equal(r.ok, true, 'a previously-ready update must remain ready')
})
