// ── Tenant capability profiles: two businesses, one codebase ─────────────────
//
// The property under test throughout: a business that does not use Stripe, Twilio
// or Resend is CONFIGURED, not BROKEN. It stays healthy, it keeps receiving core
// software updates, its optional code installs dormant, and every provider entry
// point refuses closed with a stable code rather than half-working.
//
// TENANCY_ENABLED is on here because the whole point is two tenants with different
// answers; with it off the deployment is single-tenant by design and both would
// share one key. Nothing outside this process is affected — the test runner gives
// each file its own process.
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'
process.env.TENANCY_ENABLED = 'true'

const kv = new Map<string, string>()
const zsets = new Map<string, Map<string, number>>()
const z = (key: string) => zsets.get(key) ?? zsets.set(key, new Map()).get(key)!

globalThis.fetch = (async (_url: string, init: { body: string }) => {
  const [command, ...args] = JSON.parse(init.body) as string[]
  const key = args[0]
  let result: unknown = null
  switch (command.toUpperCase()) {
    case 'GET': result = kv.get(key) ?? null; break
    case 'SET': kv.set(key, args[1]); result = 'OK'; break
    case 'DEL': kv.delete(key); result = 1; break
    case 'ZADD': z(key).set(args[2], Number(args[1])); result = 1; break
    case 'ZREM': z(key).delete(args[1]); result = 1; break
    case 'ZCARD': result = z(key).size; break
    case 'ZRANGE':
    case 'ZREVRANGE': {
      const values = [...z(key)].sort((a, b) => a[1] - b[1]).map(([member]) => member)
      if (command.toUpperCase() === 'ZREVRANGE') values.reverse()
      const start = Number(args[1]); const stop = Number(args[2])
      result = values.slice(start, stop === -1 ? undefined : stop + 1)
      break
    }
    case 'PEXPIRE': result = 1; break
    default: throw new Error(`fake redis: unhandled ${command}`)
  }
  return { json: async () => ({ result }) }
}) as unknown as typeof fetch

import {
  resolveCapabilityProfile, parseStoredProfile, emptyProfile, validateSelections,
  resolveSelection, providerEnablement, sanitizeCredentialRef,
  CAPABILITY_PROFILE_VERSION,
} from '../app/lib/platform/capabilities/tenant-profile'
import {
  setCapabilitySelections, resolveTenantCapabilities, CapabilityConfigError,
} from '../app/lib/platform/capabilities/tenant-profile-store'
import { CAPABILITY_REGISTRY } from '../app/lib/platform/capabilities/registry'
import { validateCapabilityRegistry } from '../app/lib/platform/capabilities/validate'
import { resolveProviderReadiness, resolveAllProviderReadiness } from '../app/lib/platform/capabilities/provider-readiness'
import { webhookDisposition, CapabilityUnavailableError } from '../app/lib/platform/capabilities/guard'
import { upsertMembership } from '../app/lib/platform/tenancy/membership'
import { TenantAccessDeniedError } from '../app/lib/platform/tenancy/membership'
import { configChecks, summarize } from '../app/lib/health'
import { listAudit } from '../app/lib/audit'
import { runWithTenant } from '../app/lib/platform/tenancy/context'

// Two businesses on the same build. J KISS runs every channel; Supercharged runs none.
const JKISS_ENV = {
  STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec_test',
  TWILIO_ACCOUNT_SID: 'ACx', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+15551230000',
  RESEND_API_KEY: 're_test',
  // Not part of this work — the AI transport just has to be resolvable so the
  // ai_provider component does not degrade the report for an unrelated reason.
  AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test',
}
const BARE_ENV: Record<string, string | undefined> = {}

const OWNER = { sub: 'owner-a', role: 'admin' as const }
const OTHER_OWNER = { sub: 'owner-b', role: 'admin' as const }
const CREW = { sub: 'crew-a', role: 'crew' as const }
const OPTS = { enabled: true }

test('setup: seed memberships for two independent tenants', async () => {
  await upsertMembership({ tenantId: 'jkiss', userId: OWNER.sub, role: 'admin', status: 'active' })
  await upsertMembership({ tenantId: 'jkiss', userId: CREW.sub, role: 'crew', status: 'active' })
  await upsertMembership({ tenantId: 'supercharged', userId: OTHER_OWNER.sub, role: 'admin', status: 'active' })
})

// ── A. The model ─────────────────────────────────────────────────────────────

test('the five axes stay separate: installed ≠ offered ≠ enabled ≠ configured ≠ operational', () => {
  const bare = resolveCapabilityProfile(emptyProfile('supercharged'), { env: BARE_ENV })
  const sms = bare['sms-delivery']
  // The CODE is installed on this target — that is what a core update delivers…
  assert.equal(sms.codeInstalled, true)
  // …and the pack offers it…
  assert.equal(sms.packAvailable, true)
  // …but this business has not switched it on, so it is not operational.
  assert.equal(sms.tenantEnabled, false)
  assert.equal(sms.operational, false)
  assert.equal(sms.state, 'disabled')
  assert.equal(sms.code, 'capability_disabled')

  // A capability whose code is genuinely absent reports THAT, not "disabled".
  assert.equal(bare['expenses'].state, 'not_installed')
  assert.equal(bare['expenses'].codeInstalled, false)
})

test('two tenants, same build, different answers — and neither can see the other', async () => {
  await setCapabilitySelections(OWNER, 'jkiss', {
    'payments-stripe': { selection: 'enabled' },
    'sms-delivery': { selection: 'enabled' },
    'email-delivery': { selection: 'enabled' },
  }, { ...OPTS, env: JKISS_ENV })

  await setCapabilitySelections(OTHER_OWNER, 'supercharged', {
    'payments-stripe': { selection: 'disabled' },
    'sms-delivery': { selection: 'disabled' },
    'email-delivery': { selection: 'disabled' },
  }, { ...OPTS, env: BARE_ENV })

  const jk = await resolveTenantCapabilities('jkiss', { env: JKISS_ENV })
  const sc = await resolveTenantCapabilities('supercharged', { env: BARE_ENV })

  assert.deepEqual(jk.providers, { stripe: true, twilio: true, resend: true, ai: true })
  assert.deepEqual(sc.providers, { stripe: false, twilio: false, resend: false, ai: false })
  assert.equal(jk.capabilities['sms-delivery'].state, 'ready')
  assert.equal(sc.capabilities['sms-delivery'].state, 'disabled')

  // Two distinct tenant-scoped keys — no shared record to collide on.
  assert.ok(kv.has('t:jkiss:settings:capabilities'), 'jkiss profile is tenant-scoped')
  assert.ok(kv.has('t:supercharged:settings:capabilities'), 'supercharged profile is tenant-scoped')
  assert.notEqual(kv.get('t:jkiss:settings:capabilities'), kv.get('t:supercharged:settings:capabilities'))
})

test('core capabilities are unaffected by an optional channel being off', async () => {
  const sc = await resolveTenantCapabilities('supercharged', { env: BARE_ENV })
  for (const id of ['bookings', 'invoicing', 'payments', 'messaging', 'notifications', 'reporting', 'routes'] as const) {
    assert.equal(sc.capabilities[id].state, 'ready', `${id} must stay ready with no provider credentials at all`)
  }
})

test('an explicit ENABLE beats credential inference — "on but unfinished" stays visible', async () => {
  await setCapabilitySelections(OTHER_OWNER, 'supercharged', { 'sms-delivery': { selection: 'enabled' } }, { ...OPTS, env: BARE_ENV })
  const sc = await resolveTenantCapabilities('supercharged', { env: BARE_ENV })
  assert.equal(sc.capabilities['sms-delivery'].state, 'setup_required')
  assert.equal(sc.capabilities['sms-delivery'].selectionSource, 'explicit')
  assert.ok(sc.capabilities['sms-delivery'].missingVars.length > 0, 'names the variables still needed')
  // …and only that capability. Nothing else moved.
  assert.equal(sc.capabilities['bookings'].state, 'ready')
  assert.equal(sc.capabilities['email-delivery'].state, 'disabled')
  // Restore for later tests.
  await setCapabilitySelections(OTHER_OWNER, 'supercharged', { 'sms-delivery': { selection: 'disabled' } }, { ...OPTS, env: BARE_ENV })
})

// THE RULE THAT REPLACED CREDENTIAL INFERENCE.
//
// The presence of a key is evidence that somebody once configured something, not
// that this business wants the feature on. Once a tenant's profile is initialized,
// the environment has no bearing on whether a capability is switched ON — only on
// whether a switched-on capability is CONFIGURED.
test('an initialized profile NEVER infers enablement from the environment', () => {
  // Credentials fully present, and the answer is still "off", because nobody said on.
  assert.deepEqual(
    resolveSelection(CAPABILITY_REGISTRY['sms-delivery'], undefined, JKISS_ENV, { initialized: true }),
    { selection: 'disabled', source: 'registry-default' },
  )
  assert.deepEqual(
    resolveSelection(CAPABILITY_REGISTRY['payments-stripe'], undefined, JKISS_ENV, { initialized: true }),
    { selection: 'disabled', source: 'registry-default' },
  )
})

// …and the ONE transitional exception, which exists so removing the inference
// cannot break a deployment that has not run the backfill yet. It is reported as
// `legacy-uninitialized` so it can never be mistaken for a choice anybody made.
test('an UNINITIALIZED profile falls back to legacy inference, and says so', () => {
  assert.deepEqual(
    resolveSelection(CAPABILITY_REGISTRY['sms-delivery'], undefined, JKISS_ENV, { initialized: false }),
    { selection: 'enabled', source: 'legacy-uninitialized' },
  )
  assert.deepEqual(
    resolveSelection(CAPABILITY_REGISTRY['sms-delivery'], undefined, BARE_ENV, { initialized: false }),
    { selection: 'disabled', source: 'legacy-uninitialized' },
  )
  // The fallback is for PROVIDER adapters only. A non-provider capability takes the
  // registry default either way — there is nothing about the environment that could
  // sensibly answer "does this business run a careers page?".
  assert.equal(
    resolveSelection(CAPABILITY_REGISTRY['hiring'], undefined, JKISS_ENV, { initialized: false }).source,
    'registry-default',
  )
})

test('a NEW tenant gets conservative defaults — nothing paid, nothing sending', () => {
  const fresh = resolveCapabilityProfile({ ...emptyProfile('acme'), initializedAt: 1 }, { env: JKISS_ENV })
  for (const id of ['payments-stripe', 'sms-delivery', 'email-delivery', 'photo-estimation'] as const) {
    assert.equal(fresh[id].state, 'disabled', `${id} must be off for a tenant that never asked for it`)
  }
  // …while everything it needs to actually run a business is on.
  for (const id of ['bookings', 'booking-intake', 'routes', 'invoicing', 'payments', 'messaging'] as const) {
    assert.equal(fresh[id].state, 'ready', `${id} must be available to a new tenant`)
  }
})

test('a mandatory capability reports itself as mandatory and is never inferred off', () => {
  for (const id of ['identity', 'roles', 'permissions', 'audit-logs'] as const) {
    const r = resolveSelection(CAPABILITY_REGISTRY[id], { selection: 'disabled', updatedAt: 0, updatedBy: 'x' }, BARE_ENV)
    assert.deepEqual(r, { selection: 'enabled', source: 'mandatory' }, `${id} must resist even a stored "disabled"`)
  }
})

// ── Stored-record safety ─────────────────────────────────────────────────────

// Caught by a functional test, and pinned here because the failure mode is silent:
// the stored record says "migrated", the runtime behaves as if it never was, and the
// credential inference this work exists to remove quietly comes back on every read.
test('initializedAt SURVIVES a round trip — a migrated tenant stays migrated', () => {
  const written = JSON.stringify({
    version: CAPABILITY_PROFILE_VERSION, tenantId: 'jkiss', entries: {},
    initializedAt: 1_700_000_000_000, initializedBy: 'op', updatedAt: 1, updatedBy: 'op',
  })
  const read = parseStoredProfile('jkiss', written)
  assert.equal(read.profile.initializedAt, 1_700_000_000_000)
  assert.equal(read.profile.initializedBy, 'op')
  // …and the resolution regime follows it: no legacy inference for a migrated tenant.
  const resolved = resolveCapabilityProfile(read.profile, { env: JKISS_ENV })
  assert.equal(resolved['sms-delivery'].selectionSource, 'registry-default')
  assert.equal(resolved['sms-delivery'].state, 'disabled')
  // A zero or a negative is not a timestamp, and must not count as initialized.
  assert.equal(parseStoredProfile('jkiss', JSON.stringify({ version: 1, entries: {}, initializedAt: 0 })).profile.initializedAt, undefined)
})

test('a FUTURE-version record is never reinterpreted — defaults, loudly', () => {
  const r = parseStoredProfile('jkiss', JSON.stringify({ version: CAPABILITY_PROFILE_VERSION + 1, entries: { 'sms-delivery': { selection: 'enabled' } } }))
  assert.equal(r.fellBackToDefaults, true)
  assert.deepEqual(r.profile.entries, {})
  assert.match(r.warnings.join(' '), /version/)
})

test('malformed / unknown entries are dropped and reported, never guessed at', () => {
  const r = parseStoredProfile('jkiss', JSON.stringify({
    version: 1,
    entries: { 'sms-delivery': { selection: 'enabled', updatedAt: 1, updatedBy: 'o' }, 'not-a-capability': { selection: 'enabled' }, 'email-delivery': { selection: 'maybe' } },
  }))
  assert.equal(r.fellBackToDefaults, false)
  assert.ok(r.profile.entries['sms-delivery'])
  assert.ok(!('not-a-capability' in r.profile.entries))
  assert.ok(!r.profile.entries['email-delivery'])
  assert.equal(r.warnings.length, 2)
})

test('garbage in the store degrades to defaults instead of throwing', () => {
  const r = parseStoredProfile('jkiss', 'not json at all')
  assert.equal(r.fellBackToDefaults, true)
  assert.deepEqual(r.profile.entries, {})
})

test('a credential VALUE can never be persisted as a credential reference', () => {
  assert.equal(sanitizeCredentialRef('STRIPE_SECRET_KEY'), 'STRIPE_SECRET_KEY')
  assert.equal(sanitizeCredentialRef('vercel://prj_1/STRIPE_SECRET_KEY'), 'vercel://prj_1/STRIPE_SECRET_KEY')
  // Refused, not truncated — truncating a pasted key still stores most of it.
  assert.equal(sanitizeCredentialRef('sk_live_51H hello world'), null)
  assert.equal(sanitizeCredentialRef('x'.repeat(200)), null)
})

test('a pasted secret is REFUSED at the write boundary, not silently trimmed', async () => {
  await assert.rejects(
    () => setCapabilitySelections(OWNER, 'jkiss', { 'payments-stripe': { selection: 'enabled', credentialRef: 'sk_live_abc def' } }, { ...OPTS, env: JKISS_ENV }),
    (e: unknown) => e instanceof CapabilityConfigError && e.errors.some(x => x.code === 'invalid_credential_reference'),
  )
  const stored = kv.get('t:jkiss:settings:capabilities') ?? ''
  assert.ok(!stored.includes('sk_live_abc'), 'no fragment of the pasted value reached the store')
})

test('NO secret value is ever written to the capability record', async () => {
  await setCapabilitySelections(OWNER, 'jkiss', { 'payments-stripe': { selection: 'enabled', credentialRef: 'STRIPE_SECRET_KEY', note: 'live account' } }, { ...OPTS, env: JKISS_ENV })
  const stored = kv.get('t:jkiss:settings:capabilities') ?? ''
  for (const value of Object.values(JKISS_ENV)) assert.ok(!stored.includes(value), `stored profile leaked ${value.slice(0, 3)}…`)
})

// ── B. Registry correction + dependency closure ──────────────────────────────

test('the registry is structurally valid under the new modelling rules', () => {
  assert.deepEqual(validateCapabilityRegistry(), [])
})

test('nothing that costs money or contacts a customer is ON by default', () => {
  for (const c of Object.values(CAPABILITY_REGISTRY)) {
    if (!c.provider) continue
    assert.equal(c.kind, 'optional', `${c.id} fronts ${c.provider} and must be optional`)
    // The rule that replaced credential inference: a tenant which has expressed no
    // preference must never find itself spending or sending because a key exists.
    assert.equal(c.defaultSelection, 'disabled', `${c.id} fronts ${c.provider} and must default OFF`)
  }
})

test('every switch says what it costs you, and every fixed one says why', () => {
  for (const c of Object.values(CAPABILITY_REGISTRY)) {
    if (c.tenantConfigurable && c.kind !== 'core') {
      assert.ok(c.disabledConsequence, `${c.id} is switchable but never says what stops working`)
    }
    if (!c.tenantConfigurable) assert.ok(c.mandatoryReason, `${c.id} cannot be switched off but never says why`)
  }
})

test('impossible configurations are refused: a child cannot outlive its prerequisite', () => {
  const effective = () => 'enabled' as const
  // Enabling SMS delivery while messaging is off.
  const errs = validateSelections({ 'sms-delivery': 'enabled', messaging: 'disabled' }, { effective })
  assert.ok(errs.some(e => e.code === 'capability_prerequisite_disabled' || e.code === 'capability_required_by'), JSON.stringify(errs))
})

test('turning a prerequisite off underneath an enabled child is refused too', () => {
  const effective = () => 'enabled' as const
  const errs = validateSelections({ payments: 'disabled' }, { effective })
  // payments-stripe hard-depends on payments and is currently on.
  assert.ok(errs.some(e => e.code === 'capability_required_by' && e.capability === 'payments'), JSON.stringify(errs))
})

test('enabling a parent and a child in ONE request is legal', () => {
  const effective = () => 'disabled' as const
  const errs = validateSelections({ payments: 'enabled', 'payments-stripe': 'enabled' }, { effective })
  assert.deepEqual(errs.filter(e => e.code === 'capability_prerequisite_disabled'), [])
})

test('a mandatory capability cannot be turned off through the store', async () => {
  await assert.rejects(
    () => setCapabilitySelections(OWNER, 'jkiss', { 'audit-logs': { selection: 'disabled' } }, { ...OPTS, env: JKISS_ENV }),
    (e: unknown) => e instanceof CapabilityConfigError && e.errors.some(x => x.code === 'capability_mandatory'),
  )
})

test('invoicing and reporting no longer require a card processor', () => {
  assert.ok(!CAPABILITY_REGISTRY['invoicing'].dependencies.includes('payments'))
  assert.ok(!CAPABILITY_REGISTRY['reporting'].dependencies.includes('payments'))
  const bare = resolveCapabilityProfile(emptyProfile('supercharged'), { env: BARE_ENV })
  assert.equal(bare['invoicing'].state, 'ready', 'a business with no Stripe can still invoice')
  assert.equal(bare['reporting'].state, 'ready', 'a report must open without a processor')
})

// ── C. Readiness + health ────────────────────────────────────────────────────

test('readiness distinguishes all four states with stable, value-free codes', () => {
  const disabled = resolveProviderReadiness({ provider: 'stripe', enabled: false, env: BARE_ENV })
  assert.equal(disabled.state, 'disabled')
  assert.equal(disabled.code, 'capability_disabled')
  assert.equal(disabled.applicable, false)

  const setup = resolveProviderReadiness({ provider: 'stripe', enabled: true, env: BARE_ENV })
  assert.equal(setup.state, 'setup_required')
  assert.deepEqual(setup.missingVars, ['STRIPE_SECRET_KEY'])

  const ready = resolveProviderReadiness({ provider: 'stripe', enabled: true, env: JKISS_ENV })
  assert.equal(ready.state, 'ready')

  const degraded = resolveProviderReadiness({ provider: 'stripe', enabled: true, env: JKISS_ENV, observed: { ok: false, errorClass: 'auth' } })
  assert.equal(degraded.state, 'degraded')
})

test('readiness NEVER returns a credential value, in any state', () => {
  for (const enabled of [true, false]) {
    for (const env of [BARE_ENV, JKISS_ENV]) {
      const all = resolveAllProviderReadiness({ enabled: { stripe: enabled, twilio: enabled, resend: enabled, ai: enabled }, env })
      const blob = JSON.stringify(all)
      for (const value of Object.values(JKISS_ENV)) assert.ok(!blob.includes(value), `readiness leaked ${value.slice(0, 4)}…`)
    }
  }
})

test('INTENTIONALLY DISABLED providers do not degrade overall health', () => {
  const components = configChecks(
    { ...JKISS_ENV, STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined, TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined, TWILIO_FROM: undefined, RESEND_API_KEY: undefined, BLOB_READ_WRITE_TOKEN: 'b', BLOB_STORE_ID: 's', CRON_SECRET: 'c' },
    { providers: { stripe: false, twilio: false, resend: false, ai: false } },
  )
  for (const name of ['payments', 'payments_webhook', 'sms', 'email']) {
    const c = components.find(x => x.name === name)!
    assert.equal(c.status, 'ok', `${name} must not be degraded when the business does not use it`)
    assert.equal(c.applicable, false, `${name} must report itself not-applicable`)
  }
  assert.equal(summarize(components), 'healthy')
})

test('ENABLED but unconfigured providers DO degrade — and say which variable is missing', () => {
  const components = configChecks(
    { BLOB_READ_WRITE_TOKEN: 'b', BLOB_STORE_ID: 's', CRON_SECRET: 'c', AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a' },
    { providers: { stripe: true, twilio: false, resend: false, ai: false } },
  )
  const payments = components.find(c => c.name === 'payments')!
  assert.equal(payments.status, 'degraded')
  assert.equal(payments.applicable, true)
  assert.match(payments.detail, /STRIPE_SECRET_KEY/)
  // …and it is the ONLY thing degraded. SMS and email stay clean.
  assert.equal(components.find(c => c.name === 'sms')!.status, 'ok')
  assert.equal(components.find(c => c.name === 'email')!.status, 'ok')
  assert.equal(summarize(components), 'degraded')
})

test('omitting the provider selection reproduces the historical behavior exactly', () => {
  const legacy = configChecks(BARE_ENV)
  assert.equal(legacy.find(c => c.name === 'payments')!.status, 'degraded')
  assert.equal(legacy.find(c => c.name === 'sms')!.status, 'degraded')
  assert.equal(legacy.find(c => c.name === 'email')!.status, 'degraded')
})

test('the health detail for a disabled channel names no variable at all', () => {
  const c = configChecks(BARE_ENV, { providers: { stripe: false, twilio: false, resend: false, ai: false } }).find(x => x.name === 'payments')!
  assert.ok(!/STRIPE_SECRET_KEY/.test(c.detail), 'nothing to configure means nothing to name')
})

// ── D. Authorization + cross-tenant ──────────────────────────────────────────

test('a cross-tenant capability write is DENIED', async () => {
  // Inside the actor's OWN tenant context — exactly what withTenantRoute establishes
  // from the signed session before the handler runs.
  await runWithTenant({ tenantId: 'jkiss' }, async () => {
    await assert.rejects(
      () => setCapabilitySelections(OWNER, 'supercharged', { 'sms-delivery': { selection: 'enabled' } }, { ...OPTS, env: BARE_ENV }),
      (e: unknown) => e instanceof TenantAccessDeniedError,
    )
  })
  // …and the foreign tenant's record is untouched.
  const sc = await resolveTenantCapabilities('supercharged', { env: BARE_ENV })
  assert.equal(sc.capabilities['sms-delivery'].state, 'disabled')
})

test('a member WITHOUT settings:manage is denied even inside their own tenant', async () => {
  await runWithTenant({ tenantId: 'jkiss' }, async () => {
    await assert.rejects(
      () => setCapabilitySelections(CREW, 'jkiss', { 'sms-delivery': { selection: 'disabled' } }, { ...OPTS, env: JKISS_ENV }),
      (e: unknown) => e instanceof TenantAccessDeniedError,
    )
  })
  const jk = await resolveTenantCapabilities('jkiss', { env: JKISS_ENV })
  assert.equal(jk.capabilities['sms-delivery'].state, 'ready', 'the refused write changed nothing')
})

test('every change AND every refusal is audited, with no secret in the record', async () => {
  const entries = await runWithTenant({ tenantId: 'jkiss' }, () => listAudit(200))
  const capability = entries.filter(e => e.action === 'capability.selection_changed')
  assert.ok(capability.some(e => e.outcome === 'success'), 'successful changes are recorded')
  assert.ok(capability.some(e => e.outcome === 'denied'), 'refusals are recorded')
  const blob = JSON.stringify(capability)
  for (const value of Object.values(JKISS_ENV)) assert.ok(!blob.includes(value), 'audit leaked a credential')
})

test('a DENIED cross-tenant write is filed under the ACTOR, never the target tenant', async () => {
  const denied = (await runWithTenant({ tenantId: 'jkiss' }, () => listAudit(200)))
    .filter(e => e.action === 'capability.selection_changed' && e.outcome === 'denied')
  assert.ok(denied.length > 0, 'refusals are recorded')
  for (const e of denied) {
    // Filing it under the requested tenant would let anyone write into any tenant's
    // log just by naming it.
    assert.equal(e.tenantId, 'jkiss', 'a refusal belongs to the actor’s own trail')
  }
  // The target tenant's own log is untouched by the attempt.
  const targetLog = await runWithTenant({ tenantId: 'supercharged' }, () => listAudit(200))
  assert.equal(targetLog.filter(e => e.outcome === 'denied').length, 0)
})

// ── Webhook disposition ──────────────────────────────────────────────────────

test('webhook policy: verified + disabled ACKNOWLEDGES; enabled + broken REFUSES', () => {
  const bare = resolveCapabilityProfile(emptyProfile('supercharged'), { env: BARE_ENV })
  const off = webhookDisposition(bare['sms-delivery'])
  assert.equal(off.action, 'acknowledge')
  assert.equal(off.action === 'acknowledge' && off.status, 200)

  const enabledUnconfigured = resolveCapabilityProfile(
    { ...emptyProfile('supercharged'), entries: { 'sms-delivery': { selection: 'enabled', updatedAt: 0, updatedBy: 'o' } } },
    { env: BARE_ENV },
  )
  const broken = webhookDisposition(enabledUnconfigured['sms-delivery'])
  assert.equal(broken.action, 'refuse')
  assert.equal(broken.action === 'refuse' && broken.status, 503)

  const live = resolveCapabilityProfile(emptyProfile('jkiss'), { env: JKISS_ENV })
  assert.equal(webhookDisposition(live['sms-delivery']).action, 'process')
})

test('CapabilityUnavailableError separates "we do not do this" (409) from "it is broken" (503)', () => {
  const bare = resolveCapabilityProfile(emptyProfile('supercharged'), { env: BARE_ENV })
  assert.equal(new CapabilityUnavailableError(bare['sms-delivery']).httpStatus, 409)
  const enabledUnconfigured = resolveCapabilityProfile(
    { ...emptyProfile('supercharged'), entries: { 'sms-delivery': { selection: 'enabled', updatedAt: 0, updatedBy: 'o' } } },
    { env: BARE_ENV },
  )
  const err = new CapabilityUnavailableError(enabledUnconfigured['sms-delivery'])
  assert.equal(err.httpStatus, 503)
  assert.equal(err.code, 'capability_setup_required')
  // The message may name variables; it must never carry a value.
  for (const value of Object.values(JKISS_ENV)) assert.ok(!err.message.includes(value))
})

// ── Pack membership ──────────────────────────────────────────────────────────

test('a pack that does not offer an optional capability reports not_in_pack, not disabled', () => {
  const resolved = resolveCapabilityProfile(emptyProfile('acme'), { env: JKISS_ENV, packCapabilities: ['bookings', 'messaging', 'notifications'] })
  assert.equal(resolved['sms-delivery'].state, 'not_in_pack')
  // Core is the platform, not the vertical — a pack never removes it.
  assert.equal(resolved['bookings'].state, 'ready')
  assert.equal(resolved['routes'].state, 'ready')
})

test('providerEnablement is derived from the resolved profile, not from the environment', () => {
  const resolved = resolveCapabilityProfile(emptyProfile('supercharged'), { env: JKISS_ENV, packCapabilities: ['bookings'] })
  // Credentials are present, but the pack does not offer the adapters.
  assert.deepEqual(providerEnablement(resolved), { stripe: false, twilio: false, resend: false, ai: false })
})
