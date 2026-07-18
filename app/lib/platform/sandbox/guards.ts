// ── Operion Sandbox repair — safety guards (PURE) ────────────────────────────
//
// Multiple INDEPENDENT guards. A repair proceeds only if every one passes; any
// single failure refuses the whole operation. Kept pure so every branch is unit
// tested. Never returns hosts, tokens, or connection strings — refusal reasons are
// generic codes, never the underlying secret.

import { SANDBOX_SLUG } from './records'

// Known Production-linked KV hosts (the analytics/production Upstash store). If the
// deployment resolves its KV to one of these, we refuse to write even if every env
// signal says "preview" — the store identity is the last line of defence.
export const PRODUCTION_KV_HOSTS = ['smooth-vulture-92540.upstash.io']

// Production web domains. A request arriving on one of these is Production traffic.
export const PRODUCTION_DOMAINS = [
  'jkissllc.com', 'www.jkissllc.com',
  'superchargedenterprise.com', 'www.superchargedenterprise.com',
]

export type RefusalCode =
  | 'not_preview'            // VERCEL_ENV is not 'preview'
  | 'vercel_env_production'  // VERCEL_ENV explicitly 'production'
  | 'production_domain'      // request host is a known production domain
  | 'flag_disabled'          // OPERION_SANDBOX_REPAIR_ENABLED off
  | 'production_kv_store'    // resolved KV target is a known production store
  | 'wrong_slug'             // slug is not operion-sandbox
  | 'missing_confirmation'   // explicit confirmation value absent/incorrect

export type GuardInput = {
  vercelEnv?: string        // process.env.VERCEL_ENV
  requestHost?: string      // req host header (may include port)
  kvStoreHost?: string      // resolved KV store host from redis.kvHost() (host only, non-secret)
  repairFlagEnabled: boolean
}

export type RepairGuardInput = GuardInput & {
  slug?: string
  confirm?: string          // must equal the slug to confirm
}

function hostOf(v: string | undefined): string {
  if (!v) return ''
  try { return new URL(v.includes('://') ? v : `https://${v}`).host.toLowerCase().replace(/:\d+$/, '') }
  catch { return v.toLowerCase().replace(/:\d+$/, '') }
}

/** Environment-level guards, shared by diagnostics (read) and repair (write). */
export function environmentRefusals(i: GuardInput): RefusalCode[] {
  const out: RefusalCode[] = []
  const env = (i.vercelEnv ?? '').toLowerCase()
  // Positive assertion: must be a Preview deployment. Absent (local) or anything
  // else is refused — this endpoint only exists to fix the Preview store.
  if (env !== 'preview') out.push(env === 'production' ? 'vercel_env_production' : 'not_preview')
  if (PRODUCTION_DOMAINS.includes(hostOf(i.requestHost))) out.push('production_domain')
  if (!i.repairFlagEnabled) out.push('flag_disabled')
  // Store-identity guard: refuse when the deployment's KV resolves to a known
  // production store (prevents writing to the wrong DB even if env is spoofed).
  if (i.kvStoreHost && PRODUCTION_KV_HOSTS.includes(hostOf(i.kvStoreHost))) out.push('production_kv_store')
  return out
}

/** Repair adds the slug + explicit-confirmation guards on top of the environment ones. */
export function repairRefusals(i: RepairGuardInput): RefusalCode[] {
  const out = environmentRefusals(i)
  if (i.slug !== SANDBOX_SLUG) out.push('wrong_slug')
  if (!i.confirm || i.confirm !== SANDBOX_SLUG) out.push('missing_confirmation')
  return out
}

export const guardsPass = (refusals: RefusalCode[]): boolean => refusals.length === 0
