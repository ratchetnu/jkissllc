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

export async function aiText(opts: {
  system?: string
  prompt?: string
  messages?: ModelMessage[]
  maxOutputTokens?: number
  temperature?: number
}): Promise<AiResult> {
  if (!aiConfigured()) return { ok: false, error: 'AI is not configured. Connect Vercel AI Gateway to enable this.' }
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
