import { can, type Permission, type Role } from '../rbac'
import { generateAI, type AiGenResult } from '../ai'
import { tenantId } from '../tenant'
import { getPrompt } from './prompts'
import { validateJson, type ObjectSchema } from './schema'
import { recordAiCall, estimateCostUsd, type AiCallRecord, type AiCallOutcome } from './telemetry'

// Centralized server-side AI service (LLMOps Phase 1). Every AI feature routes
// through runAiTask, which is the ONE place that:
//   1. enforces RBAC (a principal must hold the required permission)
//   2. loads the versioned prompt from the registry
//   3. calls the model via the Gateway (fail-soft)
//   4. validates the structured response against a schema (rejects invalid output)
//   5. records AI-specific telemetry/audit (tenant, actor, model, tokens, latency,
//      estimated cost, outcome) — never mutating any authoritative business data.
//
// It is read-only/draft-only by construction: it returns validated data to the
// caller and writes only to the AI audit log. No autonomous write actions.

export type AiPrincipal = { sub: string; role: Role }

export type AiTaskInput = {
  taskId: string
  vars: Record<string, unknown>
  principal: AiPrincipal
  feature: string
  requiredPermission?: Permission
  schema?: ObjectSchema
  maxOutputTokens?: number
  temperature?: number
  requestChars?: number
}

// Injectable dependencies — real by default, overridden in tests so the service can
// be exercised without the network or Redis.
export type AiTaskDeps = {
  generate?: (o: { system?: string; prompt?: string; maxOutputTokens?: number; temperature?: number }) => Promise<AiGenResult>
  record?: (rec: AiCallRecord) => Promise<void>
  now?: () => number
}

export type AiTaskResult<T> =
  | { ok: true; data: T; text: string; callId: string; usage: { inputTokens: number; outputTokens: number; totalTokens: number }; latencyMs: number; model: string }
  | { ok: false; error: string; status: number; callId: string; outcome: AiCallOutcome }

export async function runAiTask<T = Record<string, unknown>>(input: AiTaskInput, deps: AiTaskDeps = {}): Promise<AiTaskResult<T>> {
  const generate = deps.generate ?? generateAI
  const record = deps.record ?? recordAiCall
  const now = deps.now ?? Date.now
  const tid = tenantId()
  const callId = crypto.randomUUID()
  const prompt = getPrompt(input.taskId)

  const base: Omit<AiCallRecord, 'ok' | 'outcome'> = {
    id: callId, at: now(), tenantId: tid,
    actor: input.principal.sub, role: input.principal.role,
    feature: input.feature, taskId: input.taskId, promptVersion: prompt.version,
    model: '', latencyMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
    estCostUsd: 0, requestChars: input.requestChars ?? 0, responseValid: false,
  }
  const write = async (rec: AiCallRecord) => { try { await record(rec) } catch (e) { console.error('[ai/service] telemetry', e) } }

  // 1) RBAC — role enforcement.
  if (input.requiredPermission && !can(input.principal.role, input.requiredPermission)) {
    await write({ ...base, ok: false, outcome: 'forbidden', error: 'forbidden' })
    return { ok: false, error: 'forbidden', status: 403, callId, outcome: 'forbidden' }
  }

  // 2) Versioned prompt + 3) model call (fail-soft).
  const built = prompt.build(input.vars)
  const start = now()
  let gen: AiGenResult
  try {
    gen = await generate({ system: built.system, prompt: built.prompt, maxOutputTokens: input.maxOutputTokens, temperature: input.temperature })
  } catch (e) {
    gen = { ok: false, error: e instanceof Error ? e.message : 'AI request failed' }
  }
  const latencyMs = Math.max(0, now() - start)

  if (!gen.ok) {
    await write({ ...base, ok: false, outcome: 'provider_error', error: gen.error, latencyMs })
    return { ok: false, error: gen.error, status: 503, callId, outcome: 'provider_error' }
  }

  // 8) Token / latency / model / estimated-cost tracking.
  const estCostUsd = estimateCostUsd(gen.model, gen.usage.inputTokens, gen.usage.outputTokens)
  const usageBase: Omit<AiCallRecord, 'ok' | 'outcome' | 'responseValid'> = {
    ...base, model: gen.model, latencyMs,
    inputTokens: gen.usage.inputTokens, outputTokens: gen.usage.outputTokens, totalTokens: gen.usage.totalTokens,
    estCostUsd,
  }

  // 4) Structured, schema-validated response (invalid → rejected).
  if (input.schema) {
    const v = validateJson(gen.text, input.schema)
    if (!v.ok) {
      await write({ ...usageBase, ok: false, outcome: 'invalid_response', error: v.error, responseValid: false })
      return { ok: false, error: 'The AI returned an unexpected response.', status: 502, callId, outcome: 'invalid_response' }
    }
    await write({ ...usageBase, ok: true, outcome: 'success', responseValid: true })
    return { ok: true, data: v.value as T, text: gen.text, callId, usage: gen.usage, latencyMs, model: gen.model }
  }

  // No schema declared — return raw text (still fully audited).
  await write({ ...usageBase, ok: true, outcome: 'success', responseValid: true })
  return { ok: true, data: {} as T, text: gen.text, callId, usage: gen.usage, latencyMs, model: gen.model }
}
