// Operion Sandbox repair — pure tests: guards (preview/prod/flag/slug/confirm/store),
// canonical record schema + version fields, idempotent repair, malformed detection,
// live-record integrity (no live key changed), and diagnostics safety. No network:
// the service runs against an in-memory fake store injected via deps.
import assert from 'node:assert/strict'
import test from 'node:test'

import { environmentRefusals, repairRefusals, guardsPass, PRODUCTION_KV_HOSTS } from '../app/lib/platform/sandbox/guards'
import {
  buildSandboxRecords, SANDBOX_SLUG, SANDBOX_UPDATE_KEY, SANDBOX_CURRENT_VERSION, SANDBOX_AVAILABLE_VERSION,
  sandboxBusinessValid, sandboxProductValid, sandboxReconciliationValid,
} from '../app/lib/platform/sandbox/records'
import { diagnose, repair, type SandboxDeps } from '../app/lib/platform/sandbox/service'
import { sandboxHealth, SANDBOX_HEALTH_LABEL, type SandboxHealthInput } from '../app/lib/platform/sandbox/health'
import type { PlatformBusiness, PlatformUpdate, UpdateCompatibility } from '../app/lib/platform/updates/types'
import type { SyncProduct, ReconciliationRecord } from '../app/lib/platform/sync/types'

// ── Diagnostics health label (Cleanup Item 2) ────────────────────────────────
const present: SandboxHealthInput['records'] = { business: 'present', product: 'present', reconciliation: 'present', update: 'present', compat: 'present' }
const allMissing: SandboxHealthInput['records'] = { business: 'missing', product: 'missing', reconciliation: 'missing', update: 'missing', compat: 'missing' }
const diagWith = (resolvedStatus: string | null, records: SandboxHealthInput['records'] = present, queryReturnsSandbox = true): SandboxHealthInput => ({ records, queryReturnsSandbox, resolvedStatus })

test('sandbox health: missing only when no record exists', () => {
  assert.equal(sandboxHealth(null), 'missing')
  assert.equal(sandboxHealth(diagWith(null, allMissing, false)), 'missing')
  // record present (product) but query didn't return it yet → still present, not missing
  assert.equal(sandboxHealth(diagWith(null, present, false)), 'present')
})

test('sandbox health: ready across healthy lifecycle states', () => {
  for (const s of ['Update available', 'Ready to publish', 'Up to date', 'Preview ready']) {
    assert.equal(sandboxHealth(diagWith(s)), 'ready', `${s} → ready`)
  }
})

test('sandbox health: present while mid-flow / not set up', () => {
  for (const s of ['Updating…', 'Not set up', 'Checking', 'Preparing Preview', 'Deploying Preview', 'Verifying Preview']) {
    assert.equal(sandboxHealth(diagWith(s)), 'present', `${s} → present`)
  }
})

test('sandbox health: needs attention when record exists but workflow failed', () => {
  assert.equal(sandboxHealth(diagWith('Verification failed')), 'attention')
  assert.equal(sandboxHealth(diagWith('Action required')), 'attention')
  // never "missing" while the record is still there
  assert.notEqual(sandboxHealth(diagWith('Verification failed')), 'missing')
})

test('sandbox health: the four labels are distinct + human', () => {
  assert.deepEqual(
    Object.values(SANDBOX_HEALTH_LABEL),
    ['Sandbox missing', 'Sandbox present', 'Sandbox ready', 'Sandbox needs attention'],
  )
})

const PREVIEW = { vercelEnv: 'preview', requestHost: 'jkissllc-git-x.vercel.app', kvStoreHost: 'operion-preview-1234.upstash.io', repairFlagEnabled: true }

// ── Guards ──────────────────────────────────────────────────────────────────
test('guards: a flagged Preview with a non-production store passes', () => {
  assert.deepEqual(environmentRefusals(PREVIEW), [])
  assert.equal(guardsPass(environmentRefusals(PREVIEW)), true)
})

test('guards: production is refused every independent way', () => {
  assert.ok(environmentRefusals({ ...PREVIEW, vercelEnv: 'production' }).includes('vercel_env_production'))
  assert.ok(environmentRefusals({ ...PREVIEW, vercelEnv: undefined }).includes('not_preview'))
  assert.ok(environmentRefusals({ ...PREVIEW, requestHost: 'jkissllc.com' }).includes('production_domain'))
  assert.ok(environmentRefusals({ ...PREVIEW, requestHost: 'www.jkissllc.com' }).includes('production_domain'))
  assert.ok(environmentRefusals({ ...PREVIEW, repairFlagEnabled: false }).includes('flag_disabled'))
  // store-identity guard: the known production KV host is refused even if env says preview
  assert.ok(environmentRefusals({ ...PREVIEW, kvStoreHost: PRODUCTION_KV_HOSTS[0] }).includes('production_kv_store'))
})

test('guards: repair adds slug + explicit confirmation', () => {
  assert.deepEqual(repairRefusals({ ...PREVIEW, slug: SANDBOX_SLUG, confirm: SANDBOX_SLUG }), [])
  assert.ok(repairRefusals({ ...PREVIEW, slug: 'jkiss', confirm: SANDBOX_SLUG }).includes('wrong_slug'))
  assert.ok(repairRefusals({ ...PREVIEW, slug: SANDBOX_SLUG, confirm: '' }).includes('missing_confirmation'))
  assert.ok(repairRefusals({ ...PREVIEW, slug: SANDBOX_SLUG, confirm: 'yes' }).includes('missing_confirmation'))
})

// ── Records ─────────────────────────────────────────────────────────────────
test('records: canonical shape carries the required fields + versions', () => {
  const r = buildSandboxRecords(1000)
  assert.equal(r.business.slug, SANDBOX_SLUG)
  assert.equal(r.business.currentVersion, SANDBOX_CURRENT_VERSION)   // 0.1.0
  assert.equal(r.business.role, 'target')
  assert.equal(r.business.allowProductionPromotion, false)
  assert.equal(r.business.repoName, 'ratchetnu/operion-sandbox')
  assert.equal(r.business.automationWorkflowFile, 'operion-update.yml')
  assert.equal(r.business.deployProject, 'operion-sandbox')
  assert.match(r.business.notes ?? '', /TEST ONLY/)
  assert.equal(r.product.supportsPlatformSync, true)
  assert.equal(r.reconciliation.platformSync.currentBaselineVersion, SANDBOX_CURRENT_VERSION)
  assert.equal(r.reconciliation.platformSync.latestBaselineVersion, SANDBOX_AVAILABLE_VERSION) // 0.1.1
  assert.equal(r.reconciliation.platformSync.updateAvailable, true)
  assert.equal(r.update.key, SANDBOX_UPDATE_KEY)
  assert.equal(r.update.status, 'approved')
})

// ── In-memory fake store ────────────────────────────────────────────────────
function fakeStore(seed?: Partial<{ businesses: PlatformBusiness[]; products: SyncProduct[]; latest: Record<string, ReconciliationRecord>; updates: Record<string, PlatformUpdate>; compat: Record<string, Record<string, UpdateCompatibility>> }>) {
  const businesses = new Map<string, PlatformBusiness>((seed?.businesses ?? []).map((b) => [b.id, b]))
  const products = new Map<string, SyncProduct>((seed?.products ?? []).map((p) => [p.id, p]))
  const latest = new Map<string, ReconciliationRecord>(Object.entries(seed?.latest ?? {}))
  const updates = new Map<string, PlatformUpdate>(Object.entries(seed?.updates ?? {}))
  const compat = new Map<string, Record<string, UpdateCompatibility>>(Object.entries(seed?.compat ?? {}))
  const writes: string[] = []
  const deps: SandboxDeps = {
    getBusiness: async (id) => businesses.get(id) ?? null,
    saveBusiness: async (b) => { businesses.set(b.id, b); writes.push(`business:${b.id}`) },
    getProduct: async (id) => products.get(id) ?? null,
    saveProduct: async (p) => { products.set(p.id, p); writes.push(`product:${p.id}`); return p },
    getLatest: async (id) => latest.get(id) ?? null,
    saveReconciliation: async (r) => { latest.set(r.productId, r); writes.push(`latest:${r.productId}`) },
    getUpdate: async (k) => updates.get(k) ?? null,
    saveUpdate: async (u) => { updates.set(u.key, u); writes.push(`update:${u.key}`) },
    getCompatMap: async (k) => compat.get(k) ?? {},
    saveCompat: async (c) => { const m = compat.get(c.updateKey) ?? {}; m[c.businessId] = c; compat.set(c.updateKey, m); writes.push(`compat:${c.updateKey}`) },
    listBusinesses: async () => [...businesses.values()],
    listProducts: async () => [...products.values()],
    buildViews: async () => {
      // minimal projection: a product with an updateAvailable reconciliation → update_available
      return [...products.values()].filter((p) => p.status !== 'archived').map((p) => {
        const rec = latest.get(p.id); const biz = businesses.get(p.id)
        const ua = rec?.platformSync?.updateAvailable ?? false
        return {
          id: p.id, name: p.displayName, edition: biz?.edition ?? 'Business',
          status: ua ? 'update_available' : 'up_to_date', statusLabel: ua ? 'Update available' : 'Up to date',
          tone: 'attention' as const, action: ua ? 'update' : 'check', actionLabel: ua ? 'Update' : 'Check for Updates',
          installedVersion: biz?.currentVersion ?? '—', latestVersion: rec?.platformSync?.latestBaselineVersion ?? '—',
          details: { blocking: [], driftReasons: [] },
          detail: { updateSummary: '', previewStatus: '', validationSummary: '', history: [], attention: [], connection: 'Connected' as const },
        }
      })
    },
  }
  return { deps, writes, businesses, products }
}

const liveBiz = (id: string): PlatformBusiness => ({ recordVersion: 1, id, name: id, slug: id, status: 'active', role: 'source', defaultBranch: 'main', releaseChannel: 'stable', updatePolicy: 'manual', updatesPaused: false, manualApprovalRequired: true, autoDeployAllowed: false, healthStatus: 'healthy', createdAt: 1, updatedAt: 1 })
const liveProd = (id: string): SyncProduct => ({ recordVersion: 1, id, displayName: id, productType: 'branded_clone', status: 'active', sourceProvider: 'github', defaultBranch: 'main', deploymentProvider: 'vercel', supportsPlatformSync: true, supportsDeploymentTracking: true, createdAt: 1, updatedAt: 1 })

// ── Repair: missing sandbox ─────────────────────────────────────────────────
test('repair: missing sandbox is created; live records untouched', async () => {
  const { deps, businesses, products } = fakeStore({ businesses: [liveBiz('jkiss'), liveBiz('supercharged')], products: [liveProd('jkiss'), liveProd('supercharged')] })
  const before = new Map([...products].map(([k, v]) => [k, JSON.stringify(v)]))
  const res = await repair('preview', 5000, deps)
  assert.equal(res.keysWritten.length, 5) // all five sandbox keys
  assert.equal(res.integrity.liveRecordsUnchanged, true)
  assert.deepEqual(res.integrity.changedNonSandbox, [])
  // live products byte-identical
  for (const [k, v] of before) assert.equal(JSON.stringify(products.get(k)), v)
  // sandbox now present + query returns it as Update available
  assert.equal(res.diagnostics.queryReturnsSandbox, true)
  assert.equal(res.diagnostics.resolvedStatus, 'Update available')
  assert.equal(res.diagnostics.resolvedAction, 'Update')
  assert.equal(res.diagnostics.currentVersion, '0.1.0')
  assert.equal(res.diagnostics.availableVersion, '0.1.1')
  assert.ok(businesses.has(SANDBOX_SLUG))
})

// ── Repair: idempotent when already valid ───────────────────────────────────
test('repair: idempotent — a valid sandbox is left unchanged on re-run', async () => {
  const { deps, writes } = fakeStore({ businesses: [liveBiz('jkiss')], products: [liveProd('jkiss')] })
  await repair('preview', 5000, deps)
  const writesAfterFirst = writes.length
  const res2 = await repair('preview', 6000, deps)
  assert.equal(res2.keysWritten.length, 0)           // nothing rewritten
  assert.equal(res2.keysUnchanged.length, 5)
  assert.equal(writes.length, writesAfterFirst)       // no new writes at all
})

// ── Repair: malformed sandbox is corrected ──────────────────────────────────
test('repair: a malformed sandbox record is overwritten', async () => {
  const bad = { ...buildSandboxRecords(1).business, currentVersion: '9.9.9', role: 'source' as const }
  const { deps } = fakeStore({ businesses: [liveBiz('jkiss'), bad], products: [liveProd('jkiss')] })
  assert.equal(sandboxBusinessValid(bad), false)
  const res = await repair('preview', 5000, deps)
  assert.ok(res.keysWritten.includes('platform:business:operion-sandbox'))
  assert.equal(res.diagnostics.currentVersion, '0.1.0')
})

// ── Diagnostics: safe payload, missing sandbox flagged ──────────────────────
test('diagnostics: reports missing sandbox and never leaks secrets', async () => {
  const { deps } = fakeStore({ businesses: [liveBiz('jkiss')], products: [liveProd('jkiss')] })
  const d = await diagnose('preview', deps)
  assert.equal(d.records.product, 'missing')
  assert.equal(d.queryReturnsSandbox, false)
  assert.equal(d.needsRepair, true)
  // payload is a plain object with only safe keys — no url/token/host anywhere
  const blob = JSON.stringify(d).toLowerCase()
  assert.equal(blob.includes('token'), false)
  assert.equal(blob.includes('upstash'), false)
  assert.equal(blob.includes('kv_rest'), false)
})

test('records: validity predicates catch missing/malformed', () => {
  const r = buildSandboxRecords(1)
  assert.equal(sandboxProductValid(r.product), true)
  assert.equal(sandboxReconciliationValid(r.reconciliation), true)
  assert.equal(sandboxProductValid(null), false)
  assert.equal(sandboxReconciliationValid({ ...r.reconciliation, platformSync: { ...r.reconciliation.platformSync, updateAvailable: false } }), false)
})
