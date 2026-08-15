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
import { truckVars } from './truck-vars'
import { updateAiCall } from './telemetry'
import { isEnabled } from '../platform/flags'
import { timeStage, markStage, markStageFailure } from '../observability/pipeline-trace'
import { isAllowedPhotoUrl } from '../photo-url'
import { resolveAiPhotoUrls } from './photo-optimize'
import { imageOptimizationEnabled } from './image-optimize-config'
import { reconcilePhotoSet } from './photo-reconciliation'
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
  // Latency policy (ai/interactive-policy). Omitted ⇒ today's defaults: the platform
  // 30s per-call timeout and the AI service's transient retry — the right policy for
  // the durable worker. The interactive route passes an explicit single-shot slice so
  // the customer's request can never outlive its function ceiling.
  timeoutMs?: number
  attempts?: number
}

export type AnalyzeJunkPhotosResult = {
  analysis: JunkPhotoAnalysis
  ok: boolean                // true only if the AI produced a usable read
  callId?: string
  model?: string
  latencyMs?: number
  outcome: string            // telemetry outcome or a local reason
  // Coarse failure class from the AI service ('network' for a timeout/abort, 'billing',
  // 'auth', …). Surfaced so the interactive path can tell "we ran out of budget" apart
  // from "the provider rejected us" and report the right outcome to the customer.
  errorClass?: string
}

const providerOf = (model: string): string => (model.includes('/') ? model.split('/')[0] : 'vercel-ai-gateway')

/**
 * Output-token budget for the analysis, scaled by how many photos are in the set.
 *
 * This was a flat 1600 for every job. The response contract is large and mostly
 * PER-ITEM — each `normalizedItems` entry carries eleven fields including a nested
 * weight range, a sourcePhotoIds array and an evidence string — and there is one
 * `photoObservations` entry per photo on top. A six-photo cleanout therefore needs
 * several times the output of a one-photo pickup, and on JK-B-1022 it hit the cap
 * exactly (output = 1600, arithmetic confirmed against the recorded cost), truncating
 * the JSON mid-object and discarding the entire read.
 *
 * A flat cap has to be sized for the WORST case or it silently fails on large jobs; but
 * sizing a flat cap for the worst case pays for headroom on every small one. Scaling
 * removes the tradeoff. The ceiling stays well under the model's limit so a runaway
 * response is still bounded — this raises a budget, it does not remove one.
 */
export function analysisOutputTokenBudget(photoCount: number): number {
  const n = Math.max(1, Math.min(8, Math.floor(photoCount) || 1))
  return Math.min(8000, 2000 + n * 600)
}

export type AnalysisRead = {
  raw?: unknown
  /** The model stopped because it hit the token cap — the JSON is cut off. */
  truncated: boolean
  /** No JSON object could be recovered from the response text. */
  parseFailed: boolean
}

/**
 * Turn a model response into either a parsed object or a NAMED failure.
 *
 * Exported and pure so the failure branches can be driven directly. Reaching them
 * through `analyzeJunkPhotos` needs a live model call, which is exactly the shape of
 * gap that let the silent-parse-failure bug live in production: the route-level path
 * short-circuits long before here, so these branches went untested while coverage
 * looked fine.
 *
 * Truncation is checked FIRST and independently of parsing, because a truncated
 * response can still parse by luck — the regex ends at the last `}` it finds, which may
 * close a nested object and yield syntactically valid but semantically amputated JSON.
 * Trusting that would silently price a job off a partial inventory, which is worse than
 * failing: it produces a confident wrong number instead of a review.
 */
export function readAnalysisResponse(
  text: string,
  meta: { finishReason?: string; outputTruncated?: boolean } = {},
): AnalysisRead {
  const truncated = meta.outputTruncated === true || meta.finishReason === 'length'
  try {
    const m = String(text ?? '').match(/\{[\s\S]*\}/)
    if (!m) return { truncated, parseFailed: true }
    return { raw: JSON.parse(m[0]), truncated, parseFailed: false }
  } catch {
    return { truncated, parseFailed: true }
  }
}

/** Which primary-analysis prompt spec runs. Flag OFF ⇒ the shipped v1 spec. */
export function analysisTaskId(env: Record<string, string | undefined> = process.env): string {
  return isEnabled('AI_COMPACT_ANALYSIS_PROMPT', env) ? 'ops.junkAnalysisCompact' : 'ops.junkAnalysis'
}

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
    const reconciled = await reconcilePhotoSet(allowed)
    // When image optimization is on, swap each original for its stored optimized
    // derivative (smaller = fewer image tokens + faster fetch). Off or missing → the
    // original URL is used, so this is byte-identical to today when the flag is off.
    const { urls: photos } = await resolveAiPhotoUrls(reconciled.active.map(p => p.url), { enabled: imageOptimizationEnabled() })
    if (photos.length === 0) return { photos, messages: [] as ModelMessage[] }
    const content: Array<{ type: 'text'; text: string } | { type: 'image'; image: string }> = [
      {
        type: 'text',
        text:
          `Analyze this SET of ${photos.length} photo(s) as ONE job for a junk-removal estimate.` +
          (input.serviceLabel ? ` The customer selected: ${input.serviceLabel}.` : '') +
          ` Photos are ordered; some may show the same pile from different angles — do not double-count. Return ONLY the JSON object described in your instructions.`,
      },
      ...photos.flatMap((url, i) => [
        { type: 'text' as const, text: `Photo p${i}${reconciled.active[i].nearDuplicateOf ? '; possible alternate view of an earlier photo' : ''}.` },
        { type: 'image' as const, image: url },
      ]),
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
    // The prompt VARIANT is selectable; the FEATURE is not. Keeping `feature` fixed
    // means model routing, cost dashboards and the AI audit log continue to see one
    // feature, while `taskId` records which spec actually ran — which is what makes
    // the two directly comparable in a LAT-002 report.
    taskId: analysisTaskId(),
    feature: 'ops.junkAnalysis',
    vars: await truckVars(),
    messages,
    maxOutputTokens: analysisOutputTokenBudget(photos.length),
    temperature: 0.2,
    // Interactive callers pin an explicit slice + single shot; the durable worker
    // passes neither and keeps the platform default timeout and retry.
    ...(input.timeoutMs && input.timeoutMs > 0 ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.attempts && input.attempts > 0 ? { attempts: input.attempts } : {}),
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
      ok: false, callId: res.callId, outcome: res.outcome, errorClass: res.errorClass,
      latencyMs: res.latencyMs,
    }
  }

  // Observability: the provider (AI Gateway) round-trip latency on success — the model
  // call only, separate from our surrounding preprocessing/normalization work.
  markStage('provider', res.latencyMs)

  // runAiTask ran without the flat schema (the shape is nested), so parse here and
  // hand the raw object to the robust normalizer.
  //
  // WHY THIS IS NOT JUST `try { JSON.parse } catch {}` ANY MORE. It used to be, and the
  // failure was invisible in a way that cost a real booking. On JK-B-1022 the model was
  // cut off at the token cap mid-object; the regex still matched a prefix ending at some
  // inner `}`, `JSON.parse` threw, the catch set `raw = undefined`, and
  // `normalizeAnalysis({})` then FABRICATED a complete-looking analysis out of pure
  // defaults — zero items, every confidence 0, every condition false, truck loads
  // 0.7/1/1.4, and one synthesized photoObservation per URL with imageQuality
  // 'limited'. Downstream that reads as "the AI looked and found nothing", so the
  // booking went to manual review while `runAiTask` recorded outcome=success and the
  // dashboards showed a clean call. Nothing anywhere said "we threw the answer away".
  //
  // So: a response we could not read is now a FAILURE with its own outcome, and it
  // returns the honest review fallback rather than a fabricated analysis.
  const read = readAnalysisResponse(res.text, res)
  const { raw, truncated, parseFailed } = read

  if (truncated || parseFailed) {
    // Truncation is reported separately from an unreadable-for-other-reasons response
    // because they have different fixes: one is a token budget, the other is a prompt or
    // a model that stopped emitting JSON. Collapsing them into one bucket is what made
    // this take a booking-shaped outage to notice.
    const outcome = truncated ? 'output_truncated' : 'unparseable_response'
    markStageFailure('provider', res.latencyMs, outcome, false)
    void updateAiCall(res.callId, { manualReviewReason: outcome })
    return {
      analysis: reviewFallbackAnalysis(ctx, [
        truncated
          ? 'The automated read was cut off before it finished. A team member will review your photos.'
          : 'The automated read could not be interpreted. A team member will review your photos.',
      ]),
      ok: false,
      callId: res.callId,
      model: res.model,
      latencyMs: res.latencyMs,
      outcome,
    }
  }

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
