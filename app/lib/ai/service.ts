import type { ModelMessage } from 'ai'
import { can, type Permission, type Role } from '../rbac'
import { generateAI, type AiGenResult } from '../ai'
import { tenantId } from '../tenant'
import { getPrompt } from './prompts'
import { validateJson, type ObjectSchema } from './schema'
import { recordAiCall, estimateCostUsd, type AiCallRecord, type AiCallOutcome } from './telemetry'
import { modelForFeature } from './routing'
import { overBudget, addCost } from './budget'

// Centralized server-side AI service (LLMOps Phase 1-2). Every AI feature routes
// through runAiTask, the ONE place that:
//   1. enforces RBAC (when a permission is required)
//   2. enforces the daily cost cap (governance)
//   3. loads the versioned prompt from the registry
//   4. routes to the per-feature model
//   5. calls the model via the Gateway (fail-soft; supports text or multimodal messages)
//   6. validates the structured response against a schema (rejects invalid output)
//   7. records AI telemetry/audit + accrues estimated cost
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
  requestChars?: number
}

export type AiTaskDeps = {
  generate?: (o: { system?: string; prompt?: string; messages?: ModelMessage[]; maxOutputTokens?: number; temperature?: number; model?: string }) => Promise<AiGenResult>
  record?: (rec: AiCallRecord) => Promise<void>
  now?: () => number
  isOverBudget?: () => Promise<boolean>
  accrueCost?: (usd: number) => Promise<number>
}

export type AiTaskResult<T> =
  | { ok: true; data: T; text: string; callId: string; usage: { inputTokens: number; outputTokens: number; totalTokens: number }; latencyMs: number; model: string }
  | { ok: false; error: string; status: number; callId: string; outcome: AiCallOutcome }

export async function runAiTask<T = Record<string, unknown>>(input: AiTaskInput, deps: AiTaskDeps = {}): Promise<AiTaskResult<T>> {
  const generate = deps.generate ?? generateAI
  const record = deps.record ?? recordAiCall
  const now = deps.now ?? Date.now
  const isOverBudget = deps.isOverBudget ?? overBudget
  const accrueCost = deps.accrueCost ?? addCost
  const tid = tenantId()
  const callId = crypto.randomUUID()
  const prompt = getPrompt(input.taskId)

  const base: Omit<AiCallRecord, 'ok' | 'outcome'> = {
    id: callId, at: now(), tenantId: tid,
    actor: input.principal?.sub ?? 'public', role: input.principal?.role ?? 'public',
    feature: input.feature, taskId: input.taskId, promptVersion: prompt.version,
    model: '', latencyMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
    estCostUsd: 0, requestChars: input.requestChars ?? 0, responseValid: false,
  }
  const write = async (rec: AiCallRecord) => { try { await record(rec) } catch (e) { console.error('[ai/service] telemetry', e) } }

  // 1) RBAC — role enforcement (only when a permission is required).
  if (input.requiredPermission && (!input.principal || !can(input.principal.role, input.requiredPermission))) {
    await write({ ...base, ok: false, outcome: 'forbidden', error: 'forbidden' })
    return { ok: false, error: 'forbidden', status: 403, callId, outcome: 'forbidden' }
  }

  // 2) Cost governance — refuse fail-soft when today's cap is reached.
  try {
    if (await isOverBudget()) {
      await write({ ...base, ok: false, outcome: 'budget_exceeded', error: 'daily AI budget reached' })
      return { ok: false, error: 'The daily AI budget has been reached — please try again tomorrow.', status: 429, callId, outcome: 'budget_exceeded' }
    }
  } catch { /* budget check is best-effort — never block on it */ }

  // 3) Versioned prompt + 4) per-feature model + 5) model call (fail-soft).
  const built = prompt.build(input.vars)
  const model = modelForFeature(input.feature)
  const start = now()
  let gen: AiGenResult
  try {
    gen = await generate({ system: built.system, prompt: input.messages ? undefined : built.prompt, messages: input.messages, model, maxOutputTokens: input.maxOutputTokens, temperature: input.temperature })
  } catch (e) {
    gen = { ok: false, error: e instanceof Error ? e.message : 'AI request failed' }
  }
  const latencyMs = Math.max(0, now() - start)

  if (!gen.ok) {
    await write({ ...base, ok: false, outcome: 'provider_error', error: gen.error, latencyMs, model })
    return { ok: false, error: gen.error, status: 503, callId, outcome: 'provider_error' }
  }

  // 7) Token / latency / model / estimated-cost tracking (+ accrue toward the cap).
  const estCostUsd = estimateCostUsd(gen.model, gen.usage.inputTokens, gen.usage.outputTokens)
  await accrueCost(estCostUsd).catch(() => {})
  const usageBase: Omit<AiCallRecord, 'ok' | 'outcome' | 'responseValid'> = {
    ...base, model: gen.model, latencyMs,
    inputTokens: gen.usage.inputTokens, outputTokens: gen.usage.outputTokens, totalTokens: gen.usage.totalTokens,
    estCostUsd,
  }

  // 6) Structured, schema-validated response (invalid → rejected).
  if (input.schema) {
    const v = validateJson(gen.text, input.schema)
    if (!v.ok) {
      await write({ ...usageBase, ok: false, outcome: 'invalid_response', error: v.error, responseValid: false })
      return { ok: false, error: 'The AI returned an unexpected response.', status: 502, callId, outcome: 'invalid_response' }
    }
    await write({ ...usageBase, ok: true, outcome: 'success', responseValid: true })
    return { ok: true, data: v.value as T, text: gen.text, callId, usage: gen.usage, latencyMs, model: gen.model }
  }

  await write({ ...usageBase, ok: true, outcome: 'success', responseValid: true })
  return { ok: true, data: {} as T, text: gen.text, callId, usage: gen.usage, latencyMs, model: gen.model }
}
