import { redis } from '../redis'
import { isEnabled } from '../platform/flags'
import { currentTenantId } from '../platform/tenancy/context'
import {
  MODEL_RATES, estimateCostUsd, estimateCostDetailed, isKnownModel, modelRate,
  type ModelRate, type CostEstimate,
} from './cost-tables'

// AI-specific audit + usage log (LLMOps Phase 1). Every AI call — success, invalid
// response, provider failure, or an RBAC denial — is recorded here with who ran it,
// under which tenant, which prompt version and model, latency, token usage, an
// estimated cost, and (optionally) helpful/not-helpful feedback. This is the
// observability substrate the later AI Control Center will read; Phase 1 just writes
// it. Mirrors the platform's Redis conventions (JSON blob per record + a zset index).

export type AiCallOutcome = 'success' | 'invalid_response' | 'provider_error' | 'forbidden' | 'budget_exceeded'

export type CostSource = 'estimated' | 'actual'

// How the RESULT of this call was used — so shadow / fallback / mock spend can be told
// apart from the authoritative primary path (they otherwise share a `feature`).
//   primary    — the authoritative result the product used
//   shadow     — an off-path evaluation run (e.g. V2 vision shadow); never shown to a customer
//   fallback   — a secondary/backup or second-opinion pass
//   mock       — a stubbed/injected response (tests, offline) — not a real provider call
//   suppressed — a governed/flagged-off path that recorded intent without acting
export type AiCallKind = 'primary' | 'shadow' | 'fallback' | 'mock' | 'suppressed'

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
  // ── Telemetry foundation: attribution, cost provenance, timing, review ──
  kind?: AiCallKind        // primary (default) | shadow | fallback | mock | suppressed
  provider?: string        // derived from `model` (e.g. 'anthropic'); recorded dimension
  modelVersion?: string    // derived trailing version token of `model` (e.g. '4-6')
  bookingId?: string       // joins this call back to the booking it priced (public paths)
  jobId?: string           // durable job / idempotency key this call served
  imageCount?: number      // images sent to the model (multimodal cost driver)
  confidenceScore?: number // 0..1 model/analysis confidence (attached post-hoc)
  manualReviewReason?: string // why this was routed to a human (redacted, non-PII)
  providerErrorCode?: string  // coarse provider error code, redacted of sensitive data
  costTableVersion?: string   // which cost sheet priced the estimate
  rateFallback?: boolean      // true → model had no published rate (default rate used)
  queuedAt?: number        // when the work was enqueued (for queue latency)
  startedAt?: number       // when the model call began
  completedAt?: number     // when the model call finished
  queueLatencyMs?: number  // startedAt − queuedAt (time waiting in the queue)
  totalLatencyMs?: number  // completedAt − queuedAt (end-to-end)
  createdAt?: number       // record creation (mirrors `at`; explicit for consumers)
  updatedAt?: number       // last mutation (feedback / post-hoc enrichment)
}

const KEY = (id: string) => `ai:call:${id}`
const INDEX = 'ai:log'                      // zset score=at member=id
const DEDUP = (id: string) => `ai:rec:${id}`   // idempotency guard for one execution
const DEDUP_TTL_MS = 60 * 60 * 1000
const MAX_KEEP = 10_000

// The Redis surface the telemetry store needs. `redis` satisfies it; tests inject an
// in-memory fake. Optional param, defaults to the real client — signatures stay
// backward-compatible (callers pass nothing).
export type TelemetryStore = Pick<typeof redis,
  'get' | 'set' | 'del' | 'zadd' | 'zrevrange' | 'zrange' | 'zrem' | 'zcard' | 'setNxPx'>


// Re-export the centralized, versioned cost primitives so existing importers of
// './telemetry' (service.ts, analysis-v2.ts, registry.ts, tests) keep working
// unchanged after the cost table moved to cost-tables.ts.
export { MODEL_RATES, estimateCostUsd, estimateCostDetailed, isKnownModel, modelRate }
export type { ModelRate, CostEstimate }

// ── PII / secret redaction (defense-in-depth at the sink) ────────────────────
// Persisted telemetry must never carry a URL with credentials, an API key/token, an
// email, or raw customer content. Callers already pass friendly/safe strings; this
// centralizes a final scrub so ANY record written to `ai:log` is safe regardless of
// caller. Pure + exported for direct testing.
export function redactText(input: string | undefined): string | undefined {
  if (input == null) return input
  let s = String(input)
  // URLs (may embed tokens / signed blob params / customer identifiers).
  s = s.replace(/\bhttps?:\/\/[^\s"']+/gi, '[url]')
  // Bearer tokens / api keys / secrets in key=value or "sk-..." form.
  s = s.replace(/\b(bearer|token|api[-_]?key|secret|authorization|password)\b\s*[:=]\s*\S+/gi, '$1=[redacted]')
  s = s.replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g, '[key]')
  // Email addresses.
  s = s.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]')
  // Long opaque hex/base64 blobs (signatures, ids) — 24+ chars.
  s = s.replace(/\b[A-Fa-f0-9]{24,}\b/g, '[hash]')
  return s.slice(0, 500)   // bound stored length
}

// ── Provider / model-version derivation ──────────────────────────────────────
// `model` is a Gateway "provider/model" string. Split out a first-class provider
// dimension and a trailing version token so dashboards can group by provider and by
// model generation without re-parsing the string everywhere (it was derived ad-hoc
// and even discarded before). Pure + exported for testing.
export function deriveProviderModel(model: string): { provider: string; modelVersion?: string } {
  if (!model) return { provider: 'unknown' }
  const provider = model.includes('/') ? model.split('/')[0] : 'vercel-ai-gateway'
  const tail = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model
  const m = /(\d+(?:[.-]\d+)*)\s*$/.exec(tail)
  return { provider, modelVersion: m ? m[1] : undefined }
}

// Enrich a record with derived/defaulted telemetry fields just before persistence:
// default kind, derived provider/version, redacted free-text, and created/updated
// stamps. Idempotent — safe to call on an already-enriched record.
export function enrichRecord(rec: AiCallRecord): AiCallRecord {
  const out: AiCallRecord = { ...rec }
  if (!out.kind) out.kind = 'primary'
  if (out.model && (!out.provider || out.modelVersion === undefined)) {
    const d = deriveProviderModel(out.model)
    out.provider = out.provider ?? d.provider
    if (out.modelVersion === undefined) out.modelVersion = d.modelVersion
  }
  out.error = redactText(out.error)
  out.providerErrorCode = redactText(out.providerErrorCode)
  out.manualReviewReason = redactText(out.manualReviewReason)
  if (out.createdAt === undefined) out.createdAt = out.at
  out.updatedAt = out.at
  return out
}

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

export async function recordAiCall(rec: AiCallRecord, store: TelemetryStore = redis): Promise<void> {
  try {
    const enriched = enrichRecord(rec)
    // Idempotency: guard against writing two records for the SAME execution (same id),
    // e.g. an accidental double-record or a re-delivered handler. First writer wins;
    // a duplicate is skipped. Fail-OPEN — if the guard errors we still record (better
    // to keep the row than lose it). ai:* is a platform-global key family (unscoped).
    try {
      const fresh = await store.setNxPx(DEDUP(enriched.id), '1', DEDUP_TTL_MS)
      if (!fresh) return   // already recorded this execution — no duplicate
    } catch { /* guard unavailable → fall through and record */ }

    await store.set(KEY(enriched.id), JSON.stringify(enriched))
    await store.zadd(INDEX, enriched.at, enriched.id)
    const n = await store.zcard(INDEX)
    if (n > MAX_KEEP + 200) {
      const stale = await store.zrange(INDEX, 0, n - MAX_KEEP - 1)
      await Promise.all(stale.map(id => Promise.all([store.del(KEY(id)), store.zrem(INDEX, id)])))
    }
  } catch (e) {
    // Telemetry must never break the request path (fail-soft).
    console.error('[ai/telemetry] record failed', e)
  }
}

export async function getAiCall(id: string, store: TelemetryStore = redis): Promise<AiCallRecord | null> {
  const raw = await store.get(KEY(id))
  if (!raw) return null
  try { return JSON.parse(raw as string) as AiCallRecord } catch { return null }
}

export async function listAiCalls(limit = 200, store: TelemetryStore = redis): Promise<AiCallRecord[]> {
  const ids = await store.zrevrange(INDEX, 0, limit - 1)
  if (!ids.length) return []
  const raws = await Promise.all(ids.map(id => store.get(KEY(id))))
  const recs = raws
    .map(r => { try { return r ? JSON.parse(r as string) as AiCallRecord : null } catch { return null } })
    .filter((x): x is AiCallRecord => x !== null)
  return scopeAiRecords(recs)   // inert when TENANCY_ENABLED=false; tenant-filtered when on
}

// Attach optional helpful/not-helpful feedback to a recorded call. Scoped: the caller
// must belong to the same tenant (enforced by the route).
export async function setAiFeedback(id: string, helpful: boolean, tenantId: string, store: TelemetryStore = redis): Promise<boolean> {
  const rec = await getAiCall(id, store)
  if (!rec || rec.tenantId !== tenantId) return false
  rec.feedback = helpful ? 'helpful' : 'not_helpful'
  rec.feedbackAt = Date.now()
  rec.updatedAt = rec.feedbackAt
  await store.set(KEY(id), JSON.stringify(rec))
  return true
}

// Post-hoc enrichment for fields only known AFTER the model call returns and has been
// recorded — the analysis confidence, or the manual-review reason the workflow chose.
// Non-blocking + fail-soft (a telemetry write must never break the business flow) and
// never overwrites tenant/identity fields. Redacts free-text. Returns false silently
// when the record is gone (trimmed) or Redis is unavailable.
export async function updateAiCall(
  id: string,
  patch: Partial<Pick<AiCallRecord, 'confidenceScore' | 'manualReviewReason' | 'kind' | 'bookingId' | 'jobId' | 'imageCount'>>,
  store: TelemetryStore = redis,
): Promise<boolean> {
  try {
    const rec = await getAiCall(id, store)
    if (!rec) return false
    if (patch.confidenceScore !== undefined && Number.isFinite(patch.confidenceScore)) {
      rec.confidenceScore = Math.max(0, Math.min(1, patch.confidenceScore))
    }
    if (patch.manualReviewReason !== undefined) rec.manualReviewReason = redactText(patch.manualReviewReason)
    if (patch.kind !== undefined) rec.kind = patch.kind
    if (patch.bookingId !== undefined) rec.bookingId = patch.bookingId
    if (patch.jobId !== undefined) rec.jobId = patch.jobId
    if (patch.imageCount !== undefined) rec.imageCount = patch.imageCount
    rec.updatedAt = Date.now()
    await store.set(KEY(id), JSON.stringify(rec))
    return true
  } catch (e) {
    console.error('[ai/telemetry] updateAiCall failed', e)
    return false
  }
}
