// ─────────────────────────────────────────────────────────────────────────────
// Production health checks. Verifies the critical + non-critical dependencies are
// present and reachable, WITHOUT ever exposing a secret value, connection string,
// customer data, or stack trace. Only booleans + component status leave this file.
//
//   critical down  → 'unhealthy' (HTTP 503)
//   non-critical unhealthy/absent → 'degraded' (HTTP 200)
//   all ok → 'healthy' (HTTP 200)
//
// The check logic is pure + injectable (the KV ping and the env are passed in) so
// it unit-tests with no real Redis and no real environment. `projectHealth`
// enforces the public-minimal / admin-detailed split.
// ─────────────────────────────────────────────────────────────────────────────

import { redis } from './redis'
import { buildId } from './alerts'
import { completionUploadReadiness } from './job-assignment'
import { tenancyOperatingProfile } from './platform/tenancy/operating-profile'
// Dependency-free by design — importing ./ai would pull the AI SDK into the health bundle.
import { resolveAiProvider, providerCredentialPresent, credentialKeysFor } from './ai/provider-config'
import {
  resolveProviderReadiness, type ProviderId, type ProviderReadiness,
} from './platform/capabilities/provider-readiness'

export type ComponentStatus = 'ok' | 'degraded' | 'down'
export type HealthComponent = {
  name: string
  status: ComponentStatus
  critical: boolean
  detail: string
  /**
   * False when this business does not use the component at all. A deployment with
   * no Stripe key and no intention of taking cards is not unwell, and reporting it
   * as degraded forever trains everyone to ignore the signal — which is how a real
   * outage hides. Informational: a not-applicable component reports `ok`, so the
   * rollup in `summarize` is unchanged.
   */
  applicable?: boolean
}
export type OverallStatus = 'healthy' | 'degraded' | 'unhealthy'
export type HealthReport = { status: OverallStatus; components: HealthComponent[]; build: string; at: string }

/** Roll component statuses into the overall verdict (pure). */
export function summarize(components: HealthComponent[]): OverallStatus {
  if (components.some(c => c.critical && c.status === 'down')) return 'unhealthy'
  if (components.some(c => c.status === 'down' || c.status === 'degraded')) return 'degraded'
  return 'healthy'
}

type Env = Record<string, string | undefined>

/** Presence-only configuration checks — NEVER the secret value, only whether set. */
/**
 * Credential PRESENCE for whichever transport is active. Pure and env-only; the
 * "does it actually work" half is applied by runHealthChecks when an outcome reader
 * is supplied.
 */
export function aiProviderComponent(env: Env): HealthComponent {
  const provider = resolveAiProvider(env)
  const label = provider === 'anthropic' ? 'Anthropic API' : 'Vercel AI Gateway'
  const present = providerCredentialPresent(env)
  return {
    name: 'ai_provider',
    critical: false,
    status: present ? 'ok' : 'degraded',
    detail: present
      ? `${label} credential present — presence only; reachability and credit are proven by real calls`
      : `${label} has no credential configured (${credentialKeysFor(provider).join(' / ')}) — analysis falls back to manual review`,
  }
}

/**
 * Downgrade `ai_provider` when the most recent real call FAILED at the provider.
 *
 * This is the half a config check can never cover, and the reason the outage was
 * invisible: credentials were present and the component said ok while every request was
 * rejected. Billing and auth failures are the ones worth surfacing — they are persistent
 * and need a human — whereas a one-off timeout is noise, so only provider-class failures
 * flip it.
 *
 * Fail-soft by construction: no reader supplied, a throw, or no calls recorded all leave
 * the presence verdict untouched. Health must never go red because health itself broke.
 */
export function applyObservedAiOutcome(
  component: HealthComponent,
  last: { ok: boolean; outcome?: string; errorClass?: string; at?: number } | null | undefined,
): HealthComponent {
  if (!last || last.ok) return component
  const cls = String(last.errorClass ?? '')
  const persistent = cls === 'billing' || cls === 'auth' || last.outcome === 'provider_error'
  if (!persistent) return component
  return {
    ...component,
    status: 'degraded',
    detail: `${component.detail} — LAST CALL FAILED (${last.outcome ?? 'provider_error'}${cls ? `/${cls}` : ''}); AI features are failing soft to manual review`,
  }
}

/**
 * Which optional provider channels this business has switched on. Supplied by the
 * caller from the tenant capability profile; defaults to "all on", which reproduces
 * the historical behavior exactly for any caller that does not pass it.
 */
export type ProviderEnablement = Record<ProviderId, boolean>
const ALL_ENABLED: ProviderEnablement = { stripe: true, twilio: true, resend: true, ai: true }

export type ConfigCheckOptions = {
  providers?: ProviderEnablement
  observed?: Partial<Record<ProviderId, { ok: boolean; errorClass?: string } | null>>
}

/** Map one provider readiness verdict onto a health component. */
function providerComponent(name: string, r: ProviderReadiness): HealthComponent {
  return {
    name,
    critical: false,
    // 'disabled' is a product decision, not a fault: it reports ok and marks itself
    // not-applicable. Everything else keeps the previous semantics.
    status: r.state === 'disabled' || r.state === 'ready' ? 'ok' : 'degraded',
    detail: r.detail,
    applicable: r.applicable,
  }
}

export function configChecks(env: Env, opts: ConfigCheckOptions = {}): HealthComponent[] {
  const has = (...keys: string[]) => keys.some(k => !!env[k])
  const tenancy = tenancyOperatingProfile(env)
  const providers = opts.providers ?? ALL_ENABLED
  const readiness = (id: ProviderId) =>
    resolveProviderReadiness({ provider: id, enabled: providers[id], env, observed: opts.observed?.[id] ?? null })
  const stripe = readiness('stripe')
  return [
    { name: 'tenancy_profile', critical: false, status: tenancy.valid ? 'ok' : 'degraded', detail: `${tenancy.profile}: ${tenancy.detail}` },
    { name: 'storage', critical: false, status: has('BLOB_READ_WRITE_TOKEN') ? 'ok' : 'degraded', detail: has('BLOB_READ_WRITE_TOKEN') ? 'Blob configured' : 'Blob token not set — photo uploads disabled' },
    // Holding a Blob token and being able to accept COMPLETION PROOF are different
    // capabilities. Minting a completion-upload token additionally requires the store
    // binding (`BLOB_STORE_ID`); without it the crew upload route fails closed with
    // `blob_store_not_configured` and the field just sees "Upload failed", while
    // `storage` above still reads ok. Asserted with the SAME predicate the upload route
    // calls, so readiness cannot drift from what actually gates the upload.
    { name: 'completion_uploads', critical: false, status: completionUploadReadiness(env.BLOB_STORE_ID).ready ? 'ok' : 'degraded', detail: completionUploadReadiness(env.BLOB_STORE_ID).ready ? 'Completion-photo uploads configured' : 'BLOB_STORE_ID not set — crew completion uploads fail closed (blob_store_not_configured)' },
    // Reports on the ACTIVE transport (AI_PROVIDER), not on the Gateway specifically.
    //
    // This previously accepted `VERCEL` as a credential, on the reasoning that the
    // Gateway auto-authenticates via OIDC on Vercel. But `VERCEL` is set on every Vercel
    // runtime unconditionally, which made the check structurally incapable of returning
    // anything but ok — and it duly reported ok throughout a total outage where every
    // single request came back 402. A signal that cannot go red is not a signal.
    //
    // It also only ever knew Gateway credentials, so after the transport switch it was
    // reporting on a path carrying no traffic. Both the provider rule and the credential
    // list now come from ai/provider-config, shared with the AI layer itself.
    //
    // This remains a PRESENCE check and says so. Whether calls actually succeed is
    // answered by the observed-outcome upgrade in runHealthChecks below.
    aiProviderComponent(env),
    { name: 'scheduled_worker', critical: false, status: has('CRON_SECRET') ? 'ok' : 'degraded', detail: has('CRON_SECRET') ? 'Cron secret set' : 'CRON_SECRET not set — durable worker + cron disabled' },
    // Payments / SMS / email now derive from the ONE shared readiness source
    // (platform/capabilities/provider-readiness.ts) that the send paths, the guards
    // and the deployment evidence also read, so health can no longer disagree with
    // what the app will actually do.
    providerComponent('payments', stripe),
    // Taking a card and CONFIRMING it are separate capabilities on the same provider.
    // Stripe can be fully able to charge while STRIPE_WEBHOOK_SECRET is unset — and then
    // /api/webhooks/stripe fails closed (503), so the durable backstop that marks a paid
    // route-invoice never runs and confirmation rests solely on the success-URL return
    // path. Reported separately so a working checkout can never mask a dead backstop.
    // Taking a card and CONFIRMING it are separate capabilities on the same
    // provider, so this stays its own component — but it is only meaningful when
    // card payments are switched on at all.
    stripe.state === 'disabled'
      ? { name: 'payments_webhook', critical: false, status: 'ok', detail: 'Card payments are turned off — no webhook backstop is required.', applicable: false }
      : { name: 'payments_webhook', critical: false, status: webhookStatus(has), detail: webhookDetail(has), applicable: true },
    providerComponent('email', readiness('resend')),
    // Twilio is asserted with the SAME predicate sms.ts sends by, not a single-key
    // proxy: an account SID alone (no auth pair, or no from/messaging-service) cannot
    // send, and must not read as configured.
    providerComponent('sms', readiness('twilio')),
  ]
}

type Has = (...keys: string[]) => boolean

/** Fail-closed: anything short of "Stripe key AND webhook secret present" is degraded. */
function webhookStatus(has: Has): ComponentStatus {
  return has('STRIPE_SECRET_KEY') && has('STRIPE_WEBHOOK_SECRET') ? 'ok' : 'degraded'
}

function webhookDetail(has: Has): string {
  if (!has('STRIPE_SECRET_KEY')) return 'Stripe not configured — payment webhook backstop inactive'
  if (!has('STRIPE_WEBHOOK_SECRET')) return 'STRIPE_WEBHOOK_SECRET not set — webhook fails closed; payment confirmation relies on the return path alone'
  return 'Stripe webhook backstop configured'
}

export type HealthDeps = {
  pingKv: () => Promise<boolean>   // lightweight write-then-read round trip
  env: Env
  now?: () => number
  build?: string
  /** Most recent AI call, if the caller wants `ai_provider` backed by observed reality
   *  rather than env presence alone. Optional and fail-soft — omit it and the report is
   *  exactly as before. */
  lastAiCall?: () => Promise<{ ok: boolean; outcome?: string; errorClass?: string; at?: number } | null>
  /**
   * Which optional provider channels this business uses, from its capability
   * profile. Fail-soft and optional: omit it and every provider is treated as
   * switched on, which is byte-identical to the pre-capability behavior.
   */
  providers?: () => Promise<ProviderEnablement | null>
}

/** Run all checks and produce the report. Injectable for tests. */
export async function runHealthChecks(deps: HealthDeps): Promise<HealthReport> {
  let kvOk = false
  try { kvOk = await deps.pingKv() } catch { kvOk = false }
  const kv: HealthComponent = {
    name: 'kv', critical: true,
    status: kvOk ? 'ok' : 'down',
    detail: kvOk ? 'Redis/KV read+write OK' : 'Redis/KV unreachable',
  }
  // Observed-outcome upgrade for ai_provider. Wrapped so a telemetry hiccup can never
  // make the health endpoint itself unhealthy.
  let lastAi: Awaited<ReturnType<NonNullable<HealthDeps['lastAiCall']>>> = null
  if (deps.lastAiCall) {
    try { lastAi = await deps.lastAiCall() } catch { lastAi = null }
  }
  // Capability selections come from the store, so they must never be able to make
  // the health endpoint itself fail. A throw, a null, or no resolver at all all
  // mean "assume every channel is in use" — the historical behavior.
  let providers: ProviderEnablement | null = null
  if (deps.providers) {
    try { providers = await deps.providers() } catch { providers = null }
  }
  const components = [
    kv,
    ...configChecks(deps.env, providers ? { providers } : {})
      .map(c => (c.name === 'ai_provider' ? applyObservedAiOutcome(c, lastAi) : c)),
  ]
  return {
    status: summarize(components),
    components,
    build: deps.build ?? buildId(),
    at: new Date(deps.now ? deps.now() : Date.now()).toISOString(),
  }
}

/** The real KV ping: write a short-lived key and read it back (no customer data). */
export async function pingKv(): Promise<boolean> {
  const key = `health:ping:${buildId()}`
  await redis.set(key, '1')
  await redis.pexpire(key, 10_000)
  return (await redis.get(key)) === '1'
}

/** Public = minimal + safe; detailed = component breakdown (admin/secret-gated).
 *  Neither form ever carries a secret value — components hold booleans/status only. */
export function projectHealth(report: HealthReport, opts: { detailed: boolean }): Record<string, unknown> {
  const base = { status: report.status, build: report.build, at: report.at }
  if (!opts.detailed) return base
  return {
    ...base,
    components: report.components.map(c => ({
      name: c.name, status: c.status, critical: c.critical, detail: c.detail,
      // Only ever a boolean; never a variable value.
      ...(c.applicable === undefined ? {} : { applicable: c.applicable }),
    })),
  }
}

export const httpStatusFor = (s: OverallStatus): number => (s === 'unhealthy' ? 503 : 200)
