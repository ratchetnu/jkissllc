// The `ai_provider` health component must be capable of going red.
//
// For the whole of the 2026-08-14 outage it reported `ok` while every single model call
// came back HTTP 402. Two independent reasons, both fixed here:
//
//   1. It accepted `VERCEL` as a credential. `VERCEL` is set on every Vercel runtime
//      unconditionally, so the check could not return anything else. A signal that
//      cannot go red is not a signal.
//   2. It only knew Gateway credentials, so after the transport moved to Anthropic it
//      was reporting on a path carrying no traffic at all.
//
//   H1  the outage condition itself — VERCEL present, no real credential
//   H2  the component follows the ACTIVE transport
//   H3  presence is never claimed as proof of reachability
//   H4  a failed real call downgrades it; a transient blip does not
//   H5  the observed-outcome path is fail-soft in every direction
//   H6  the provider rule is shared, not restated
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'

import { aiProviderComponent, applyObservedAiOutcome, runHealthChecks } from '../app/lib/health'
import { resolveAiProvider, credentialKeysFor, providerCredentialPresent } from '../app/lib/ai/provider-config'

// ── H1 — the outage condition ────────────────────────────────────────────────

test('H1: VERCEL alone is NOT a credential — this is the exact state that reported ok', () => {
  // Production during the outage: running on Vercel, no gateway key, no OIDC token in
  // the env, zero Vercel credits. The old predicate was
  // has('AI_GATEWAY_API_KEY','VERCEL_OIDC_TOKEN','VERCEL'), which `VERCEL` alone
  // satisfied. Every call was 402ing and health was green.
  const c = aiProviderComponent({ VERCEL: '1' })
  assert.equal(c.status, 'degraded', 'VERCEL is not a credential and must not read as configured')
  assert.doesNotMatch(String(c.detail), /credential present/)
})

test('H1: MUTATION GUARD — the component can reach every status it claims', () => {
  // A check that only ever returns one value is decoration. Pin both directions.
  assert.equal(aiProviderComponent({ VERCEL: '1', AI_GATEWAY_API_KEY: 'k' }).status, 'ok')
  assert.equal(aiProviderComponent({ VERCEL: '1' }).status, 'degraded')
  assert.equal(aiProviderComponent({}).status, 'degraded')
})

// ── H2 — follows the active transport ────────────────────────────────────────

test('H2: on the anthropic transport, a Gateway credential proves nothing', () => {
  const c = aiProviderComponent({ AI_PROVIDER: 'anthropic', AI_GATEWAY_API_KEY: 'k', VERCEL_OIDC_TOKEN: 't' })
  assert.equal(c.status, 'degraded', 'gateway credentials are irrelevant once traffic moved')
  assert.match(String(c.detail), /Anthropic API/)
  assert.match(String(c.detail), /ANTHROPIC_API_KEY/, 'and it names the variable that would fix it')
})

test('H2: and vice versa — an Anthropic key does not configure the Gateway path', () => {
  const c = aiProviderComponent({ ANTHROPIC_API_KEY: 'sk-ant-x', VERCEL: '1' })
  assert.equal(c.status, 'degraded')
  assert.match(String(c.detail), /Vercel AI Gateway/)
})

test('H2: each transport is satisfied by its own credential', () => {
  assert.equal(aiProviderComponent({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-x' }).status, 'ok')
  assert.equal(aiProviderComponent({ AI_GATEWAY_API_KEY: 'k' }).status, 'ok')
  assert.equal(aiProviderComponent({ VERCEL_OIDC_TOKEN: 't' }).status, 'ok')
})

// ── H3 — honesty about what a presence check means ───────────────────────────

test('H3: an ok status never claims the provider is reachable', () => {
  const detail = String(aiProviderComponent({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'x' }).detail)
  assert.match(detail, /presence only/i)
  assert.match(detail, /real calls/i, 'the reader must be told what would actually prove it')
})

// ── H4 — observed outcome ────────────────────────────────────────────────────

const OK_COMPONENT = { name: 'ai_provider', critical: false, status: 'ok' as const, detail: 'credential present' }

test('H4: a persistent provider failure downgrades a green component', () => {
  for (const last of [
    { ok: false, outcome: 'provider_error', errorClass: 'billing' },
    { ok: false, outcome: 'provider_error', errorClass: 'auth' },
    { ok: false, outcome: 'provider_error' },
  ]) {
    const c = applyObservedAiOutcome(OK_COMPONENT, last)
    assert.equal(c.status, 'degraded', `should downgrade on ${JSON.stringify(last)}`)
    assert.match(String(c.detail), /LAST CALL FAILED/)
  }
})

test('H4: a transient blip does NOT downgrade — health must not flap on one timeout', () => {
  const c = applyObservedAiOutcome(OK_COMPONENT, { ok: false, outcome: 'timeout', errorClass: 'network' })
  assert.equal(c.status, 'ok')
  assert.equal(c.detail, OK_COMPONENT.detail, 'and the detail is left untouched')
})

test('H4: a successful last call leaves the component exactly as-is', () => {
  assert.deepEqual(applyObservedAiOutcome(OK_COMPONENT, { ok: true, outcome: 'success' }), OK_COMPONENT)
})

// ── H5 — fail-soft ───────────────────────────────────────────────────────────

test('H5: no reader, no data, or a thrown reader all leave the verdict untouched', async () => {
  assert.deepEqual(applyObservedAiOutcome(OK_COMPONENT, null), OK_COMPONENT)
  assert.deepEqual(applyObservedAiOutcome(OK_COMPONENT, undefined), OK_COMPONENT)

  // A telemetry failure must never make the health endpoint itself look unhealthy.
  const report = await runHealthChecks({
    pingKv: async () => true,
    env: { VERCEL: '1', AI_GATEWAY_API_KEY: 'k' },
    lastAiCall: async () => { throw new Error('redis down') },
  })
  const ai = report.components.find(c => c.name === 'ai_provider')
  assert.equal(ai?.status, 'ok', 'a throwing reader is swallowed, not propagated')
})

test('H5: end to end — a green credential plus a billing failure reports degraded', async () => {
  const report = await runHealthChecks({
    pingKv: async () => true,
    env: { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-x' },
    lastAiCall: async () => ({ ok: false, outcome: 'provider_error', errorClass: 'billing', at: 1 }),
  })
  const ai = report.components.find(c => c.name === 'ai_provider')
  assert.equal(ai?.status, 'degraded')
  // ai_provider is non-critical, so it must not turn the whole report red or 503 the
  // uptime monitor — it degrades, it does not page.
  assert.notEqual(report.status, 'unhealthy')
})

// ── H6 — one definition of the rule ──────────────────────────────────────────

test('H6: the provider rule is shared with the AI layer, not restated', () => {
  assert.equal(resolveAiProvider({}), 'gateway')
  assert.equal(resolveAiProvider({ AI_PROVIDER: '  Anthropic ' }), 'anthropic')
  assert.equal(resolveAiProvider({ AI_PROVIDER: 'anthropik' }), 'gateway')

  // VERCEL must not appear in any credential list — that is the whole bug.
  for (const p of ['gateway', 'anthropic'] as const) {
    assert.ok(!credentialKeysFor(p).includes('VERCEL'), `${p} must not treat VERCEL as a credential`)
  }
  assert.equal(providerCredentialPresent({ VERCEL: '1' }), false)
})
