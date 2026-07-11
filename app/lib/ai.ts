import { generateText, type ModelMessage } from 'ai'

// Single entry point for all AI features. Uses the Vercel AI Gateway via a plain
// "provider/model" string (auto-authenticated by VERCEL_OIDC_TOKEN in prod, or an
// AI_GATEWAY_API_KEY). Everything fails soft so a missing key / no credits never
// breaks a page — the caller just shows a friendly "AI unavailable" message.

const MODEL = process.env.AI_MODEL || 'anthropic/claude-sonnet-4-6'

export function aiConfigured(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN)
}

export type AiResult = { ok: true; text: string } | { ok: false; error: string }

function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/credit|quota|billing|payment|insufficient/i.test(msg)) return 'AI Gateway needs credits enabled on your Vercel account to use this.'
  if (/unauthor|forbidden|api key|token/i.test(msg)) return 'AI is not connected. Enable Vercel AI Gateway for this project.'
  return 'The AI request failed — please try again in a moment.'
}

export function aiModel(): string { return MODEL }

export type AiUsage = { inputTokens: number; outputTokens: number; totalTokens: number }
export type AiGenResult =
  | { ok: true; text: string; usage: AiUsage; model: string }
  | { ok: false; error: string }

// Lower-level generate that also returns token usage + the model — the telemetry the
// centralized AI service records. Fail-soft, same as aiText. aiText is left untouched
// for the features not yet migrated to the AI service.
export async function generateAI(opts: {
  system?: string
  prompt?: string
  messages?: ModelMessage[]
  maxOutputTokens?: number
  temperature?: number
}): Promise<AiGenResult> {
  try {
    const res = await generateText({
      model: MODEL,
      system: opts.system,
      ...(opts.messages ? { messages: opts.messages } : { prompt: opts.prompt ?? '' }),
      maxOutputTokens: opts.maxOutputTokens ?? 700,
      temperature: opts.temperature ?? 0.5,
    })
    // Usage field naming varies across AI SDK versions — read defensively.
    const u = (res.usage ?? {}) as unknown as Record<string, number | undefined>
    const inputTokens = u.inputTokens ?? u.promptTokens ?? 0
    const outputTokens = u.outputTokens ?? u.completionTokens ?? 0
    const totalTokens = u.totalTokens ?? inputTokens + outputTokens
    return { ok: true, text: res.text.trim(), usage: { inputTokens, outputTokens, totalTokens }, model: MODEL }
  } catch (e) {
    console.error('[ai]', e)
    return { ok: false, error: friendlyError(e) }
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
    })
    return { ok: true, text: text.trim() }
  } catch (e) {
    console.error('[ai]', e)
    return { ok: false, error: friendlyError(e) }
  }
}
