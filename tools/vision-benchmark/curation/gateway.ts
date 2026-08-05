// ─────────────────────────────────────────────────────────────────────────────
// The one place curation actually talks to a model.
//
// Everything else in curation/ is pure and injectable; this file is the seam.
// It is deliberately thin — build a multimodal message, call the shared Gateway
// helper, convert failure into the runtime's typed failure kinds, and price the
// call from the repo's existing cost table so a curation run bills on the same
// sheet as everything else.
//
// It refuses to run against the production estimator's model. That check exists
// twice on purpose: once at role-assignment time and once here, at the last
// point before a request leaves the process.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs'
import { extname } from 'node:path'

import { generateAI } from '../../../app/lib/ai'
import { estimateCostUsd } from '../../../app/lib/ai/cost-tables'
import { PRODUCTION_ESTIMATOR } from './roles'
import { CallFailure, classifyFailure, type VisionCaller } from './runtime'

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif',
}

/** Inline the image as a data URL — no upload, no signed URL, nothing to leak. */
function imagePart(imagePath: string): { type: 'image'; image: string } {
  const mime = MIME[extname(imagePath).toLowerCase()] ?? 'image/jpeg'
  const b64 = readFileSync(imagePath).toString('base64')
  return { type: 'image', image: `data:${mime};base64,${b64}` }
}

export type GatewayOptions = { maxOutputTokens?: number; timeoutMs?: number }

/**
 * The real transport. Structured JSON only; temperature 0 because a curation
 * label is a measurement, not a draft.
 */
export function gatewayCaller(opts: GatewayOptions = {}): VisionCaller {
  return async (req) => {
    if (req.model === PRODUCTION_ESTIMATOR) {
      throw new CallFailure('auth', `refusing to call the production estimator (${req.model}) from a curation role`)
    }
    const started = Date.now()
    const res = await generateAI({
      model: req.model,
      system: req.system,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: req.user },
          req.imageDataUrl ? { type: 'image', image: req.imageDataUrl } : imagePart(req.imagePath),
        ],
      }] as never,
      // Gemini 2.5 Flash spends output budget on internal reasoning before it emits
      // any visible text, so a 900-token ceiling truncated the verifier mid-JSON.
      // The contract is small; the headroom costs nothing when it is unused.
      maxOutputTokens: opts.maxOutputTokens ?? 3000,
      temperature: 0,
      timeoutMs: opts.timeoutMs ?? 60_000,
    })
    const latencyMs = Date.now() - started
    if (!res.ok) {
      // AiErrorKind is coarse ('timeout' | 'validation' | 'provider' | 'unknown'),
      // so the precise kind comes from the message. The helper's `retryable` is
      // still honoured: a non-retryable provider error must not be retried just
      // because the text happens to look transient.
      const fromMessage = classifyFailure(res.error ?? '')
      const kind = res.errorKind === 'timeout' ? 'timeout'
        : fromMessage !== 'unknown' ? fromMessage
        : res.retryable ? 'server_error'
        : 'unknown'
      throw new CallFailure(kind as never, res.error ?? 'gateway call failed')
    }
    const usd = res.providerCostUsd ?? estimateCostUsd(req.model, res.usage.inputTokens, res.usage.outputTokens)
    return {
      text: res.text,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      latencyMs,
      usd: usd ?? 0,
    }
  }
}
