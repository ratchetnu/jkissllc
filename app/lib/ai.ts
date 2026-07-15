import { generateText, type ModelMessage } from 'ai'

// Single entry point for all AI features. Uses the Vercel AI Gateway via a plain
// "provider/model" string (auto-authenticated by VERCEL_OIDC_TOKEN in prod, or an
// AI_GATEWAY_API_KEY). Everything fails soft so a missing key / no credits never
// breaks a page — the caller just shows a friendly "AI unavailable" message.

const MODEL = process.env.AI_MODEL || 'anthropic/claude-sonnet-4-6'

export function aiConfigured(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN)
}

// Bounded external-model call timeout. A client-side abort after this many ms keeps a
// single AI call from consuming the whole 60s function budget — it MUST stay < that
// cap. Read from AI_CALL_TIMEOUT_MS; safe 30s default. A timeout is TRANSIENT
// (retryable); a credit/auth/validation error is not.
export function aiCallTimeoutMs(): number {
  const raw = Number(process.env.AI_CALL_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000
}

export type AiErrorKind = 'timeout' | 'validation' | 'provider' | 'unknown'

function errName(e: unknown): string {
  return typeof e === 'object' && e !== null && typeof (e as { name?: unknown }).name === 'string'
    ? (e as { name: string }).name : ''
}
function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  return typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string'
    ? (e as { message: string }).message : String(e)
}

/**
 * Classify a thrown model error for the retry policy. A client-side timeout/abort is
 * TRANSIENT (a retry may succeed); a credit/auth/validation error is PERMANENT (a
 * retry repeats the same failure). Pure + exported for direct unit testing.
 * AbortSignal.timeout(...) rejects with a DOMException named 'TimeoutError'.
 */
export function classifyAiError(e: unknown): { kind: AiErrorKind; retryable: boolean } {
  const name = errName(e)
  const msg = errMsg(e)
  if (name === 'TimeoutError' || name === 'AbortError' || /\btimed?\s?out\b|\babort/i.test(msg)) {
    return { kind: 'timeout', retryable: true }
  }
  if (/schema|invalid|parse|validation|unsupported/i.test(msg)) return { kind: 'validation', retryable: false }
  if (/credit|quota|billing|payment|insufficient|unauthor|forbidden|api key|token/i.test(msg)) return { kind: 'provider', retryable: false }
  return { kind: 'unknown', retryable: true } // default: treat unknown as transient
}

export type AiResult = { ok: true; text: string } | { ok: false; error: string; retryable?: boolean; errorKind?: AiErrorKind }

function friendlyError(e: unknown): string {
  const msg = errMsg(e)
  const name = errName(e)
  if (name === 'TimeoutError' || name === 'AbortError' || /\btimed?\s?out\b/i.test(msg)) return 'The AI request timed out — please try again in a moment.'
  if (/credit|quota|billing|payment|insufficient/i.test(msg)) return 'AI Gateway needs credits enabled on your Vercel account to use this.'
  if (/unauthor|forbidden|api key|token/i.test(msg)) return 'AI is not connected. Enable Vercel AI Gateway for this project.'
  return 'The AI request failed — please try again in a moment.'
}

export function aiModel(): string { return MODEL }

export type AiUsage = { inputTokens: number; outputTokens: number; totalTokens: number }
export type AiGenResult =
  | { ok: true; text: string; usage: AiUsage; model: string; providerCostUsd?: number }
  | { ok: false; error: string; retryable?: boolean; errorKind?: AiErrorKind }

// Best-effort extraction of a provider-reported cost from the AI SDK result's
// providerMetadata. The Vercel AI Gateway may surface real cost under a few shapes;
// we probe defensively and only accept a finite positive number. When present, the
// service records it as the ACTUAL cost (costSource='actual') instead of the estimate.
function readProviderCost(meta: unknown): number | undefined {
  if (!meta || typeof meta !== 'object') return undefined
  const paths: Array<(m: Record<string, unknown>) => unknown> = [
    m => (m.gateway as Record<string, unknown> | undefined)?.cost,
    m => (m.gateway as Record<string, unknown> | undefined)?.costUsd,
    m => (m.openai as Record<string, unknown> | undefined)?.cost,
    m => (m.anthropic as Record<string, unknown> | undefined)?.cost,
    m => m.cost,
  ]
  for (const get of paths) {
    const v = get(meta as Record<string, unknown>)
    const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN
    if (Number.isFinite(n) && n >= 0) return n
  }
  return undefined
}

// Lower-level generate that also returns token usage + the model — the telemetry the
// centralized AI service records. Fail-soft, same as aiText. aiText is left untouched
// for the features not yet migrated to the AI service.
export async function generateAI(opts: {
  system?: string
  prompt?: string
  messages?: ModelMessage[]
  maxOutputTokens?: number
  temperature?: number
  model?: string          // per-feature routing override (Phase 2); defaults to MODEL
}): Promise<AiGenResult> {
  const model = opts.model || MODEL
  try {
    const res = await generateText({
      model,
      system: opts.system,
      ...(opts.messages ? { messages: opts.messages } : { prompt: opts.prompt ?? '' }),
      maxOutputTokens: opts.maxOutputTokens ?? 700,
      temperature: opts.temperature ?? 0.5,
      abortSignal: AbortSignal.timeout(aiCallTimeoutMs()),
    })
    // Usage field naming varies across AI SDK versions — read defensively.
    const u = (res.usage ?? {}) as unknown as Record<string, number | undefined>
    const inputTokens = u.inputTokens ?? u.promptTokens ?? 0
    const outputTokens = u.outputTokens ?? u.completionTokens ?? 0
    const totalTokens = u.totalTokens ?? inputTokens + outputTokens
    const providerCostUsd = readProviderCost((res as { providerMetadata?: unknown }).providerMetadata)
    return { ok: true, text: res.text.trim(), usage: { inputTokens, outputTokens, totalTokens }, model, providerCostUsd }
  } catch (e) {
    // A bounded-timeout abort is recorded as a TRANSIENT failure so the caller's retry
    // policy re-attempts it; credit/auth/validation errors stay non-retryable.
    const cls = classifyAiError(e)
    console.error('[ai]', cls.kind, e)
    return { ok: false, error: friendlyError(e), retryable: cls.retryable, errorKind: cls.kind }
  }
}

export async function aiText(opts: {
  system?: string
  prompt?: string
  messages?: ModelMessage[]
  maxOutputTokens?: number
  temperature?: number
}): Promise<AiResult> {
  // Always attempt the call — the AI Gateway auto-authenticates via the runtime
  // OIDC token when connected. If it isn't, the catch returns a friendly message,
  // so features light up automatically once the Gateway is enabled (no redeploy).
  try {
    const { text } = await generateText({
      model: MODEL,
      system: opts.system,
      ...(opts.messages ? { messages: opts.messages } : { prompt: opts.prompt ?? '' }),
      maxOutputTokens: opts.maxOutputTokens ?? 700,
      temperature: opts.temperature ?? 0.5,
      abortSignal: AbortSignal.timeout(aiCallTimeoutMs()),
    })
    return { ok: true, text: text.trim() }
  } catch (e) {
    const cls = classifyAiError(e)
    console.error('[ai]', cls.kind, e)
    return { ok: false, error: friendlyError(e), retryable: cls.retryable, errorKind: cls.kind }
  }
}
