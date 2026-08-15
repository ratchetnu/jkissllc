import { generateText, type ModelMessage, type LanguageModel } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { resolveAiProvider, credentialKeysFor, type AiProvider } from './ai/provider-config'

// Single entry point for all AI features. Everything fails soft so a missing key /
// no credits never breaks a page — the caller just shows a friendly "AI unavailable"
// message.
//
// TWO TRANSPORTS, ONE MODEL IDENTITY. A model is named everywhere in this codebase by
// its canonical "provider/model" string — routing.ts resolves one, cost-tables.ts is
// keyed on one, and telemetry records one. That string is the model's IDENTITY and it
// does NOT change with the transport. Only `resolveModel()` below knows the difference,
// and it converts the identity into whatever the active transport wants at the last
// possible moment.
//
// Keeping identity and transport separate is what makes the switch measurable: the same
// feature bills against the same cost-table row and writes the same `model` field to
// telemetry whether it went through the Gateway or straight to Anthropic, so a
// before/after comparison is about latency and cost — not about renamed dimensions.

const MODEL = process.env.AI_MODEL || 'anthropic/claude-sonnet-4-6'

export type { AiProvider }

/**
 * Which transport carries model calls. Defaults to 'gateway' — the historical
 * behavior — so this module is inert until AI_PROVIDER is deliberately set.
 *
 * The rule itself lives in ./ai/provider-config so `health.ts` can share it without
 * importing this module (and with it the whole AI SDK). Two copies of this decision is
 * precisely how the health check ended up reporting on the wrong transport.
 */
export function aiProvider(): AiProvider {
  return resolveAiProvider(process.env)
}

/**
 * Convert a canonical "provider/model" identity into a model the active transport can
 * call.
 *
 * Gateway: the AI SDK takes the string as-is and routes on the prefix.
 * Anthropic: the prefix is the Gateway's routing syntax, not part of the model id, so
 *   it is stripped — `anthropic/claude-sonnet-4-6` → `claude-sonnet-4-6`.
 *
 * A non-Anthropic model under AI_PROVIDER=anthropic THROWS rather than substituting a
 * default. Silently serving a different model than the one routing.ts selected would
 * corrupt every downstream number — cost is priced against the requested identity and
 * quality scores are attributed to it — and it would do so invisibly, since the call
 * would still succeed. A loud config failure is recoverable; a quiet wrong model is not.
 */
export function resolveModel(id: string, provider: AiProvider = aiProvider()): LanguageModel {
  if (provider === 'gateway') return id
  const slash = id.indexOf('/')
  if (slash === -1) return anthropic(id)          // already a bare Anthropic model id
  const prefix = id.slice(0, slash)
  if (prefix !== 'anthropic') {
    throw new Error(
      `AI config error: AI_PROVIDER=anthropic cannot serve "${id}". ` +
      `Route this feature to an anthropic/* model or set AI_PROVIDER=gateway.`,
    )
  }
  return anthropic(id.slice(slash + 1))
}

/**
 * Whether a credential for the ACTIVE transport is present.
 *
 * Note this has always been — and remains — a presence check, not a proof of working
 * credit. On the Gateway path it is especially weak: VERCEL_OIDC_TOKEN is set on every
 * Vercel runtime, so this returns true even with a zero Gateway balance, and every call
 * then fails at request time while health reports green. The Anthropic path at least
 * requires a real key to be configured. Use /api/diagnostics/ai-provider to learn
 * whether calls actually succeed.
 */
export function aiConfigured(): boolean {
  return credentialKeysFor(aiProvider()).some(k => !!process.env[k])
}

// Bounded external-model call timeout. A client-side abort after this many ms keeps a
// single AI call from consuming the whole 60s function budget — it MUST stay < that
// cap. Read from AI_CALL_TIMEOUT_MS; safe 30s default. A timeout is TRANSIENT
// (retryable); a credit/auth/validation error is not.
export function aiCallTimeoutMs(): number {
  const raw = Number(process.env.AI_CALL_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000
}

export type AiErrorKind = 'timeout' | 'validation' | 'provider' | 'config' | 'unknown'

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
  // Must precede the generic branches: a transport/model misconfiguration matches none
  // of their patterns, so without this it would fall through to 'unknown' and be
  // RETRIED — burning the whole attempt budget re-issuing a call that cannot succeed
  // until a human edits an env var.
  if (/^AI config error:/.test(msg)) return { kind: 'config', retryable: false }
  if (/schema|invalid|parse|validation|unsupported/i.test(msg)) return { kind: 'validation', retryable: false }
  if (/credit|quota|billing|payment|insufficient|unauthor|forbidden|api key|token/i.test(msg)) return { kind: 'provider', retryable: false }
  return { kind: 'unknown', retryable: true } // default: treat unknown as transient
}

export type AiResult = { ok: true; text: string } | { ok: false; error: string; retryable?: boolean; errorKind?: AiErrorKind }

/**
 * CUSTOMER-FACING text. `POST /api/ai/photo-estimate` returns this verbatim in its 503
 * body, so whatever is written here is read by the public.
 *
 * It previously named our infrastructure: a depleted balance rendered as "AI Gateway
 * needs credits enabled on your Vercel account to use this", and an auth failure as
 * "Enable Vercel AI Gateway for this project" — shipped to a customer who uploaded a
 * photo. That disclosed the vendor, the account model, and the fact that we were the
 * ones who were broken. None of it is actionable by the reader.
 *
 * Billing and auth are now one customer-visible state ("temporarily unavailable"),
 * because to a customer they ARE one state. Operators lose nothing: the raw error still
 * reaches the log with a provider-aware hint (see operatorHint), and telemetry keeps the
 * machine-readable `errorKind`/`errorClass` that the retry policy and dashboards use.
 */
export function friendlyError(e: unknown): string {
  const msg = errMsg(e)
  const name = errName(e)
  if (name === 'TimeoutError' || name === 'AbortError' || /\btimed?\s?out\b/i.test(msg)) return 'The AI request timed out — please try again in a moment.'
  if (/^AI config error:/.test(msg)) return 'AI is temporarily unavailable. Please try again shortly.'
  if (/credit|quota|billing|payment|insufficient|unauthor|forbidden|api key|token/i.test(msg)) return 'AI is temporarily unavailable. Please try again shortly.'
  return 'The AI request failed — please try again in a moment.'
}

/**
 * OPERATOR-facing remediation hint, logged next to the raw error — never returned to a
 * caller. Names the transport that actually failed, so "top up the wrong vendor" is not
 * a possible response to an outage.
 */
export function operatorHint(e: unknown): string {
  const msg = errMsg(e)
  if (/^AI config error:/.test(msg)) return 'fix AI_PROVIDER / per-feature model routing'
  const billing = /credit|quota|billing|payment|insufficient/i.test(msg)
  const auth = /unauthor|forbidden|api key|token/i.test(msg)
  if (!billing && !auth) return ''
  if (aiProvider() === 'anthropic') {
    return billing
      ? 'Anthropic organization credits are exhausted — top up or enable auto-reload'
      : 'ANTHROPIC_API_KEY is missing, revoked, or lacks access to the routed model'
  }
  return billing
    ? 'Vercel AI Gateway credits are exhausted — add credits on the Vercel account'
    : 'AI Gateway is not authenticated (AI_GATEWAY_API_KEY / OIDC)'
}

export function aiModel(): string { return MODEL }

export type AiUsage = { inputTokens: number; outputTokens: number; totalTokens: number }
export type AiGenResult =
  | { ok: true; text: string; usage: AiUsage; model: string; providerCostUsd?: number; finishReason?: string }
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
  timeoutMs?: number      // per-call abort timeout override; defaults to aiCallTimeoutMs(). Callers on a
                          // longer function budget (e.g. the vision-shadow cron, maxDuration 300s) pass a
                          // higher value for slow heavy-detail vision calls.
}): Promise<AiGenResult> {
  const model = opts.model || MODEL
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : aiCallTimeoutMs()
  try {
    const res = await generateText({
      // `model` (the canonical "provider/model" string) stays the identity recorded in
      // the result and in telemetry; only the transport-specific handle is resolved here.
      model: resolveModel(model),
      system: opts.system,
      ...(opts.messages ? { messages: opts.messages } : { prompt: opts.prompt ?? '' }),
      maxOutputTokens: opts.maxOutputTokens ?? 700,
      temperature: opts.temperature ?? 0.5,
      abortSignal: AbortSignal.timeout(timeoutMs),
    })
    // Usage field naming varies across AI SDK versions — read defensively.
    const u = (res.usage ?? {}) as unknown as Record<string, number | undefined>
    const inputTokens = u.inputTokens ?? u.promptTokens ?? 0
    const outputTokens = u.outputTokens ?? u.completionTokens ?? 0
    const totalTokens = u.totalTokens ?? inputTokens + outputTokens
    const providerCostUsd = readProviderCost((res as { providerMetadata?: unknown }).providerMetadata)
    // finishReason distinguishes a model that CHOSE to stop from one the token cap
    // cut off mid-JSON. Without it, a truncated structured response is
    // indistinguishable from a model that simply saw nothing.
    const finishReason = typeof (res as { finishReason?: unknown }).finishReason === 'string'
      ? (res as { finishReason: string }).finishReason : undefined
    return { ok: true, text: res.text.trim(), usage: { inputTokens, outputTokens, totalTokens }, model, providerCostUsd, finishReason }
  } catch (e) {
    // A bounded-timeout abort is recorded as a TRANSIENT failure so the caller's retry
    // policy re-attempts it; credit/auth/validation errors stay non-retryable.
    const cls = classifyAiError(e)
    const hint = operatorHint(e)
    console.error('[ai]', aiProvider(), cls.kind, e, ...(hint ? ['—', hint] : []))
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
      model: resolveModel(MODEL),
      system: opts.system,
      ...(opts.messages ? { messages: opts.messages } : { prompt: opts.prompt ?? '' }),
      maxOutputTokens: opts.maxOutputTokens ?? 700,
      temperature: opts.temperature ?? 0.5,
      abortSignal: AbortSignal.timeout(aiCallTimeoutMs()),
    })
    return { ok: true, text: text.trim() }
  } catch (e) {
    const cls = classifyAiError(e)
    const hint = operatorHint(e)
    console.error('[ai]', aiProvider(), cls.kind, e, ...(hint ? ['—', hint] : []))
    return { ok: false, error: friendlyError(e), retryable: cls.retryable, errorKind: cls.kind }
  }
}
