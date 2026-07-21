// Product Synchronization Platform — unit tests for the pure logic: manifest schema
// (normalize, validate, status machine), classification (+ exclusion rules), the
// adaptation planner (blockers, gates, rollback), and the drift model. No I/O.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeManifest, validateManifest, canTransition, isTerminal, STATUSES,
  type UpdateManifest,
} from '../tools/product-sync/manifest/schema'
import { classifyUpdate, matchedExclusion, DEFAULT_SIGNALS } from '../tools/product-sync/classify'
import { buildAdaptationPlan, planIsImplementable } from '../tools/product-sync/plan'
import { summarizeDrift, answerDriftQuestions, type DriftItem, type DriftReport } from '../tools/product-sync/drift'

const base = (over: Partial<UpdateManifest> = {}): UpdateManifest =>
  normalizeManifest({ id: 'OBS-001', title: 'AI Pipeline Observability', ...over })

// ── Schema: normalize + validate ─────────────────────────────────────────────

test('normalizeManifest fills safe defaults from a terse entry', () => {
  const m = base()
  assert.equal(m.schemaVersion, 1)
  assert.equal(m.status, 'discovered')
  assert.equal(m.classification, 'manual-review')
  assert.equal(m.rollout.featureFlagsOffByDefault, true) // safety default
  assert.deepEqual(m.surface.featureFlags, [])
  assert.deepEqual(m.history, [])
})

test('validateManifest enforces the flags-OFF safety invariant', () => {
  const bad = base({ rollout: { featureFlagsOffByDefault: false, previewValidationRequired: true, requiresMigration: false, requiresEnvConfig: false } })
  const issues = validateManifest(bad)
  assert.ok(issues.some((i) => i.severity === 'error' && i.field === 'rollout.featureFlagsOffByDefault'))
})

test('validateManifest rejects malformed id + upstream==downstream', () => {
  assert.ok(validateManifest(base({ id: 'lowercase' })).some((i) => i.field === 'id' && i.severity === 'error'))
  assert.ok(validateManifest(base({ product: { upstream: 'operion', downstream: 'operion' } })).some((i) => i.field === 'product' && i.severity === 'error'))
})

test('validateManifest warns on behavioral surface without a flag', () => {
  const m = base({ surface: { ...base().surface, apis: ['app/api/x/route.ts'] } })
  assert.ok(validateManifest(m).some((i) => i.severity === 'warning' && i.field === 'surface.featureFlags'))
})

test('a valid registry-style entry has no errors', () => {
  const m = base({ classification: 'adaptation-required', surface: { ...base().surface, featureFlags: ['AI_PIPELINE_OBSERVABILITY_ENABLED'], apis: ['app/api/admin/ai/pipeline/route.ts'] } })
  assert.deepEqual(validateManifest(m).filter((i) => i.severity === 'error'), [])
})

// ── Status machine ───────────────────────────────────────────────────────────

test('status machine allows forward steps + block/reject, rejects skips', () => {
  assert.equal(canTransition('discovered', 'planned'), true)
  assert.equal(canTransition('planned', 'approved'), true)
  assert.equal(canTransition('approved', 'adapting'), true)
  assert.equal(canTransition('discovered', 'merged'), false)   // no skipping
  assert.equal(canTransition('adapting', 'blocked'), true)
  assert.equal(canTransition('verified', 'rejected'), false)   // reject only from early states/blocked
  assert.equal(canTransition('released', 'discovered'), false) // terminal
  assert.equal(isTerminal('released'), true)
  assert.equal(isTerminal('rejected'), true)
  assert.equal(STATUSES.length, 11)
})

// ── Classification ───────────────────────────────────────────────────────────

test('Release Center is EXCLUDED by policy', () => {
  const rel = base({ id: 'REL-001', title: 'Release Center', description: 'Operion release orchestration', surface: { ...base().surface, routes: ['/admin/operations/release'] } })
  assert.equal(matchedExclusion(rel), 'release-center')
  assert.equal(classifyUpdate(rel), 'excluded')
})

test('classifyUpdate: direct-port when absent + self-contained', () => {
  const m = base({ id: 'WRK-001', title: 'Graceful worker deadline' })
  assert.equal(classifyUpdate(m, { ...DEFAULT_SIGNALS, filesPresentRatio: 0 }), 'direct-port')
})

test('classifyUpdate: adaptation-required when branding/dep/migration/API needed', () => {
  const m = base({ id: 'UX-001', title: 'Progress UX' })
  assert.equal(classifyUpdate(m, { ...DEFAULT_SIGNALS, brandingCoupled: true }), 'adaptation-required')
})

test('classifyUpdate: already-present vs partially-present', () => {
  const m = base({ id: 'X-001', title: 'X' })
  assert.equal(classifyUpdate(m, { ...DEFAULT_SIGNALS, filesPresentRatio: 1, filesMatchingRatio: 1 }), 'already-present')
  assert.equal(classifyUpdate(m, { ...DEFAULT_SIGNALS, filesPresentRatio: 0.5, filesMatchingRatio: 0.5 }), 'partially-present')
})

// ── Adaptation planner ───────────────────────────────────────────────────────

test('planner blocks an EXCLUDED update', () => {
  const rel = base({ id: 'REL-001', title: 'Release Center', classification: 'excluded', surface: { ...base().surface, routes: ['/admin/operations/release'] } })
  const p = buildAdaptationPlan(rel)
  assert.ok(p.blockers.some((b) => /EXCLUDED/.test(b)))
  assert.equal(planIsImplementable(p), false)
})

test('planner blocks on unmet dependencies', () => {
  const m = base({ id: 'LAT-001', title: 'AI Latency', classification: 'adaptation-required', dependencies: ['OBS-001'], surface: { ...base().surface, sharedUtilities: ['app/lib/x.ts'] } })
  const p = buildAdaptationPlan(m)
  assert.ok(p.blockers.some((b) => /OBS-001/.test(b)))
  assert.equal(planIsImplementable(p), false)
})

test('planner: implementable plan lists reused/adapted, gates, rollback', () => {
  const m = base({
    id: 'UX-001', title: 'Progress UX', classification: 'adaptation-required',
    surface: { ...base().surface, featureFlags: ['OPERION_PROGRESS_UX'], sharedUtilities: ['app/lib/ai/progress-stages.ts'], ui: ['app/quote/CalibratedProgress.tsx'] },
  })
  const p = buildAdaptationPlan(m)
  assert.ok(p.sourceFiles.length >= 2)
  assert.ok(p.functionsAdapted.includes('app/quote/CalibratedProgress.tsx')) // UI is adapted
  assert.ok(p.functionsReused.includes('app/lib/ai/progress-stages.ts'))     // pure logic reused
  assert.ok(p.gatesRequired.includes('feature-flags-off'))
  assert.ok(p.rollback.some((r) => /OPERION_PROGRESS_UX/.test(r)))            // flag-off rollback first
  assert.equal(planIsImplementable(p), true)
})

test('planner escalates risk for migrations/auth', () => {
  const m = base({ id: 'SEC-001', title: 'x', classification: 'direct-port', surface: { ...base().surface, sharedUtilities: ['a.ts'], databaseMigrations: ['001_init.sql'] }, riskLevel: 'low' })
  assert.equal(buildAdaptationPlan(m).riskLevel, 'high')
})

// ── Drift model ──────────────────────────────────────────────────────────────

test('summarizeDrift counts by kind + most-affected files', () => {
  const items: DriftItem[] = [
    { kind: 'changed-file', ref: 'a.ts' }, { kind: 'api', ref: 'a.ts' },
    { kind: 'changed-file', ref: 'b.ts' }, { kind: 'feature-flag', ref: 'FLAG' },
  ]
  const s = summarizeDrift(items)
  assert.equal(s.total, 4)
  assert.equal(s.byKind['changed-file'], 2)
  assert.equal(s.topFiles[0].ref, 'a.ts')      // two kinds → most affected
  assert.equal(s.topFiles[0].kinds.length, 2)
})

test('answerDriftQuestions maps the registry rollup to the six questions', () => {
  const report: DriftReport = {
    generatedAt: 'x', upstream: { product: 'operion', repo: 'r', head: 'h' },
    downstream: { product: 'supercharged', repo: 'r', head: 'h' },
    items: [{ kind: 'changed-file', ref: 'a' }, { kind: 'changed-file', ref: 'b' }],
  }
  const a = answerDriftQuestions(report, {
    total: 8,
    byStatus: { discovered: 6, rejected: 1, blocked: 1 },
    byClassification: { 'adaptation-required': 5, excluded: 1, 'partially-present': 2 },
  })
  assert.equal(a.changedUpstream, 2)
  assert.equal(a.notSynchronized, 6)   // discovered
  assert.equal(a.blocked, 1)
  assert.equal(a.excluded, 1)
  assert.equal(a.partiallyAdapted, 2)
  assert.equal(a.intentionallyDifferent, 2) // excluded(1) + rejected(1)
})
