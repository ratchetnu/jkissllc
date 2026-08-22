// ── The guarantees, stated as tests ─────────────────────────────────────────
//
// One sentence holds this file together: a business that does not use an optional
// integration is CONFIGURED, not BROKEN — and must keep receiving software updates
// exactly like one that does.
//
// The failure this guards against is subtle and expensive. "No Stripe key" and "the
// deployment is unwell" look identical if you only have one word for both, and once
// they look identical, withholding a security fix from the business that declined
// card payments looks like caution.
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret-32byteslong!!'
process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'
process.env.CRON_SECRET = 'test-cron-secret'
process.env.TENANCY_ENABLED = 'true'

const UPSTASH = 'http://fake-upstash.local'
const kv = new Map<string, string>()
const zsets = new Map<string, Map<string, number>>()
const z = (key: string) => zsets.get(key) ?? zsets.set(key, new Map()).get(key)!
/** Every call that is NOT the fake store — i.e. every real external provider call. */
const externalCalls: string[] = []
let beforeCapabilityProfileCas: ((key: string) => void) | undefined

globalThis.fetch = (async (url: string, init: { body?: string } = {}) => {
  if (url !== UPSTASH) {
    externalCalls.push(String(url))
    return { ok: false, status: 599, json: async () => ({}), text: async () => '' }
  }
  const [command, ...args] = JSON.parse(init.body as string) as string[]
  const key = args[0]
  let result: unknown = null
  switch (command.toUpperCase()) {
    case 'GET': result = kv.get(key) ?? null; break
    case 'SET': kv.set(key, args[1]); result = 'OK'; break
    case 'DEL': kv.delete(key); result = 1; break
    case 'INCR': { const v = Number(kv.get(key) ?? 0) + 1; kv.set(key, String(v)); result = v; break }
    case 'ZADD': z(key).set(args[2], Number(args[1])); result = 1; break
    case 'ZREM': z(key).delete(args[1]); result = 1; break
    case 'ZCARD': result = z(key).size; break
    case 'ZRANGE':
    case 'ZREVRANGE': {
      const v = [...z(key)].sort((a, b) => a[1] - b[1]).map(([m]) => m)
      if (command.toUpperCase() === 'ZREVRANGE') v.reverse()
      result = v.slice(Number(args[1]), Number(args[2]) === -1 ? undefined : Number(args[2]) + 1)
      break
    }
    case 'PEXPIRE':
    case 'EXPIRE': result = 1; break
    case 'EVAL': {
      const script = args[0]
      if (!script.includes('CAPABILITY_PROFILE_CAS')) throw new Error('fake redis: unhandled EVAL')
      const casKey = args[2]
      beforeCapabilityProfileCas?.(casKey)
      beforeCapabilityProfileCas = undefined
      const current = kv.get(casKey)
      const mode = args[3]
      const expected = args[4]
      const next = args[5]
      if ((mode === 'absent' && current !== undefined) || (mode !== 'absent' && current !== expected)) result = 0
      else { kv.set(casKey, next); result = 1 }
      break
    }
    default: throw new Error(`fake redis: unhandled ${command}`)
  }
  return { ok: true, status: 200, json: async () => ({ result }) }
}) as unknown as typeof fetch

import { NextRequest } from 'next/server'
import { evaluatePreflight, classifyPreflight, type PreflightGate } from '../app/lib/platform/automation/preflight'
import { evaluateCapabilityImpact } from '../app/lib/platform/automation/target-evidence'
import { resolveSourceArtifact, previewMatchesArtifact } from '../app/lib/platform/release/source-artifact'
import { splitTargetOwned, isTargetOwned, isEntirelyTargetOwned } from '../app/lib/platform/release/target-owned-paths'
import { buildReleaseComparison, irreversibleDifferences } from '../app/lib/platform/release/release-comparison'
import { platformHealth, releaseCompatibility, capabilityReadiness, providerHealth, assertOptionalProvidersDoNotBlock } from '../app/lib/platform/readiness'
import { configChecks, summarize, runHealthChecks } from '../app/lib/health'
import { resolveAllProviderReadiness } from '../app/lib/platform/capabilities/provider-readiness'
import { resolveCapabilityProfile, emptyProfile, providerEnablement } from '../app/lib/platform/capabilities/tenant-profile'
import { CAPABILITY_REGISTRY } from '../app/lib/platform/capabilities/registry'
import { resolveTenantCapabilities, setCapabilitySelections, backfillCapabilityProfile } from '../app/lib/platform/capabilities/tenant-profile-store'
import { planCapabilityBackfill, applyBackfillPlan } from '../app/lib/platform/capabilities/capability-backfill'
import { upsertMembership } from '../app/lib/platform/tenancy/membership'
import { runWithTenant } from '../app/lib/platform/tenancy/context'
import { upsertTenant } from '../app/lib/platform/tenancy/tenant-registry'
import type { PlatformUpdate, PlatformBusiness, TargetDeploymentEvidence } from '../app/lib/platform/updates/types'

const NOW = 1_800_000_000_000
const OWNER = { sub: 'owner-a', role: 'admin' as const }
const OWNER_B = { sub: 'owner-b', role: 'admin' as const }
const OPTS = { enabled: true }

/** A business that runs everything. */
const FULL_ENV = {
  STRIPE_SECRET_KEY: 'sk_test_value', STRIPE_WEBHOOK_SECRET: 'whsec_value',
  TWILIO_ACCOUNT_SID: 'ACvalue', TWILIO_AUTH_TOKEN: 'tokvalue', TWILIO_FROM: '+15551230000',
  RESEND_API_KEY: 're_value', AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-value',
  BLOB_READ_WRITE_TOKEN: 'b', BLOB_STORE_ID: 's', CRON_SECRET: 'c',
}
/** A business that runs none of them. */
const BARE_ENV: Record<string, string | undefined> = { BLOB_READ_WRITE_TOKEN: 'b', BLOB_STORE_ID: 's', CRON_SECRET: 'c', AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-value' }
const NO_PROVIDERS = { stripe: false, twilio: false, resend: false, ai: false }

const update = (over: Partial<PlatformUpdate> = {}): PlatformUpdate => ({
  recordVersion: 1, key: 'UPD-9100', title: 'Security fix', summary: 's',
  type: 'security', scope: 'platform_core', severity: 'critical', priority: 'urgent', status: 'approved',
  breakingChange: false, migrationRequired: false, environmentChangeRequired: false,
  secretRequired: false, featureFlagRequired: false, manualPortRequired: false, rollbackSupported: true,
  sourceRepo: 'ratchetnu/jkissllc', sourceCommit: 'a1b2c3d',
  validation: { typecheck: 'passed', lint: 'passed', tests: 'passed', build: 'passed', securityReview: 'passed', accessibilityReview: 'not_applicable', e2e: 'not_applicable', smokeTest: 'passed', ownerVerification: 'passed' },
  createdAt: 0, updatedAt: 0, ...over,
})
const business = (over: Partial<PlatformBusiness> = {}): PlatformBusiness => ({
  recordVersion: 1, id: 'supercharged', name: 'Supercharged', role: 'target',
  releaseChannel: 'stable', updatePolicy: 'owner_approved', healthStatus: 'healthy',
  repoName: 'ratchetnu/supercharged', defaultBranch: 'main',
  githubInstallationId: 'ghi_1', automationWorkflowFile: 'operion-update.yml',
  previewProjectId: 'prj_1', previewDeploymentProvider: 'vercel', configurationStatus: 'ready',
  createdAt: 0, updatedAt: 0, ...over,
} as PlatformBusiness)

/** A target running nothing optional. */
const BARE_TARGET: TargetDeploymentEvidence = {
  commit: 'a1b2c3d', buildId: 'dpl_x', capabilityProfileVersion: 1,
  capabilities: [
    { capability: 'payments-stripe', state: 'capability_disabled', enabled: false, configured: false },
    { capability: 'sms-delivery', state: 'capability_disabled', enabled: false, configured: false },
    { capability: 'email-delivery', state: 'capability_disabled', enabled: false, configured: false },
  ],
  recordedAt: NOW, authentication: 'hmac-sha256',
}

const preflightFor = (over: Record<string, unknown> = {}) => evaluatePreflight({
  update: update(), business: business(),
  compat: { recordVersion: 1, updateKey: 'UPD-9100', businessId: 'supercharged', status: 'compatible' as const, createdAt: 0, updatedAt: 0 },
  hasActiveJob: false,
  flags: { automation: true, preview: true, githubActions: true, controlPlane: true },
  requiredUpdates: { ok: true, missing: [] },
  transferReady: { ok: true },
  ...over,
} as Parameters<typeof evaluatePreflight>[0])

test('setup: two independent tenants', async () => {
  await upsertMembership({ tenantId: 'jkiss', userId: OWNER.sub, role: 'admin', status: 'active' })
  await upsertMembership({ tenantId: 'acme', userId: OWNER_B.sub, role: 'admin', status: 'active' })
  await upsertTenant({ id: 'jkiss', slug: 'jkiss', displayName: 'J KISS', legal: {}, brand: {}, status: 'active', createdAt: 0 })
  await upsertTenant({ id: 'acme', slug: 'acme', displayName: 'Acme', legal: {}, brand: {}, status: 'active', createdAt: 0 })
})

// ── 1. No Stripe/Twilio/Resend still passes preflight ───────────────────────

test('a tenant with NO Stripe, Twilio or Resend passes release preflight', () => {
  const impact = evaluateCapabilityImpact(update(), BARE_TARGET)
  const r = preflightFor({ capabilityImpact: impact })
  assert.equal(r.ok, true, JSON.stringify(r.gates.filter(g => !g.ok && g.blocking)))
  assert.equal(r.verdict, 'ready')
  assert.equal(releaseCompatibility(r).canReceive, true)
})

test('…and no gate anywhere in the set even MENTIONS a provider', () => {
  const text = JSON.stringify(preflightFor({ capabilityImpact: evaluateCapabilityImpact(update(), BARE_TARGET) }).gates).toLowerCase()
  for (const p of ['stripe', 'twilio', 'resend']) assert.ok(!text.includes(p), `a gate mentions ${p}`)
})

// ── 2. Disable all three; unrelated features keep working ───────────────────

test('a tenant can disable all three and keep every unrelated feature', async () => {
  await runWithTenant({ tenantId: 'jkiss' }, () => setCapabilitySelections(OWNER, 'jkiss', {
    'payments-stripe': { selection: 'disabled' },
    'sms-delivery': { selection: 'disabled' },
    'email-delivery': { selection: 'disabled' },
  }, { ...OPTS, env: FULL_ENV }))

  const r = await resolveTenantCapabilities('jkiss', { env: FULL_ENV })
  for (const id of ['payments-stripe', 'sms-delivery', 'email-delivery'] as const) {
    assert.equal(r.capabilities[id].state, 'disabled')
  }
  // Everything a business actually runs on is untouched.
  for (const id of ['bookings', 'booking-intake', 'routes', 'scheduling', 'invoicing', 'payments',
                    'messaging', 'notifications', 'reporting', 'workforce', 'time-tracking',
                    'contractor-compensation', 'claims', 'hiring', 'customer-portal', 'crew-portal'] as const) {
    assert.equal(r.capabilities[id].state, 'ready', `${id} must survive turning the three channels off`)
  }
})

test('disabling payments does NOT disable invoicing, reporting or the ledger', async () => {
  const r = await resolveTenantCapabilities('jkiss', { env: FULL_ENV })
  assert.equal(r.capabilities['invoicing'].state, 'ready')
  assert.equal(r.capabilities['reporting'].state, 'ready')
  assert.equal(r.capabilities['payments'].state, 'ready', 'the payment LEDGER is core — cash, check and Zelle still work')
})

// ── 3. Enabled-but-unconfigured is a different thing from disabled ──────────

test('enabled-but-unconfigured and disabled are DIFFERENT states, codes and consequences', () => {
  const off = resolveCapabilityProfile({ ...emptyProfile('t'), initializedAt: 1 }, { env: BARE_ENV })['sms-delivery']
  const on = resolveCapabilityProfile(
    { ...emptyProfile('t'), initializedAt: 1, entries: { 'sms-delivery': { selection: 'enabled', updatedAt: 0, updatedBy: 'o' } } },
    { env: BARE_ENV },
  )['sms-delivery']

  assert.equal(off.state, 'disabled')
  assert.equal(on.state, 'setup_required')
  assert.notEqual(off.code, on.code)
  // Only the enabled one is actionable, and only it names what is missing.
  assert.deepEqual(off.missingVars, [])
  assert.ok(on.missingVars.length > 0)

  // …and only the enabled one degrades anything.
  const offHealth = configChecks(BARE_ENV, { providers: { ...NO_PROVIDERS } })
  const onHealth = configChecks(BARE_ENV, { providers: { ...NO_PROVIDERS, twilio: true } })
  assert.equal(offHealth.find(c => c.name === 'sms')!.status, 'ok')
  assert.equal(onHealth.find(c => c.name === 'sms')!.status, 'degraded')
})

// ── 4. Plans, when they are enforced ───────────────────────────────────────

test('a plan that excludes a capability OVERRIDES a stored "enabled"', () => {
  // Every shipped capability currently declares all three tiers, so enforcement is
  // inert in production (asserted separately below). The RULE is exercised against a
  // capability set that does restrict one, so it is already proven on the day
  // somebody first restricts a tier rather than discovered then.
  const proOnly = { ...CAPABILITY_REGISTRY['sms-delivery'], tiers: ['pro'] as const }
  const registry = [CAPABILITY_REGISTRY['messaging'], { ...proOnly, tiers: ['pro'] as ('free' | 'starter' | 'pro')[] }]
  const storedOn = {
    ...emptyProfile('t'), initializedAt: 1,
    entries: { 'sms-delivery': { selection: 'enabled' as const, updatedAt: 0, updatedBy: 'o' } },
  }

  // No plan recorded: enforcement is OFF and the stored choice stands.
  const unenforced = resolveCapabilityProfile(storedOn, { env: FULL_ENV, capabilities: registry })
  assert.equal(unenforced['sms-delivery'].state, 'ready')
  assert.equal(unenforced['sms-delivery'].planAvailable, true)

  // A plan that does not include it WINS over the stored choice — otherwise a
  // downgrade would leave a capability running that the tenant no longer pays for.
  const restricted = resolveCapabilityProfile(storedOn, { env: FULL_ENV, plan: 'free', capabilities: registry })
  assert.equal(restricted['sms-delivery'].state, 'unavailable_on_plan')
  assert.equal(restricted['sms-delivery'].selectionSource, 'plan')
  assert.equal(restricted['sms-delivery'].tenantEnabled, false)
  assert.equal(restricted['sms-delivery'].planAvailable, false)

  // …and the matching plan still gets it.
  const onPlan = resolveCapabilityProfile(storedOn, { env: FULL_ENV, plan: 'pro', capabilities: registry })
  assert.equal(onPlan['sms-delivery'].state, 'ready')
})

test('a provider a plan excludes is not counted as in use', () => {
  const registry = [CAPABILITY_REGISTRY['messaging'], { ...CAPABILITY_REGISTRY['sms-delivery'], tiers: ['pro'] as ('free' | 'starter' | 'pro')[] }]
  const storedOn = {
    ...emptyProfile('t'), initializedAt: 1,
    entries: { 'sms-delivery': { selection: 'enabled' as const, updatedAt: 0, updatedBy: 'o' } },
  }
  const restricted = resolveCapabilityProfile(storedOn, { env: FULL_ENV, plan: 'free', capabilities: registry })
  assert.equal(providerEnablement(restricted).twilio, false, 'health must not report a channel the plan withholds')
})

test('plan enforcement is INERT today, and this records that deliberately', () => {
  // If this starts failing, somebody has restricted a tier — which is a product
  // decision, and this test is where it becomes visible rather than a surprise.
  const restricted = Object.values(CAPABILITY_REGISTRY).filter(c => c.tiers.length < 3)
  assert.deepEqual(restricted.map(c => c.id), [], 'no capability restricts tiers yet')
})

test('a tenant with NO plan recorded keeps everything — enforcement is opt-in', () => {
  // The field shipping must not retroactively take features from every existing
  // business. "No plan" is not "the cheapest plan"; it is "plans do not apply here".
  for (const plan of [null, undefined]) {
    const r = resolveCapabilityProfile({ ...emptyProfile('t'), initializedAt: 1 }, { env: FULL_ENV, plan })
    for (const c of Object.values(r)) assert.equal(c.planAvailable, true)
  }
})

// ── 5. Background jobs skip disabled capabilities ───────────────────────────

test('the AI cron does NOT attempt paid work for a tenant that declined photo estimates', async () => {
  await runWithTenant({ tenantId: 'jkiss' }, () => setCapabilitySelections(OWNER, 'jkiss', {
    'photo-estimation': { selection: 'disabled' },
  }, { ...OPTS, env: FULL_ENV }))

  externalCalls.length = 0
  const { GET } = await import('../app/api/cron/ai-jobs/route')
  const res = await GET(new NextRequest('http://localhost/api/cron/ai-jobs', {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  }))
  assert.equal(res.status, 200)
  const body = await res.json() as { tenants: { tenant: string; skipped?: string; processed: number }[] }
  const jkiss = body.tenants.find(t => t.tenant === 'jkiss')
  assert.ok(jkiss, 'the tenant is reported, not silently absent')
  assert.equal(jkiss!.skipped, 'capability_disabled', 'skipped for a stated reason')
  assert.equal(jkiss!.processed, 0)
  // The strongest form: not one call left the process.
  assert.deepEqual(externalCalls, [], 'a declined capability must cost nothing at all')
})

// ── 6. Tenant A cannot affect Tenant B ──────────────────────────────────────

test('tenant A’s choices do not reach tenant B, in either direction', async () => {
  await runWithTenant({ tenantId: 'acme' }, () => setCapabilitySelections(OWNER_B, 'acme', {
    'sms-delivery': { selection: 'enabled' },
    'hiring': { selection: 'disabled' },
  }, { ...OPTS, env: FULL_ENV }))

  const a = await resolveTenantCapabilities('jkiss', { env: FULL_ENV })
  const b = await resolveTenantCapabilities('acme', { env: FULL_ENV })

  assert.equal(a.capabilities['sms-delivery'].state, 'disabled')
  assert.equal(b.capabilities['sms-delivery'].state, 'ready')
  assert.equal(a.capabilities['hiring'].state, 'ready')
  assert.equal(b.capabilities['hiring'].state, 'disabled')

  // Two distinct tenant-scoped keys — no shared record to collide on.
  assert.ok(kv.has('t:jkiss:settings:capabilities'))
  assert.ok(kv.has('t:acme:settings:capabilities'))
})

test('a cross-tenant write is refused and changes nothing', async () => {
  await runWithTenant({ tenantId: 'jkiss' }, async () => {
    await assert.rejects(() => setCapabilitySelections(OWNER, 'acme', { hiring: { selection: 'enabled' } }, { ...OPTS, env: FULL_ENV }))
  })
  assert.equal((await resolveTenantCapabilities('acme', { env: FULL_ENV })).capabilities['hiring'].state, 'disabled')
})

// ── 7. Existing J KISS workflows remain functional ──────────────────────────

test('an un-migrated J KISS keeps every capability it has today', () => {
  // No stored profile at all — exactly a deployment that has not run the backfill.
  const legacy = resolveCapabilityProfile(emptyProfile('jkiss'), { env: FULL_ENV })
  for (const id of ['payments-stripe', 'sms-delivery', 'email-delivery', 'photo-estimation'] as const) {
    assert.equal(legacy[id].state, 'ready', `${id} must keep working before the backfill runs`)
    assert.equal(legacy[id].selectionSource, 'legacy-uninitialized', 'and must say it is a fallback, not a choice')
  }
  for (const id of ['bookings', 'invoicing', 'routes', 'claims', 'contractor-compensation'] as const) {
    assert.equal(legacy[id].state, 'ready')
  }
})

// ── 8. Migration safety: the backfill preserves behavior exactly ────────────

test('the backfill records what is true today and changes NOTHING', () => {
  const before = resolveCapabilityProfile(emptyProfile('jkiss'), { env: FULL_ENV })
  const plan = planCapabilityBackfill({ tenantId: 'jkiss', profile: emptyProfile('jkiss'), env: FULL_ENV })
  const after = resolveCapabilityProfile(applyBackfillPlan(emptyProfile('jkiss'), plan, { at: NOW, actor: 'op' }), { env: FULL_ENV })

  for (const id of Object.keys(before) as (keyof typeof before)[]) {
    assert.equal(after[id].state, before[id].state, `${id} changed state across the backfill`)
  }
  assert.ok(plan.entries.every(e => e.preservesBehavior))
  // …and it stops the inference, which is the whole point.
  assert.ok(Object.values(after).every(c => c.selectionSource !== 'legacy-uninitialized'))
})

test('the backfill is idempotent, and a dry run writes nothing at all', async () => {
  const first = await backfillCapabilityProfile('acme', { dryRun: true, actor: 'op', env: FULL_ENV })
  assert.equal(first.written, false, 'a dry run writes nothing — not even the marker')

  const real = await backfillCapabilityProfile('acme', { dryRun: false, actor: 'op', env: FULL_ENV, at: NOW })
  assert.equal(real.written, true)
  const again = await backfillCapabilityProfile('acme', { dryRun: false, actor: 'op', env: FULL_ENV, at: NOW + 1 })
  assert.equal(again.alreadyInitialized, true)
  assert.equal(again.written, false, 're-running must not reset a later choice')
})

test('the backfill never overwrites an explicit choice, and never removes one', async () => {
  const r = await resolveTenantCapabilities('acme', { env: FULL_ENV })
  // acme explicitly enabled SMS and disabled hiring before the backfill ran.
  assert.equal(r.capabilities['sms-delivery'].state, 'ready')
  assert.equal(r.capabilities['hiring'].state, 'disabled')
  assert.equal(r.capabilities['sms-delivery'].selectionSource, 'explicit')
})

test('a later settings change cannot erase the backfill marker', async () => {
  await runWithTenant({ tenantId: 'marker-test' }, () => upsertTenant({
    id: 'marker-test', slug: 'marker-test', displayName: 'Marker Test', legal: {}, brand: {},
    status: 'active', plan: 'pro', createdAt: NOW,
  }))
  await upsertMembership({ tenantId: 'marker-test', userId: OWNER.sub, role: 'admin', status: 'active' })
  await backfillCapabilityProfile('marker-test', {
    dryRun: false, actor: 'operator', env: BARE_ENV, at: NOW + 20,
  })
  await setCapabilitySelections(OWNER, 'marker-test', {
    'sms-delivery': { selection: 'enabled' },
  }, { ...OPTS, env: BARE_ENV, at: NOW + 21 })

  const after = await resolveTenantCapabilities('marker-test', { env: FULL_ENV })
  assert.equal(after.profile.initializedAt, NOW + 20)
  assert.equal(after.profile.initializedBy, 'operator')
  assert.equal(after.capabilities['payments-stripe'].state, 'disabled', 'environment inference must stay retired')
})

test('a concurrent owner choice wins over the backfill atomically', async () => {
  const tenantId = 'backfill-race'
  beforeCapabilityProfileCas = (key) => kv.set(key, JSON.stringify({
    ...emptyProfile(tenantId),
    entries: { 'sms-delivery': { selection: 'disabled', updatedAt: NOW, updatedBy: 'owner' } },
  }))
  await assert.rejects(
    () => backfillCapabilityProfile(tenantId, { dryRun: false, actor: 'operator', env: FULL_ENV, at: NOW + 30 }),
    /changed while the backfill was running/,
  )
  const after = await resolveTenantCapabilities(tenantId, { env: FULL_ENV })
  assert.equal(after.capabilities['sms-delivery'].state, 'disabled')
  assert.equal(after.profile.initializedAt, undefined, 'the owner record was preserved byte-for-byte')
})

test('a plan computed BEFORE a choice was made cannot clobber it', () => {
  // The real race the apply-time guard exists for: an operator opens the plan, an
  // admin makes a choice, the operator then applies. The plan predates the choice, so
  // applying it naively would silently overwrite a deliberate decision with an
  // inferred one — and the audit trail would show the operator making a change they
  // never intended.
  const before = emptyProfile('racy')
  const plan = planCapabilityBackfill({ tenantId: 'racy', profile: before, env: FULL_ENV })
  assert.ok(plan.entries.some(e => e.capability === 'sms-delivery'), 'the plan did include it')

  // Meanwhile, somebody chose.
  const chosen = {
    ...before,
    entries: { 'sms-delivery': { selection: 'disabled' as const, note: 'we do not text', updatedAt: 5, updatedBy: 'admin' } },
  }
  const applied = applyBackfillPlan(chosen, plan, { at: NOW, actor: 'op' })
  assert.equal(applied.entries['sms-delivery']!.selection, 'disabled', 'the human decision survives')
  assert.equal(applied.entries['sms-delivery']!.updatedBy, 'admin', 'and is still attributed to the human')
  assert.equal(applied.entries['sms-delivery']!.note, 'we do not text')
})

test('a paid capability is NEVER switched on by a backfill that found it off', () => {
  // Bare environment: nothing is in use, so nothing may be recorded as in use.
  const plan = planCapabilityBackfill({ tenantId: 'fresh', profile: emptyProfile('fresh'), env: BARE_ENV })
  for (const id of ['payments-stripe', 'sms-delivery', 'email-delivery'] as const) {
    const e = plan.entries.find(x => x.capability === id)
    assert.equal(e?.selection, 'disabled', `${id} was off and must stay off`)
  }
})

// ── 8b. A release cannot deploy from a dirty or uncommitted source ──────────

test('a DIRTY source worktree is refused outright', () => {
  const r = resolveSourceArtifact({ updateKey: 'U', sourceRepo: 'a/b', sourceCommit: 'a1b2c3d', sourceWorktreeDirty: true })
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.code, 'dirty_worktree')
  const p = preflightFor({ update: update({ sourceWorktreeDirty: true }) })
  assert.equal(p.ok, false)
  assert.equal(p.verdict, 'blocked_by_platform')
  assert.ok(p.gates.find(g => g.id === 'source_commit' && !g.ok))
})

test('a moving or local ref is refused — it means something different tomorrow', () => {
  for (const ref of ['HEAD', 'main', 'master', 'latest', 'current', 'dirty', 'working']) {
    const r = resolveSourceArtifact({ updateKey: 'U', sourceRepo: 'a/b', sourceCommit: ref })
    assert.equal(r.ok, false, `${ref} was accepted as an artifact`)
    assert.equal(r.ok === false && r.code, 'moving_or_local_ref')
  }
})

test('anything that is not a commit is refused, and a real commit is accepted', () => {
  assert.equal(resolveSourceArtifact({ updateKey: 'U', sourceRepo: 'a/b', sourceCommit: 'v1.2.3' }).ok, false)
  assert.equal(resolveSourceArtifact({ updateKey: 'U', sourceRepo: 'a/b', sourceCommit: 'abc' }).ok, false, 'three characters is not an object name')
  assert.equal(resolveSourceArtifact({ updateKey: 'U', sourceRepo: 'a/b', sourceCommit: '' }).ok, false)
  assert.equal(resolveSourceArtifact({ updateKey: 'U', sourceRepo: 'a/b', sourceCommit: 'a1b2c3d4e5f6a7b8c9d0' }).ok, true)
})

// ── 9. Preview verification is bound to the artifact promoted ───────────────

test('a Preview built from a DIFFERENT commit does not match the approved artifact', () => {
  const artifact = { commit: 'a1b2c3d4e5f6' }
  assert.equal(previewMatchesArtifact(artifact, { commit: 'a1b2c3d4e5f6' }).ok, true)
  assert.equal(previewMatchesArtifact(artifact, { commit: 'a1b2c3d' }).ok, true, 'a short SHA is the same commit')
  const moved = previewMatchesArtifact(artifact, { commit: 'ffffffffffff' })
  assert.equal(moved.ok, false)
  assert.match(moved.reason!, /moved after review/)
  // A Preview that says nothing proves nothing.
  assert.equal(previewMatchesArtifact(artifact, null).ok, false)
  assert.equal(previewMatchesArtifact(artifact, { commit: '' }).ok, false)
})

// ── 10 + 11. Optional warnings are not blockers; real platform failures are ─

test('an optional gap produces READY, never BLOCKED', () => {
  const impact = evaluateCapabilityImpact(
    update({ scope: 'industry_specific', capabilityImpact: { affects: ['sms-delivery'], optionalOnly: true } }),
    BARE_TARGET,
  )
  const r = preflightFor({ capabilityImpact: impact })
  assert.equal(r.ok, true)
  assert.equal(r.verdict, 'ready_optional_unavailable')
  assert.equal(releaseCompatibility(r).canReceive, true, '“ready with optional features unavailable” means SEND IT')
  assert.ok(r.affectedCapabilities.includes('sms-delivery'))
})

test('a REAL required-platform failure blocks, and says which one', () => {
  const r = preflightFor({ business: business({ configurationStatus: 'not_configured' }) })
  assert.equal(r.ok, false)
  assert.equal(r.verdict, 'blocked_by_platform')
  assert.ok(r.reasons.length > 0)
  assert.equal(releaseCompatibility(r).canReceive, false)
})

test('an undecided human question is MANUAL REVIEW, not a platform blocker', () => {
  const r = preflightFor({ update: update({ migrationRequired: true }) })
  assert.equal(r.verdict, 'manual_review')
  assert.match(r.summary, /needs to decide/)
})

test('a platform blocker OUTRANKS a pending decision — the harder problem wins', () => {
  const r = preflightFor({
    business: business({ configurationStatus: 'not_configured' }),
    update: update({ migrationRequired: true }),
  })
  assert.equal(r.verdict, 'blocked_by_platform')
})

test('the classifier cannot be talked into blocking on an optional gap alone', () => {
  const gates: PreflightGate[] = [
    { id: 'capability_activation', label: 'Optional', ok: false, blocking: false, gateClass: 'capability', reason: 'dormant' },
    { id: 'rollback_documented', label: 'Docs', ok: false, blocking: false, gateClass: 'documentation' },
  ]
  const c = classifyPreflight(gates, {
    installs: true, dormant: true, affectedCapabilities: ['sms-delivery'],
    activationRequirements: [], missingCapabilityCode: [], rationale: 'dormant',
  })
  assert.equal(c.verdict, 'ready_optional_unavailable')
})

// ── 12. Branding and target configuration survive an update ────────────────

test('target-owned files are withheld by a STANDING rule, not a curated list', () => {
  const split = splitTargetOwned([
    'app/lib/company.ts', 'public/logo.png', 'public/og-image.jpg', 'vercel.json',
    '.env.example', 'README.md', 'app/lib/bookings.ts', 'app/api/book/route.ts',
  ])
  assert.deepEqual(split.transferable, ['app/lib/bookings.ts', 'app/api/book/route.ts'])
  assert.equal(split.withheld.length, 6)
  // Each refusal carries a reason, so an operator sees WHY it was kept back.
  for (const w of split.withheld) assert.ok(w.reason.length > 20, `${w.path} withheld without a reason`)
})

test('the identity file itself can never be transferred', () => {
  assert.equal(isTargetOwned('app/lib/company.ts'), true)
  assert.equal(isTargetOwned('public/logo.png'), true)
  assert.equal(isTargetOwned('app/lib/company-helpers.ts'), false, 'prefix matching must not over-claim')
  assert.equal(isEntirelyTargetOwned(['app/lib/company.ts', 'public/logo.png']), true)
  assert.equal(isEntirelyTargetOwned(['app/lib/company.ts', 'app/lib/bookings.ts']), false)
})

test('capability choices and credentials are not files, so a transfer cannot touch them', () => {
  // Selections live in the target's own tenant-scoped Redis; credentials live in its
  // own environment. Asserted here because "a file transfer cannot reach them" is the
  // reason they were put there, and it should fail loudly if that ever stops being true.
  assert.ok(kv.has('t:jkiss:settings:capabilities'))
  assert.ok(![...kv.keys()].some(k => k.endsWith('.ts') || k.endsWith('.json')), 'no capability state is file-shaped')
})

test('the comparison tells an owner what will be left alone, and what cannot be undone', () => {
  const c = buildReleaseComparison({
    artifact: { updateKey: 'U', repo: { owner: 'ratchetnu', name: 'jkissllc' }, commit: 'a1b2c3d', resolvedFrom: 'update_record' },
    update: update({ migrationRequired: true }),
    business: { id: 'supercharged', name: 'Supercharged' },
    changedPaths: ['app/lib/bookings.ts'],
    excludedPaths: ['app/lib/company.ts'],
    capabilityImpact: evaluateCapabilityImpact(update(), BARE_TARGET),
    // A target on an OLDER build — otherwise there is nothing to compare.
    targetEvidence: { ...BARE_TARGET, commit: 'f0f0f0f' },
  })
  assert.ok(c.differences.some(d => d.kind === 'code'))
  assert.ok(c.differences.some(d => d.kind === 'schema' && d.irreversible))
  assert.equal(irreversibleDifferences(c).length, 1)
  assert.match(c.headline, /cannot be undone/)
  const config = c.differences.find(d => d.kind === 'configuration')!
  assert.match(config.summary, /left alone/)
})

// ── The four readiness questions stay four questions ───────────────────────

test('an optional provider can never make the PLATFORM unhealthy', async () => {
  const report = await runHealthChecks({
    pingKv: async () => true,
    env: BARE_ENV,
    providers: async () => ({ ...NO_PROVIDERS }),
  })
  const view = platformHealth(report.components, report.status)
  assert.equal(view.status, 'healthy')
  assert.equal(summarize(report.components), 'healthy')
})

test('…and even an ENABLED-but-broken provider only degrades, never downs, the platform', async () => {
  const report = await runHealthChecks({
    pingKv: async () => true,
    env: BARE_ENV,
    providers: async () => ({ ...NO_PROVIDERS, stripe: true }),
  })
  const view = platformHealth(report.components, report.status)
  assert.notEqual(view.status, 'unhealthy')
  assert.ok(view.nonBlocking.some(c => c.name === 'payments'))
  assert.deepEqual(view.criticalComponents.filter(c => c.status === 'down'), [])
})

test('only a CRITICAL dependency takes the platform down', async () => {
  const report = await runHealthChecks({
    pingKv: async () => false,   // the store is gone
    env: FULL_ENV,
    providers: async () => ({ stripe: true, twilio: true, resend: true, ai: true }),
  })
  assert.equal(platformHealth(report.components, report.status).status, 'unhealthy')
})

test('the invariant is asserted, not merely commented', async () => {
  const resolved = await resolveTenantCapabilities('jkiss', { env: BARE_ENV })
  const report = await runHealthChecks({ pingKv: async () => true, env: BARE_ENV, providers: async () => resolved.providers })
  const violations = assertOptionalProvidersDoNotBlock({
    platform: platformHealth(report.components, report.status),
    capability: capabilityReadiness(resolved.capabilities),
    provider: providerHealth(resolveAllProviderReadiness({ enabled: resolved.providers, env: BARE_ENV })),
    release: releaseCompatibility(preflightFor({ capabilityImpact: evaluateCapabilityImpact(update(), BARE_TARGET) })),
  })
  assert.deepEqual(violations, [])
})

test('capability readiness counts only what the tenant ASKED for as needing attention', async () => {
  const resolved = await resolveTenantCapabilities('jkiss', { env: BARE_ENV })
  const view = capabilityReadiness(resolved.capabilities)
  // Everything the tenant switched off is listed as off — and NOT as a problem.
  assert.ok(view.intentionallyOff.includes('sms-delivery'))
  assert.ok(!view.needsAttention.includes('sms-delivery'))
})
