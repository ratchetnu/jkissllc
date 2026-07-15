import { redis } from '../redis'
import { isEnabled } from '../platform/flags'
import { currentTenantId } from '../platform/tenancy/context'

// AI-specific audit + usage log (LLMOps Phase 1). Every AI call — success, invalid
// response, provider failure, or an RBAC denial — is recorded here with who ran it,
// under which tenant, which prompt version and model, latency, token usage, an
// estimated cost, and (optionally) helpful/not-helpful feedback. This is the
// observability substrate the later AI Control Center will read; Phase 1 just writes
// it. Mirrors the platform's Redis conventions (JSON blob per record + a zset index).

export type AiCallOutcome = 'success' | 'invalid_response' | 'provider_error' | 'forbidden' | 'budget_exceeded'

export type CostSource = 'estimated' | 'actual'

export type AiCallRecord = {
  id: string
  at: number
  tenantId: string
  actor: string            // principal.sub — who invoked it
  role: string             // principal.role
  feature: string          // e.g. 'ops.command'
  taskId: string           // prompt registry id
  promptVersion: number
  model: string
  ok: boolean
  outcome: AiCallOutcome
  error?: string
  errorClass?: string      // coarse failure classification (Phase 3 observability)
  latencyMs: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estCostUsd: number
  actualCostUsd?: number   // provider-reported cost when the Gateway returns it
  costSource?: CostSource  // 'actual' when reconciled from provider metadata, else 'estimated'
  requestChars: number
  responseValid: boolean
  // ── Phase 3: observability + quality + A/B ──
  attempts?: number        // model-call attempts (1 = no retry)
  retried?: boolean
  promptVariant?: string   // A/B arm label ('control' | 'variant') when a test is live
  qualityScore?: number    // 0–100 heuristic score of the response (read-only)
  qualityFlags?: string[]  // e.g. ['too_long','has_placeholder','empty']
  feedback?: 'helpful' | 'not_helpful'
  feedbackAt?: number
}

const KEY = (id: string) => `ai:call:${id}`
const INDEX = 'ai:log'                      // zset score=at member=id
const MAX_KEEP = 10_000

// ── Tenant read-scope for the AI audit log (fixes audit H-AI-2) ───────────────
// `ai:*` is a PLATFORM-GLOBAL key family (keys.ts PLATFORM_GLOBAL_PREFIXES): the
// index `ai:log` and every `ai:call:{id}` record are a SINGLE physical set shared
// across tenants — the Redis chokepoint deliberately does NOT prefix them (cost is
// isolated separately via `ai:cost:{tid}:{day}`). Because the key namespace can't
// carry the boundary here, tenant isolation on the READ/rollup path is enforced in
// application code, filtering on the `tenantId` already stamped on every record.
//
// Inert by default: while TENANCY_ENABLED=false this returns the records UNCHANGED
// (byte-identical to today — every record, no filtering). When tenancy is enabled
// it returns only the current tenant's records; enabled-but-no-tenant-context fails
// CLOSED (returns none) rather than disclosing another tenant's AI output.
//
// Note on limit semantics when enabled: callers fetch the top-N global ids and this
// filters them to the tenant, so a tenant may see fewer than `limit` of its own
// rows. Acceptable + conservative; a per-tenant index (PROPOSED_TENANT_AI_KEYS) is
// the future O(tenant) replacement.
export function scopeAiRecords(records: AiCallRecord[]): AiCallRecord[] {
  if (!isEnabled('TENANCY_ENABLED')) return records
  const tid = currentTenantId()
  if (!tid) return []                        // fail closed — no cross-tenant disclosure
  return records.filter(r => r.tenantId === tid)
}

// ── PROPOSAL (dark-launch, NOT wired) — per-tenant AI telemetry keys ──────────
// Today the audit log is one global index filtered on read (scopeAiRecords). A
// future migration MAY move to a per-tenant index so reads are O(tenant) instead
// of scan-and-filter. These builders describe that scheme; nothing writes or reads
// them yet, and the live write key in recordAiCall is intentionally UNCHANGED this
// sprint. See docs/opspilot-os/tenant-isolation/07-name-derived-key-migration.md.
export const PROPOSED_TENANT_AI_KEYS = {
  index: (tid: string) => `ai:log:${tid}`,
  record: (tid: string, id: string) => `ai:call:${tid}:${id}`,
} as const

// ── Estimated cost (documented estimate, not a billed figure) ────────────────
// USD per 1M tokens. Sonnet-class default; extend as models are added. These are
// list-price estimates for visibility only — the Gateway is the source of truth.
export type ModelRate = { in: number; out: number }
export const MODEL_RATES: Record<string, ModelRate> = {
  'anthropic/claude-sonnet-4-6': { in: 3, out: 15 },
  'anthropic/claude-haiku-4-5': { in: 1, out: 5 },
  'anthropic/claude-opus-4-8': { in: 15, out: 75 },
  default: { in: 3, out: 15 },
}
// True when we have a published rate for this exact model string (so the UI can flag
// costs that fell back to the default rate — see AUDIT-F4).
export function isKnownModel(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(MODEL_RATES, model) && model !== 'default'
}
export function modelRate(model: string): ModelRate {
  return MODEL_RATES[model] ?? MODEL_RATES.default
}
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const r = modelRate(model)
  const usd = (inputTokens / 1_000_000) * r.in + (outputTokens / 1_000_000) * r.out
  return Math.round(usd * 1_000_000) / 1_000_000   // 6-dp micro-dollars
}

export async function recordAiCall(rec: AiCallRecord): Promise<void> {
  try {
    await redis.set(KEY(rec.id), JSON.stringify(rec))
    await redis.zadd(INDEX, rec.at, rec.id)
    const n = await redis.zcard(INDEX)
    if (n > MAX_KEEP + 200) {
      const stale = await redis.zrange(INDEX, 0, n - MAX_KEEP - 1)
      await Promise.all(stale.map(id => Promise.all([redis.del(KEY(id)), redis.zrem(INDEX, id)])))
    }
  } catch (e) {
    // Telemetry must never break the request path (fail-soft).
    console.error('[ai/telemetry] record failed', e)
  }
}

export async function getAiCall(id: string): Promise<AiCallRecord | null> {
  const raw = await redis.get(KEY(id))
  if (!raw) return null
  try { return JSON.parse(raw as string) as AiCallRecord } catch { return null }
}

export async function listAiCalls(limit = 200): Promise<AiCallRecord[]> {
  const ids = await redis.zrevrange(INDEX, 0, limit - 1)
  if (!ids.length) return []
  const raws = await Promise.all(ids.map(id => redis.get(KEY(id))))
  const recs = raws
    .map(r => { try { return r ? JSON.parse(r as string) as AiCallRecord : null } catch { return null } })
    .filter((x): x is AiCallRecord => x !== null)
  return scopeAiRecords(recs)   // inert when TENANCY_ENABLED=false; tenant-filtered when on
}

// Attach optional helpful/not-helpful feedback to a recorded call. Scoped: the caller
// must belong to the same tenant (enforced by the route).
export async function setAiFeedback(id: string, helpful: boolean, tenantId: string): Promise<boolean> {
  const rec = await getAiCall(id)
  if (!rec || rec.tenantId !== tenantId) return false
  rec.feedback = helpful ? 'helpful' : 'not_helpful'
  rec.feedbackAt = Date.now()
  await redis.set(KEY(id), JSON.stringify(rec))
  return true
}
