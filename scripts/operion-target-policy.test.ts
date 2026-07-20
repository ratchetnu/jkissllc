// Operion managed-target transfer boundary — hermetic tests (no I/O, no network).
// Proves a managed target can never receive control-plane files, that safe transfers
// still work, and that enforcement holds at build, apply, and policy layers.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isControlPlanePath, classifyComponent, evaluateTransfer, enforceManifestPolicy,
  CONTROL_PLANE_PATH_PREFIXES, TARGET_POLICY_VERSION,
} from '../app/lib/platform/automation/target-policy'
import { applyManifest, type FsAdapter } from '../app/lib/platform/automation/apply-executor'
import { sha256, type ApplyManifest } from '../app/lib/platform/automation/manifest'
import { buildCommitTransferManifest } from '../app/lib/platform/automation/manifest-builder'
import type { UpdateAutomationProvider } from '../app/lib/platform/automation/provider'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const content = (s: string) => ({ contentBase64: b64(s), sha256: sha256(Buffer.from(s, 'utf8')) })
function memFs(seed: Record<string, string> = {}): FsAdapter & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed))
  return { files, exists: p => files.has(p), read: p => files.get(p) ?? null, write: (p, c) => { files.set(p, c.toString('utf8')) }, remove: p => { files.delete(p) } }
}
function mkManifest(entries: ApplyManifest['entries'], extra: Partial<ApplyManifest> = {}): ApplyManifest {
  return { updateKey: 'UPD-1', sourceRepo: 'ratchetnu/jkissllc', sourceCommit: 'abc', entries, ...extra }
}
function mockProvider(files: { filename: string; status: string }[], blobs: Record<string, string>): UpdateAutomationProvider {
  const p: Partial<UpdateAutomationProvider> = {
    name: 'mock',
    readCommitFiles: async () => ({ ok: true, data: { files } }),
    readFileContent: async (_i, _r, path) => (path in blobs)
      ? { ok: true, data: content(blobs[path]) }
      : { ok: false, error: 'not found', category: 'not_found' },
  }
  return p as UpdateAutomationProvider
}
const REPO = { owner: 'ratchetnu', name: 'jkissllc' }
const TARGET = { businessId: 'supercharged', role: 'target' as const }

// ── Path classification ──────────────────────────────────────────────────────
test('isControlPlanePath: every family matches segment-aware; near-matches do not', () => {
  for (const fam of CONTROL_PLANE_PATH_PREFIXES) {
    assert.equal(isControlPlanePath(fam), true, `exact ${fam}`)
    assert.equal(isControlPlanePath(`${fam}/route.ts`), true, `under ${fam}`)
    assert.equal(isControlPlanePath(`${fam}/deep/nested/x.tsx`), true, `deep ${fam}`)
  }
  for (const safe of [
    'app/lib/platform/release-notes/x.ts',   // "release-notes" ≠ "release"
    'app/lib/platform/automation-docs/x.ts', // "automation-docs" ≠ "automation"
    'app/api/admin/releases-archive/x.ts',   // "releases-archive" ≠ "release"
    'app/admin/operations/dashboard/x.tsx',  // "dashboard" ≠ "release"
    'app/lib/platform/tenancy/keys.ts',      // shared multi-tenant runtime
    'app/lib/release/manifest.ts',           // read-only snapshot lib (not platform/release)
    'app/lib/businesses/supercharged.ts',
    'app/components/Button.tsx',
  ]) assert.equal(isControlPlanePath(safe), false, safe)
})

test('classifyComponent labels control-plane vs business runtime', () => {
  assert.equal(classifyComponent('app/lib/platform/automation/orchestrator.ts'), 'operion_control_plane')
  assert.equal(classifyComponent('app/api/admin/release/route.ts'), 'operion_control_plane')
  assert.equal(classifyComponent('app/components/Button.tsx'), 'operion_business_runtime')
})

// ── Managed target rejects every forbidden family ────────────────────────────
test('managed target rejects every control-plane path family (CONTROL_PLANE_PATH_FORBIDDEN)', () => {
  for (const fam of CONTROL_PLANE_PATH_PREFIXES) {
    const r = evaluateTransfer([`${fam}/x.ts`], { businessId: 'supercharged', role: 'target' })
    assert.equal(r.ok, false, fam)
    assert.equal(r.violations[0].code, 'CONTROL_PLANE_PATH_FORBIDDEN', fam)
  }
})

test('apply executor rejects a control-plane path for a managed target across add / modify / delete', () => {
  for (const action of ['add', 'modify', 'delete'] as const) {
    const path = 'app/lib/platform/automation/evil.ts'
    const del = action === 'delete'
    const entry: ApplyManifest['entries'][number] = del ? { path, action } : { path, action, sha256: content('x').sha256 }
    const fs = memFs(del ? { [path]: 'pre-existing' } : {})
    const contents: Record<string, { contentBase64: string; sha256: string }> = del ? {} : { [path]: content('x') }
    const res = applyManifest(mkManifest([entry], { policyVersion: TARGET_POLICY_VERSION, target: TARGET }), contents, fs)
    assert.equal(res.ok, false, action)
    assert.equal(res.applied.length, 0, action)
    assert.equal(res.failed[0].reason, 'CONTROL_PLANE_PATH_FORBIDDEN', action)
    if (action === 'delete') assert.equal(fs.files.get(path), 'pre-existing', 'delete: file must NOT be removed')
    else assert.equal(fs.files.has(path), false, `${action}: file must NOT be written`)
  }
})

// ── Safe transfers still work ────────────────────────────────────────────────
test('near-match safe paths are not falsely rejected for a managed target', () => {
  const r = evaluateTransfer([
    'app/lib/platform/release-notes/x.ts', 'app/lib/platform/automation-docs/x.ts',
    'app/lib/release/manifest.ts', 'app/lib/platform/tenancy/keys.ts',
  ], TARGET)
  assert.equal(r.ok, true)
})

test('safe shared-runtime files transfer to a managed target', () => {
  const r = evaluateTransfer(['app/components/Button.tsx', 'app/lib/pricing.ts', 'app/api/health/route.ts'], TARGET)
  assert.equal(r.ok, true)
})

test('industry-pack and business-specific safe files transfer to an eligible target', () => {
  const r = evaluateTransfer(['app/industry/junk-removal/pack.ts', 'app/businesses/supercharged/theme.ts'], { ...TARGET, edition: 'standard' })
  assert.equal(r.ok, true)
})

// ── Traversal / separator tricks ─────────────────────────────────────────────
test('traversal / separator tricks remain rejected even with target context', () => {
  for (const path of ['../app/lib/platform/automation/x.ts', 'app/lib/platform/automation/..\\x.ts', '/app/lib/platform/automation/x.ts']) {
    const fs = memFs()
    const res = applyManifest(mkManifest([{ path, action: 'add', sha256: content('x').sha256 }], { policyVersion: TARGET_POLICY_VERSION, target: TARGET }), { [path]: content('x') }, fs)
    assert.equal(res.ok, false, path)
    assert.equal(fs.files.size, 0, path)
  }
})

// ── Fail-closed context ──────────────────────────────────────────────────────
test('missing / unknown target role fails closed (TARGET_CONTEXT_REQUIRED)', () => {
  for (const role of [undefined, 'nonsense', '']) {
    const r = evaluateTransfer(['app/safe.ts'], { businessId: 'x', role: role as never })
    assert.equal(r.ok, false, String(role))
    assert.equal(r.violations[0].code, 'TARGET_CONTEXT_REQUIRED', String(role))
  }
})

test('server-resolved target context overrides a forged manifest role', () => {
  const path = 'app/lib/platform/release/rollback.ts'
  const forged = mkManifest([{ path, action: 'add', sha256: content('x').sha256 }], { policyVersion: TARGET_POLICY_VERSION, target: { businessId: 'supercharged', role: 'source_and_target' } })
  // Forged 'source_and_target' role, taken alone, would allow the control-plane file:
  assert.equal(applyManifest(forged, { [path]: content('x') }, memFs()).ok, true)
  // But the server-resolved real role ('target') is authoritative and rejects it:
  const fs = memFs()
  const res = applyManifest(forged, { [path]: content('x') }, fs, { target: TARGET })
  assert.equal(res.ok, false)
  assert.equal(res.failed[0].reason, 'CONTROL_PLANE_PATH_FORBIDDEN')
  assert.equal(fs.files.size, 0)
})

// ── Control plane may retain control-plane files ─────────────────────────────
test('control-plane business (source / source_and_target) may retain control-plane files', () => {
  const paths = ['app/lib/platform/automation/orchestrator.ts', 'app/api/admin/release/route.ts']
  assert.equal(evaluateTransfer(paths, { businessId: 'jkiss', role: 'source_and_target' }).ok, true)
  assert.equal(evaluateTransfer(paths, { businessId: 'jkiss', role: 'source' }).ok, true)
})

// ── componentsToExclude ──────────────────────────────────────────────────────
test('componentsToExclude is enforced; unsafe patterns fail closed; near-matches are safe', () => {
  const r1 = evaluateTransfer(['app/experimental/x.ts', 'app/safe.ts'], { ...TARGET, componentsToExclude: ['app/experimental'] })
  assert.equal(r1.ok, false)
  assert.ok(r1.violations.some(v => v.code === 'COMPONENT_EXCLUDED' && v.path === 'app/experimental/x.ts'))
  assert.equal(evaluateTransfer(['app/x/deep/y.ts'], { ...TARGET, componentsToExclude: ['app/x/**'] }).ok, false)   // recursive
  assert.equal(evaluateTransfer(['app/keep.ts', 'app/drop.ts'], { ...TARGET, componentsToExclude: ['app/drop.ts'] }).ok, false) // exact file
  assert.equal(evaluateTransfer(['app/experimental-ok/x.ts'], { ...TARGET, componentsToExclude: ['app/experimental'] }).ok, true) // near-match NOT excluded
  for (const bad of ['../etc', 'app/**/*', 'app/a*', '/abs', 'a\\b', '~/x']) {
    const r = evaluateTransfer(['app/whatever.ts'], { ...TARGET, componentsToExclude: [bad] })
    assert.equal(r.ok, false, bad)
    assert.ok(r.violations.some(v => v.code === 'COMPONENT_EXCLUDED'), bad)
  }
})

// ── Policy version + legacy behavior ─────────────────────────────────────────
test('legacy manifest: apply executor applies path-safe files with no target context (back-compat)', () => {
  const path = 'app/safe.ts'
  const fs = memFs()
  const res = applyManifest(mkManifest([{ path, action: 'add', sha256: content('v').sha256 }]), { [path]: content('v') }, fs)
  assert.equal(res.ok, true)
  assert.equal(fs.files.get(path), 'v')
})

test('legacy manifest without policy version fails closed for cross-repo (MANIFEST_POLICY_VERSION_UNSUPPORTED)', () => {
  const r = enforceManifestPolicy({ paths: ['app/x.ts'], policyVersion: undefined, target: TARGET, requirePolicyVersion: true })
  assert.equal(r.ok, false)
  assert.equal(r.violations[0].code, 'MANIFEST_POLICY_VERSION_UNSUPPORTED')
})

test('unsupported policy version is rejected', () => {
  const r = enforceManifestPolicy({ paths: ['app/x.ts'], policyVersion: 999, target: TARGET })
  assert.equal(r.ok, false)
  assert.equal(r.violations[0].code, 'MANIFEST_POLICY_VERSION_UNSUPPORTED')
})

// ── Apply executor independent rejection via embedded metadata ───────────────
test('apply executor independently rejects a forbidden manifest via its embedded target metadata', () => {
  const path = 'app/api/admin/release/businesses/[id]/rollback/route.ts'
  const fs = memFs()
  const res = applyManifest(mkManifest([{ path, action: 'add', sha256: content('x').sha256 }], { policyVersion: TARGET_POLICY_VERSION, target: TARGET }), { [path]: content('x') }, fs)
  assert.equal(res.ok, false)
  assert.equal(res.failed[0].reason, 'CONTROL_PLANE_PATH_FORBIDDEN')
  assert.equal(fs.files.size, 0)
})

// ── Manifest builder integration ─────────────────────────────────────────────
test('manifest builder rejects control-plane files for a managed target and stamps metadata for the control plane', async () => {
  const blocked = await buildCommitTransferManifest({
    provider: mockProvider([{ filename: 'app/lib/platform/automation/x.ts', status: 'added' }], { 'app/lib/platform/automation/x.ts': 'x' }),
    installationId: '1', sourceRepo: REPO, sourceRepoName: 'ratchetnu/jkissllc', sourceCommit: 'abc', updateKey: 'UPD-9', target: TARGET,
  })
  assert.equal(blocked.ok, false)
  assert.equal((blocked as { code?: string }).code, 'CONTROL_PLANE_PATH_FORBIDDEN')

  const allowed = await buildCommitTransferManifest({
    provider: mockProvider([{ filename: 'app/lib/platform/automation/x.ts', status: 'added' }], { 'app/lib/platform/automation/x.ts': 'x' }),
    installationId: '1', sourceRepo: REPO, sourceRepoName: 'ratchetnu/jkissllc', sourceCommit: 'abc', updateKey: 'UPD-9', target: { businessId: 'jkiss', role: 'source_and_target', edition: 'internal' },
  })
  assert.equal(allowed.ok, true)
  if (allowed.ok) {
    assert.equal(allowed.data.manifest.policyVersion, TARGET_POLICY_VERSION)
    assert.equal(allowed.data.manifest.target?.role, 'source_and_target')
    assert.equal(allowed.data.manifest.target?.businessId, 'jkiss')
  }
})

test('manifest builder enforces componentsToExclude for a managed target', async () => {
  const r = await buildCommitTransferManifest({
    provider: mockProvider([{ filename: 'app/beta/x.ts', status: 'added' }], { 'app/beta/x.ts': 'x' }),
    installationId: '1', sourceRepo: REPO, sourceRepoName: 'ratchetnu/jkissllc', sourceCommit: 'abc', updateKey: 'UPD-10',
    target: { ...TARGET, componentsToExclude: ['app/beta'] },
  })
  assert.equal(r.ok, false)
  assert.equal((r as { code?: string }).code, 'COMPONENT_EXCLUDED')
})

// ── No secret leakage ────────────────────────────────────────────────────────
test('violation messages and stamped manifests contain no secrets/env values', () => {
  const r = evaluateTransfer(['app/lib/platform/automation/x.ts'], { ...TARGET, componentsToExclude: ['../bad'] })
  const blob = JSON.stringify(r)
  for (const s of ['TOKEN', 'SECRET', 'VERCEL_TOKEN', 'process.env', 'Bearer ', 'password', 'cookie', 'OPERION_CALLBACK']) {
    assert.equal(blob.includes(s), false, s)
  }
})
