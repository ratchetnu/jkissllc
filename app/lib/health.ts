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

export type ComponentStatus = 'ok' | 'degraded' | 'down'
export type HealthComponent = { name: string; status: ComponentStatus; critical: boolean; detail: string }
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
export function configChecks(env: Env): HealthComponent[] {
  const has = (...keys: string[]) => keys.some(k => !!env[k])
  return [
    { name: 'storage', critical: false, status: has('BLOB_READ_WRITE_TOKEN') ? 'ok' : 'degraded', detail: has('BLOB_READ_WRITE_TOKEN') ? 'Blob configured' : 'Blob token not set — photo uploads disabled' },
    // The Vercel AI Gateway authenticates via auto-injected OIDC when deployed on
    // Vercel (no static key needed), so `VERCEL` presence is a valid "configured".
    { name: 'ai_provider', critical: false, status: has('AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'VERCEL') ? 'ok' : 'degraded', detail: has('AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'VERCEL') ? 'AI gateway configured' : 'AI gateway not configured — analysis falls back to manual review' },
    { name: 'scheduled_worker', critical: false, status: has('CRON_SECRET') ? 'ok' : 'degraded', detail: has('CRON_SECRET') ? 'Cron secret set' : 'CRON_SECRET not set — durable worker + cron disabled' },
    { name: 'payments', critical: false, status: has('STRIPE_SECRET_KEY') ? 'ok' : 'degraded', detail: has('STRIPE_SECRET_KEY') ? 'Stripe configured' : 'Stripe not configured — card payments disabled' },
    { name: 'email', critical: false, status: has('RESEND_API_KEY') ? 'ok' : 'degraded', detail: has('RESEND_API_KEY') ? 'Email configured' : 'Email not configured — notifications limited' },
  ]
}

export type HealthDeps = {
  pingKv: () => Promise<boolean>   // lightweight write-then-read round trip
  env: Env
  now?: () => number
  build?: string
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
  const components = [kv, ...configChecks(deps.env)]
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
    components: report.components.map(c => ({ name: c.name, status: c.status, critical: c.critical, detail: c.detail })),
  }
}

export const httpStatusFor = (s: OverallStatus): number => (s === 'unhealthy' ? 503 : 200)
