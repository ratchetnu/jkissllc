import { redis } from '../redis'

// AI-specific audit + usage log (LLMOps Phase 1). Every AI call — success, invalid
// response, provider failure, or an RBAC denial — is recorded here with who ran it,
// under which tenant, which prompt version and model, latency, token usage, an
// estimated cost, and (optionally) helpful/not-helpful feedback. This is the
// observability substrate the later AI Control Center will read; Phase 1 just writes
// it. Mirrors the platform's Redis conventions (JSON blob per record + a zset index).

export type AiCallOutcome = 'success' | 'invalid_response' | 'provider_error' | 'forbidden' | 'budget_exceeded'

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
  latencyMs: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estCostUsd: number
  requestChars: number
  responseValid: boolean
  feedback?: 'helpful' | 'not_helpful'
  feedbackAt?: number
}

const KEY = (id: string) => `ai:call:${id}`
const INDEX = 'ai:log'                      // zset score=at member=id
const MAX_KEEP = 10_000

// ── Estimated cost (documented estimate, not a billed figure) ────────────────
// USD per 1M tokens. Sonnet-class default; extend as models are added. These are
// list-price estimates for visibility only — the Gateway is the source of truth.
const RATES: Record<string, { in: number; out: number }> = {
  'anthropic/claude-sonnet-4-6': { in: 3, out: 15 },
  'anthropic/claude-haiku-4-5': { in: 1, out: 5 },
  default: { in: 3, out: 15 },
}
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const r = RATES[model] ?? RATES.default
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
  return raws
    .map(r => { try { return r ? JSON.parse(r as string) as AiCallRecord : null } catch { return null } })
    .filter((x): x is AiCallRecord => x !== null)
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
