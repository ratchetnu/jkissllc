// ─────────────────────────────────────────────────────────────────────────────
// Junk-photo vision analysis — the provider-abstracted AI layer (Phase 2/4).
//
// Runs entirely server-side through the existing LLMOps chokepoint (runAiTask →
// Vercel AI Gateway): RBAC-free (public feature), cost-governed, retried on
// transient failure, model/latency/cost recorded to the AI audit log under the
// feature `ops.junkAnalysis` (so it auto-appears in the AI analytics dashboards).
//
// The model returns OBSERVATIONS ONLY as JSON. We validate/normalize it with the
// dependency-free normalizer (analysis-schema.ts) — never trusting raw output —
// and NEVER let it set a price. On any failure we return a review-required
// analysis so the booking is preserved and a human prices it.
// ─────────────────────────────────────────────────────────────────────────────

import type { ModelMessage } from 'ai'
import { runAiTask } from './service'
import { updateAiCall } from './telemetry'
import { timeStage, markStage, markStageFailure } from '../observability/pipeline-trace'
import { isAllowedPhotoUrl } from '../photo-url'
import { resolveAiPhotoUrls } from './photo-optimize'
import { imageOptimizationEnabled } from './image-optimize-config'
import {
  normalizeAnalysis, reviewFallbackAnalysis,
  type JunkPhotoAnalysis, type NormalizeCtx,
} from './analysis-schema'

export type AnalyzeJunkPhotosInput = {
  analysisId: string
  bookingId: string
  photoUrls: string[]        // Vercel Blob public URLs (server-fetched by the model)
  serviceLabel?: string
  nowIso: string             // caller supplies the timestamp
}

export type AnalyzeJunkPhotosResult = {
  analysis: JunkPhotoAnalysis
  ok: boolean                // true only if the AI produced a usable read
  callId?: string
  model?: string
  latencyMs?: number
  outcome: string            // telemetry outcome or a local reason
}

const providerOf = (model: string): string => (model.includes('/') ? model.split('/')[0] : 'vercel-ai-gateway')

export interface VisionAnalysisProvider {
  analyzeJunkPhotos(input: AnalyzeJunkPhotosInput): Promise<AnalyzeJunkPhotosResult>
}

export async function analyzeJunkPhotos(input: AnalyzeJunkPhotosInput): Promise<AnalyzeJunkPhotosResult> {
  // ── Image preprocessing stage (observability): URL allow-list filtering + the
  // multimodal message assembly the provider consumes. Timed onto the active pipeline
  // trace (no-op when none). Defense-in-depth: only ever hand our own Blob-hosted
  // images to the provider.
  const prep = await timeStage('image_preprocess', async () => {
    const allowed = input.photoUrls.filter(isAllowedPhotoUrl).slice(0, 8)
    // When image optimization is on, swap each original for its stored optimized
    // derivative (smaller = fewer image tokens + faster fetch). Off or missing → the
    // original URL is used, so this is byte-identical to today when the flag is off.
    const { urls: photos } = await resolveAiPhotoUrls(allowed, { enabled: imageOptimizationEnabled() })
    if (photos.length === 0) return { photos, messages: [] as ModelMessage[] }
    const content: Array<{ type: 'text'; text: string } | { type: 'image'; image: string }> = [
      {
        type: 'text',
        text:
          `Analyze this SET of ${photos.length} photo(s) as ONE job for a junk-removal estimate.` +
          (input.serviceLabel ? ` The customer selected: ${input.serviceLabel}.` : '') +
          ` Photos are ordered; some may show the same pile from different angles — do not double-count. Return ONLY the JSON object described in your instructions.`,
      },
      ...photos.map((url) => ({ type: 'image' as const, image: url })),
    ]
    return { photos, messages: [{ role: 'user', content }] as ModelMessage[] }
  })
  const photos = prep.photos
  const ctx: NormalizeCtx = {
    analysisId: input.analysisId, bookingId: input.bookingId, photoUrls: photos,
    modelProvider: 'vercel-ai-gateway', modelName: '', analyzedAt: input.nowIso,
  }

  if (photos.length === 0) {
    return { analysis: reviewFallbackAnalysis(ctx, ['No photos were provided for analysis.']), ok: false, outcome: 'no_photos' }
  }

  const messages = prep.messages

  const res = await runAiTask({
    taskId: 'ops.junkAnalysis',
    feature: 'ops.junkAnalysis',
    vars: {},
    messages,
    maxOutputTokens: 1600,
    temperature: 0.2,
    requestChars: photos.join(',').length,
    // Telemetry attribution: the authoritative (primary) V1 Book Now vision pass.
    kind: 'primary',
    bookingId: input.bookingId,
    imageCount: photos.length,
  })

  if (!res.ok) {
    // Observability: emit the provider (AI Gateway) sub-stage as FAILED on the fast-
    // fail path — the round-trip couldn't execute — so the trace stays structurally
    // complete (duration + failure reason + retryable). Recording only; the caller's
    // retry/review flow below is unchanged.
    markStageFailure('provider', res.latencyMs, res.errorClass, res.retryable)
    // Provider error / budget / invalid — preserve the booking as review-required.
    return {
      analysis: reviewFallbackAnalysis(ctx, [`Automated analysis was unavailable (${res.outcome}). A team member will review your photos.`]),
      ok: false, callId: res.callId, outcome: res.outcome,
    }
  }

  // Observability: the provider (AI Gateway) round-trip latency on success — the model
  // call only, separate from our surrounding preprocessing/normalization work.
  markStage('provider', res.latencyMs)

  // runAiTask ran without the flat schema (the shape is nested), so parse here and
  // hand the raw object to the robust normalizer.
  let raw: unknown
  try { const m = res.text.match(/\{[\s\S]*\}/); if (m) raw = JSON.parse(m[0]) } catch { raw = undefined }

  const analysis = normalizeAnalysis(raw, { ...ctx, modelName: res.model, modelProvider: providerOf(res.model) })
  const usable = analysis.normalizedItems.length > 0
  // Attach the model's confidence to the telemetry record post-hoc (it's only known
  // after normalization). Fire-and-forget + fail-soft — never delays the estimate.
  void updateAiCall(res.callId, { confidenceScore: analysis.confidence?.overall })
  return {
    analysis,
    ok: usable,
    callId: res.callId,
    model: res.model,
    latencyMs: res.latencyMs,
    outcome: usable ? 'success' : 'no_items',
  }
}
