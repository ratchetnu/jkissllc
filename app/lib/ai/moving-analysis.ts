// ─────────────────────────────────────────────────────────────────────────────
// Moving vision pass — the relocation counterpart to junk-analysis.ts.
//
// Same contract, different lane: only our own Blob-hosted photos reach the model,
// the call is fail-soft (never throws), and the result is OBSERVATIONS ONLY. The
// deterministic moving engine (lib/pricing/moving-quote.ts) sets the price.
//
// Deliberately NOT here: a second adversarial vision pass. The junk lane runs a
// critic before auto-quoting; a move that clears its thresholds does so on labor
// and volume, and a second full vision call would double the cost of every quote
// to re-read an inventory. When moving auto-quoting has real accuracy numbers
// behind it, that decision can be revisited with evidence.
// ─────────────────────────────────────────────────────────────────────────────

import type { ModelMessage } from 'ai'
import { runAiTask } from './service'
import { truckVars } from './truck-vars'
import { isAllowedPhotoUrl } from '../photo-url'
import { resolveAiPhotoUrls } from './photo-optimize'
import { imageOptimizationEnabled } from './image-optimize-config'
import { timeStage, markStageFailure } from '../observability/pipeline-trace'
import {
  normalizeMovingAnalysis, reviewFallbackMovingAnalysis,
  type MovingPhotoAnalysis, type NormalizeMovingCtx,
} from './analysis-schema-moving'

export type AnalyzeMovingPhotosInput = {
  analysisId: string
  bookingId: string
  photoUrls: string[]
  serviceLabel?: string
  nowIso: string
}

export type AnalyzeMovingPhotosResult = {
  analysis: MovingPhotoAnalysis
  ok: boolean
  callId?: string
  model?: string
  latencyMs?: number
  outcome: string
  /** Provider stop reason; 'length' means the cap cut the JSON off. */
  finishReason?: string
  outputTokens?: number
  maxOutputTokens?: number
  outputTruncated?: boolean
  parseSucceeded?: boolean
  itemCount?: number
}

/**
 * Measured, not guessed. The verbose contract cost ~74 output tokens per item, so a
 * three-bedroom inventory ran past 1600 mid-object and the whole read was discarded.
 * The compact contract costs ~19 per item; 2400 leaves room for roughly a hundred
 * items plus the job-level block. Raise it only against evidence of a real case
 * truncating, never pre-emptively — a bigger cap buys latency and cost, not accuracy.
 */
export const MOVING_MAX_OUTPUT_TOKENS = 2400

export async function analyzeMovingPhotos(input: AnalyzeMovingPhotosInput): Promise<AnalyzeMovingPhotosResult> {
  const prep = await timeStage('image_preprocess', async () => {
    const allowed = input.photoUrls.filter(isAllowedPhotoUrl).slice(0, 8)
    const { urls: photos } = await resolveAiPhotoUrls(allowed, { enabled: imageOptimizationEnabled() })
    if (photos.length === 0) return { photos, messages: [] as ModelMessage[] }
    const content: Array<{ type: 'text'; text: string } | { type: 'image'; image: string }> = [
      {
        type: 'text',
        text:
          `Analyze this SET of ${photos.length} photo(s) as ONE relocation job.` +
          (input.serviceLabel ? ` The customer selected: ${input.serviceLabel}.` : '') +
          ` These belongings are being moved to a new address — they are not being discarded.` +
          ` Photos are ordered; some may show the same room from different angles — do not double-count.` +
          ` Return ONLY the JSON object described in your instructions.`,
      },
      ...photos.map((url) => ({ type: 'image' as const, image: url })),
    ]
    return { photos, messages: [{ role: 'user', content }] as ModelMessage[] }
  })

  const photos = prep.photos
  const ctx: NormalizeMovingCtx = {
    analysisId: input.analysisId, bookingId: input.bookingId, photoUrls: photos,
    modelProvider: 'vercel-ai-gateway', modelName: '', analyzedAt: input.nowIso,
  }

  if (photos.length === 0) {
    return { analysis: reviewFallbackMovingAnalysis(ctx, ['No photos were provided for analysis.']), ok: false, outcome: 'no_photos' }
  }

  const res = await runAiTask({
    taskId: 'ops.movingAnalysis',
    feature: 'ops.movingAnalysis',
    vars: await truckVars(),
    messages: prep.messages,
    maxOutputTokens: MOVING_MAX_OUTPUT_TOKENS,
    temperature: 0.2,
    requestChars: photos.join(',').length,
    kind: 'primary',
    bookingId: input.bookingId,
    imageCount: photos.length,
  })

  if (!res.ok) {
    markStageFailure('provider', res.latencyMs, res.errorClass, res.retryable)
    return {
      analysis: reviewFallbackMovingAnalysis(ctx, [`Automated analysis was unavailable (${res.outcome}). A team member will review your photos.`]),
      ok: false, callId: res.callId, outcome: res.outcome, latencyMs: res.latencyMs,
    }
  }

  const modelName = res.model || ''
  const analysis = normalizeMovingAnalysis(res.text, { ...ctx, modelName, modelProvider: providerOf(modelName) })
  const itemCount = analysis.normalizedItems.length
  const parseSucceeded = itemCount > 0

  // TRUNCATION IS ITS OWN FAILURE, not an empty read. They look identical from the
  // outside — zero items either way — but they mean opposite things: an empty read
  // says the model saw nothing worth listing, truncation says it saw too much to
  // fit and we threw the answer away. Reported as the same 'empty_read' outcome,
  // the fix (a bigger cap or a smaller contract) is invisible, and the benchmark
  // records a model failure that was really a configuration one. This cost three of
  // four paid moving calls before the cap was visible in the telemetry.
  const truncated = res.outputTruncated === true
  const outcome = parseSucceeded ? 'ok' : truncated ? 'output_truncated' : 'empty_read'

  if (!parseSucceeded && truncated) {
    analysis.reviewRequired = true
    analysis.reviewReasons = Array.from(new Set([
      ...analysis.reviewReasons.filter(r => !/No movable items/i.test(r)),
      'The photo analysis was cut short before it finished — a team member will review your photos.',
    ]))
  }

  return {
    analysis,
    // A parsed-but-empty read is NOT a success: it would otherwise present as a
    // free move rather than as a failed analysis. Truncation is not a success either.
    ok: parseSucceeded,
    callId: res.callId,
    model: modelName,
    latencyMs: res.latencyMs,
    outcome,
    finishReason: res.finishReason,
    outputTokens: res.usage?.outputTokens,
    maxOutputTokens: res.maxOutputTokens ?? MOVING_MAX_OUTPUT_TOKENS,
    outputTruncated: truncated,
    parseSucceeded,
    itemCount,
  }
}

const providerOf = (model: string): string => (model.includes('/') ? model.split('/')[0] : 'vercel-ai-gateway')
