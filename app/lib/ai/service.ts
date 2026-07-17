import type { ModelMessage } from 'ai'
import { can, type Permission, type Role } from '../rbac'
import { generateAI, type AiGenResult } from '../ai'
import { tenantId } from '../tenant'
import { getPrompt } from './prompts'
import { resolvePrompt, type ResolvedPrompt } from './prompt-store'
import { validateJson, type ObjectSchema } from './schema'
import { recordAiCall, estimateCostDetailed, type AiCallRecord, type AiCallOutcome, type CostSource, type AiCallKind } from './telemetry'
import { modelForFeature } from './routing'
import { overBudget, addCost } from './budget'
import { scoreResponse, type QualityResult } from './quality'

// Centralized server-side AI service (LLMOps Phase 1→3). Every AI feature routes
// through runAiTask, the ONE place that:
//   1. enforces RBAC (when a permission is required)
//   2. enforces the daily cost cap (governance)
//   3. resolves the versioned prompt — built-in, an admin override, or an A/B arm
//   4. routes to the per-feature model
//   5. calls the model via the Gateway with fail-soft retries (attempts tracked)
//   6. reconciles cost (provider-reported when available, else estimated) + accrues it
//   7. validates the structured response against a schema (rejects invalid output)
//   8. scores response quality (heuristic, read-only) and records full telemetry/audit
// It is read-only/draft-only by construction: it returns validated data/text and
// writes only to the AI audit log + the cost counter. No autonomous business writes.

export type AiPrincipal = { sub: string; role: Role }

export type AiTaskInput = {
  taskId: string
  vars: Record<string, unknown>
  feature: string
  principal?: AiPrincipal          // omitted for public/system features (e.g. photo estimate)
  requiredPermission?: Permission  // enforced only when set
  schema?: ObjectSchema
  messages?: ModelMessage[]        // multimodal / chat input; overrides the prompt string when present
  maxOutputTokens?: number
  temperature?: number
  timeoutMs?: number               // per-call abort override (slow heavy-detail vision on a long-budget cron)
  requestChars?: number
  // ── Telemetry attribution (all optional; recorded when supplied) ──
  kind?: AiCallKind                // primary (default) | shadow | fallback | mock | suppressed
  bookingId?: string               // joins the audit row back to the booking it served
  jobId?: string                   // durable job / idempotency key this call served
  imageCount?: number              // images sent to the model (multimodal cost driver)
  queuedAt?: number                // when the work was enqueued — for queue-latency accounting
}

export type AiTaskDeps = {
  generate?: (o: { system?: string; prompt?: string; messages?: ModelMessage[]; maxOutputTokens?: number; temperature?: number; model?: string; timeoutMs?: number }) => Promise<AiGenResult>
  record?: (rec: AiCallRecord) => Promise<void>
  now?: () => number
  isOverBudget?: () => Promise<boolean>
  accrueCost?: (usd: number) => Promise<number>
  resolve?: (taskId: string, vars: Record<string, unknown>, roll?: number) => Promise<ResolvedPrompt>
  score?: (feature: string, text: string) => QualityResult
  roll?: number                    // injected A/B roll (0..1) for deterministic tests
  maxAttempts?: number             // model-call attempts on transient failure (default 2)
}

export type AiTaskResult<T> =
  | { ok: true; data: T; text: string; callId: string; usage: { inputTokens: number; outputTokens: number; totalTokens: number }; latencyMs: number; model: string; promptVersion: number; qualityScore: number }
  | { ok: false; error: string; status: number; callId: string; outcome: AiCallOutcome; errorClass: string }

// Coarse failure classification for observability dashboards.
function classifyError(msg: string): string {
  const m = msg.toLowerCase()
  if (/credit|quota|billing|payment|insufficient/.test(m)) return 'billing'
  if (/unauthor|forbidden|api key|token/.test(m)) return 'auth'
  if (/rate|429|too many/.test(m)) return 'rate_limit'
  if (/timeout|timed out|etimedout|econn|network|fetch failed/.test(m)) return 'network'
  if (/overload|unavailable|503|502|temporarily/.test(m)) return 'provider_unavailable'
  return 'other'
}
function isTransient(errClass: string): boolean {
  return errClass === 'network' || errClass === 'provider_unavailable' || errClass === 'rate_limit'
}

export async function runAiTask<T = Record<string, unknown>>(input: AiTaskInput, deps: AiTaskDeps = {}): Promise<AiTaskResult<T>> {
  const generate = deps.generate ?? generateAI
  const record = deps.record ?? recordAiCall
  const now = deps.now ?? Date.now
  const isOverBudget = deps.isOverBudget ?? overBudget
  const accrueCost = deps.accrueCost ?? addCost
  const resolve = deps.resolve ?? resolvePrompt
  const score = deps.score ?? scoreResponse
  const maxAttempts = Math.max(1, deps.maxAttempts ?? 2)
  const tid = tenantId()
  const callId = crypto.randomUUID()
  const builtinVersion = getPrompt(input.taskId).version   // throws on unknown taskId (guarded by tests)

  const at = now()
  const base: Omit<AiCallRecord, 'ok' | 'outcome'> = {
    id: callId, at, tenantId: tid,
    actor: input.principal?.sub ?? 'public', role: input.principal?.role ?? 'public',
    feature: input.feature, taskId: input.taskId, promptVersion: builtinVersion,
    model: '', latencyMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
    estCostUsd: 0, requestChars: input.requestChars ?? 0, responseValid: false,
    kind: input.kind ?? 'primary', bookingId: input.bookingId, jobId: input.jobId,
    imageCount: input.imageCount, queuedAt: input.queuedAt, createdAt: at,
  }
  const write = async (rec: AiCallRecord) => { try { await record(rec) } catch (e) { console.error('[ai/service] telemetry', e) } }

  // 1) RBAC — role enforcement (only when a permission is required).
  if (input.requiredPermission && (!input.principal || !can(input.principal.role, input.requiredPermission))) {
    await write({ ...base, ok: false, outcome: 'forbidden', error: 'forbidden' })
    return { ok: false, error: 'forbidden', status: 403, callId, outcome: 'forbidden', errorClass: 'auth' }
  }

  // 2) Cost governance — refuse fail-soft when today's cap is reached.
  try {
    if (await isOverBudget()) {
      await write({ ...base, ok: false, outcome: 'budget_exceeded', error: 'daily AI budget reached' })
      return { ok: false, error: 'The daily AI budget has been reached — please try again tomorrow.', status: 429, callId, outcome: 'budget_exceeded', errorClass: 'budget' }
    }
  } catch { /* budget check is best-effort — never block on it */ }

  // 3) Resolve the prompt: built-in, an admin override, or an A/B arm.
  const resolved = await resolve(input.taskId, input.vars, deps.roll)
  const promptVersion = resolved.version
  const promptVariant = resolved.variant
  const versioned: Omit<AiCallRecord, 'ok' | 'outcome'> = { ...base, promptVersion, promptVariant }

  // 4) per-feature model + 5) model call with fail-soft retries.
  const model = modelForFeature(input.feature)
  const startedAt = now()
  let gen: AiGenResult = { ok: false, error: 'not run' }
  let attempts = 0
  let lastClass = 'other'
  while (attempts < maxAttempts) {
    attempts++
    try {
      gen = await generate({ system: resolved.system, prompt: input.messages ? undefined : resolved.prompt, messages: input.messages, model, maxOutputTokens: input.maxOutputTokens, temperature: input.temperature, timeoutMs: input.timeoutMs })
    } catch (e) {
      gen = { ok: false, error: e instanceof Error ? e.message : 'AI request failed' }
    }
    if (gen.ok) break
    lastClass = classifyError(gen.error)
    if (!isTransient(lastClass)) break   // don't retry permanent failures (billing/auth/bad request)
  }
  const completedAt = now()
  const latencyMs = Math.max(0, completedAt - startedAt)   // processing latency (model call)
  const retried = attempts > 1
  // Queue + total latency (only meaningful when the caller supplied queuedAt).
  const queueLatencyMs = input.queuedAt != null ? Math.max(0, startedAt - input.queuedAt) : undefined
  const totalLatencyMs = input.queuedAt != null ? Math.max(0, completedAt - input.queuedAt) : latencyMs
  const timing = { startedAt, completedAt, queueLatencyMs, totalLatencyMs }

  if (!gen.ok) {
    await write({ ...versioned, ok: false, outcome: 'provider_error', error: gen.error, errorClass: lastClass, providerErrorCode: gen.errorKind ?? lastClass, latencyMs, model, attempts, retried, ...timing })
    // errorClass is the ONLY thing that distinguishes a retryable blip from a permanent
    // billing/auth rejection. Callers need it to decide whether a retry can ever succeed.
    return { ok: false, error: gen.error, status: 503, callId, outcome: 'provider_error', errorClass: lastClass }
  }

  // 6) Cost reconciliation: provider-reported cost when available, else estimate. The
  // estimate carries its provenance (which cost sheet, whether the rate was a fallback).
  const cost = estimateCostDetailed(gen.model, gen.usage.inputTokens, gen.usage.outputTokens)
  const estCostUsd = cost.usd
  const hasActual = typeof gen.providerCostUsd === 'number' && Number.isFinite(gen.providerCostUsd)
  const costSource: CostSource = hasActual ? 'actual' : 'estimated'
  const chargedCost = hasActual ? (gen.providerCostUsd as number) : estCostUsd
  await accrueCost(chargedCost).catch(() => {})

  // 8) Heuristic quality score (read-only, fail-soft).
  const quality = score(input.feature, gen.text)

  const usageBase: Omit<AiCallRecord, 'ok' | 'outcome' | 'responseValid'> = {
    ...versioned, model: gen.model, latencyMs, attempts, retried, ...timing,
    inputTokens: gen.usage.inputTokens, outputTokens: gen.usage.outputTokens, totalTokens: gen.usage.totalTokens,
    estCostUsd, actualCostUsd: hasActual ? (gen.providerCostUsd as number) : undefined, costSource,
    costTableVersion: cost.tableVersion, rateFallback: cost.rateFallback,
    qualityScore: quality.score, qualityFlags: quality.flags,
  }

  // 7) Structured, schema-validated response (invalid → rejected).
  if (input.schema) {
    const v = validateJson(gen.text, input.schema)
    if (!v.ok) {
      await write({ ...usageBase, ok: false, outcome: 'invalid_response', error: v.error, responseValid: false })
      return { ok: false, error: 'The AI returned an unexpected response.', status: 502, callId, outcome: 'invalid_response', errorClass: 'schema' }
    }
    await write({ ...usageBase, ok: true, outcome: 'success', responseValid: true })
    return { ok: true, data: v.value as T, text: gen.text, callId, usage: gen.usage, latencyMs, model: gen.model, promptVersion, qualityScore: quality.score }
  }

  await write({ ...usageBase, ok: true, outcome: 'success', responseValid: true })
  return { ok: true, data: {} as T, text: gen.text, callId, usage: gen.usage, latencyMs, model: gen.model, promptVersion, qualityScore: quality.score }
}
