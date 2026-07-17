// ─────────────────────────────────────────────────────────────────────────────
// analyzePhotosV2 — the MULTI-PASS junk-removal vision orchestrator (Phase 3).
//
// "Multi-pass" here is done as ONE governed, high-detail structured call, not N
// separate provider calls. The V2 expert prompt asks the model to (Pass A) observe
// EACH image on its own AND (Pass B) reconcile ACROSS all images into a single
// DEDUPLICATED unified inventory — in one response. This is the practical multi-pass
// the AI Gateway supports well: the model performs per-image + cross-image dedup in a
// single pass, which avoids paying for the images N× while still producing both the
// per-image evidence and the reconciled job-level inventory. (A separate second QA
// vision pass already exists as ops.junkAnalysisReview; this module is the analysis.)
//
// PROVIDER-AGNOSTIC: runs entirely through the existing LLMOps chokepoint
// (runAiTask → Vercel AI Gateway). Default is Claude; switching AI_MODEL to
// openai/gpt-4o (or any Gateway model) needs NO code change and NO OpenAI SDK.
//
// The model produces OBSERVATIONS + a deduplicated inventory + operational factors
// ONLY. It NEVER sets a price — deterministic code (estimation/* + priceJob) owns
// volume, load tier, and pricing. Every model field is validated/clamped by
// normalizeAnalysisV2; raw output is never trusted. Fail-soft throughout: any error,
// unusable photo set, or malformed response degrades to a manual-review shell so the
// booking is preserved — we NEVER return a malformed "completed" analysis.
// ─────────────────────────────────────────────────────────────────────────────

import type { ModelMessage } from 'ai'
import { runAiTask } from './service'
import { isAllowedPhotoUrl } from '../photo-url'
import { evaluatePhotoQuality, type PhotoDescriptor, type PhotoQualityGateResult } from './photo-quality-gate'
import { dedupePhotoUrls } from './photo-dedup'
import { buildAnalysisV2Prompt, ANALYSIS_V2_PROMPT_VERSION } from './analysis-v2-prompt'
import { estimateCostUsd } from './telemetry'
import {
  normalizeAnalysisV2, reviewFallbackV2,
  type JunkPhotoAnalysisV2, type NormalizeV2Ctx, type ImageQuality,
} from './analysis-schema-v2'

const MAX_PHOTOS = 8

export type AnalyzePhotosV2Input = {
  bookingId: string
  photoUrls: string[]        // Vercel Blob public URLs (server-fetched by the model)
  serviceLabel?: string
  customerNotes?: string
  nowIso: string             // caller supplies the timestamp (keeps this pure of Date.now)
  imageIds?: string[]        // optional stable ids aligned to photoUrls; else img_1..n
}

export type AnalyzePhotosV2Result = {
  analysis: JunkPhotoAnalysisV2
  ok: boolean                // true only if the model produced a usable read
  model?: string
  callId?: string
  latencyMs?: number
  outcome: string            // 'completed' | 'no_usable_photos' | 'invalid_response' | provider outcome
  errorClass?: string        // 'billing' | 'auth' | 'network' | 'rate_limit' | 'schema' | ... — decides retryability
  rawDebug?: string          // truncated raw model text, only when we fell back on invalid output
  // Provider accounting, surfaced so callers can record what a run ACTUALLY cost rather
  // than inventing a figure. Present only on a successful call that reported usage —
  // undefined means "unknown", and callers must persist null rather than guess.
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  estCostUsd?: number
  promptVersion?: string     // the V2 vision prompt label that actually ran (e.g. 'v2-2')
  imageCount?: number        // usable images the model was actually shown (post-dedupe)
}

/** ANALYSIS_V2_PROMPT_VERSION is a label ('v2-2'); V2ShadowJob.promptVersion is numeric
 *  because it forms the deployment key with model + estimatorVersion. Take the trailing
 *  integer so a prompt bump reads as a distinct deployment instead of the "p?" we shipped. */
export function promptVersionNumber(label: string | undefined): number | undefined {
  const m = /(\d+)$/.exec(label ?? '')
  return m ? Number(m[1]) : undefined
}

// Dependency-injection seams so tests can mock the AI + the quality gate without
// any live provider call. Defaults are the real implementations.
export type AnalyzePhotosV2Deps = {
  runAi?: typeof runAiTask
  evaluateQuality?: typeof evaluatePhotoQuality
  dedupe?: typeof dedupePhotoUrls
}

const providerOf = (model: string): string => (model.includes('/') ? model.split('/')[0] : 'vercel-ai-gateway')

/** Abort timeout for the heavy V2 vision call. Defaults to 90s (the shadow cron has a 300s
 *  budget) — well above the ~40–55s the multi-pass call takes. Override with AI_VISION_TIMEOUT_MS. */
function visionAnalysisTimeoutMs(): number {
  const raw = Number(process.env.AI_VISION_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 90_000
}

// Extract the first balanced-looking JSON object from model text. Fail-soft.
function parseJsonObject(text: string): unknown {
  try {
    const m = text.match(/\{[\s\S]*\}/)
    return m ? JSON.parse(m[0]) : undefined
  } catch {
    return undefined
  }
}

// True when a normalized analysis carries no usable read (no usable observations
// AND no unified items) — the signal to attempt a repair retry / fall back.
function isEmptyRead(a: JunkPhotoAnalysisV2): boolean {
  const usableObs = a.perImageObservations.filter((o) => o.imageQuality !== 'unusable').length
  return usableObs === 0 && a.unifiedInventory.length === 0
}

// Map the deterministic gate's per-photo verdict to the schema's imageQualityResults,
// keeping the gate authoritative for whether an image was usable pre-model.
function gateQualityResults(
  gate: PhotoQualityGateResult,
): { imageId: string; quality: ImageQuality; warnings: string[] }[] {
  return gate.perPhoto.map((p) => ({
    imageId: p.id,
    quality: (p.usableForEstimate ? 'good' : 'unusable') as ImageQuality,
    warnings: p.warnings.map(String),
  }))
}

// Stamp the deterministic gate results onto an analysis (received/usable counts +
// per-image quality). The gate — not the model — is the source of truth for which
// uploaded photos were usable enough to attempt an estimate.
function attachQuality(
  analysis: JunkPhotoAnalysisV2,
  gate: PhotoQualityGateResult,
  allImageIds: string[],
): JunkPhotoAnalysisV2 {
  const usable = gate.perPhoto.filter((p) => p.usableForEstimate).length
  return {
    ...analysis,
    imageCountReceived: allImageIds.length,
    imageCountUsable: usable,
    imageQualityResults: gateQualityResults(gate),
  }
}

export async function analyzePhotosV2(
  input: AnalyzePhotosV2Input,
  deps: AnalyzePhotosV2Deps = {},
): Promise<AnalyzePhotosV2Result> {
  const runAi = deps.runAi ?? runAiTask
  const evaluateQuality = deps.evaluateQuality ?? evaluatePhotoQuality

  // Defense-in-depth: only ever hand our own Blob-hosted images to the provider.
  const allowed = (Array.isArray(input.photoUrls) ? input.photoUrls : []).filter(isAllowedPhotoUrl).slice(0, MAX_PHOTOS)
  // Collapse EXACT byte-duplicate uploads before analysis so a repeat photo can never
  // multiply the inventory/volume (deterministic backstop to prompt rule 4). Fail-open.
  // Skipped for a single photo — one image can't duplicate itself (also avoids a needless fetch).
  const dd = allowed.length > 1 ? await (deps.dedupe ?? dedupePhotoUrls)(allowed) : { uniqueUrls: allowed, duplicateCount: 0 }
  const photos = dd.uniqueUrls
  if (dd.duplicateCount > 0) console.log(`[analysis-v2] collapsed ${dd.duplicateCount} duplicate photo(s)`)
  const allImageIds =
    Array.isArray(input.imageIds) && input.imageIds.length
      ? photos.map((_, i) => String(input.imageIds![i] ?? `img_${i + 1}`))
      : photos.map((_, i) => `img_${i + 1}`)

  // Fallback context spans ALL received images (correct received-count in shells).
  const ctxAll: NormalizeV2Ctx = {
    bookingId: input.bookingId,
    analyzedAt: input.nowIso,
    model: '',
    promptVersion: ANALYSIS_V2_PROMPT_VERSION,
    imageIds: allImageIds,
  }

  // ── Photo-quality gate FIRST — decide which images are worth analyzing. ──
  const descriptors: PhotoDescriptor[] = photos.map((url, i) => ({ id: allImageIds[i], url }))
  const gate = evaluateQuality(descriptors)
  const usableIdx = gate.perPhoto
    .map((p, i) => (p.usableForEstimate ? i : -1))
    .filter((i) => i >= 0)
  const usablePhotos = usableIdx.map((i) => photos[i])
  const usableImageIds = usableIdx.map((i) => allImageIds[i])

  if (usablePhotos.length === 0) {
    const analysis = attachQuality(
      reviewFallbackV2(ctxAll, ['No usable photos to analyze — a team member will review the submission.']),
      gate,
      allImageIds,
    )
    return { analysis, ok: false, outcome: 'no_usable_photos' }
  }

  // Normalization context spans only the USABLE images the model actually saw.
  const ctxModel: NormalizeV2Ctx = { ...ctxAll, imageIds: usableImageIds }

  // ── Build the ONE governed multimodal call: expert prompt + per-image ids + images. ──
  const built = buildAnalysisV2Prompt(usablePhotos.length, input.serviceLabel, input.customerNotes)
  const idLegend = usableImageIds.map((id, i) => `Image ${i + 1} → imageId "${id}"`).join('; ')
  const buildContent = (leadText: string): Array<{ type: 'text'; text: string } | { type: 'image'; image: string }> => [
    { type: 'text', text: leadText },
    ...usablePhotos.map((url) => ({ type: 'image' as const, image: url })),
  ]
  // runAiTask sends its own registry system prompt in the `system` slot, so the full
  // V2 expert prompt (system rules + per-call instruction) is carried in the user
  // message where it dominates. This mirrors junk-analysis.ts.
  const primaryText = `${built.system}\n\n${built.user}\n\nImage id legend: ${idLegend}`
  const messages: ModelMessage[] = [{ role: 'user', content: buildContent(primaryText) }]

  let res: Awaited<ReturnType<typeof runAiTask>>
  try {
    res = await runAi({
      taskId: 'ops.junkAnalysis',
      feature: 'ops.junkAnalysis',
      vars: {},
      messages,
      maxOutputTokens: 4000,
      temperature: 0.15,
      // The V2 multi-pass call is heavy (~40–55s) and runs on the vision-shadow cron
      // (maxDuration 300s), so it needs more than the 30s default AI timeout or it aborts.
      timeoutMs: visionAnalysisTimeoutMs(),
      requestChars: usablePhotos.join(',').length,
    })
  } catch {
    // runAiTask is itself fail-soft, but guard anyway — never throw into the caller.
    const analysis = attachQuality(
      reviewFallbackV2(ctxAll, ['Automated analysis was unavailable — a team member will review your photos.']),
      gate,
      allImageIds,
    )
    return { analysis, ok: false, outcome: 'exception' }
  }

  if (!res.ok) {
    // Provider error / budget / invalid → preserve the booking as review-required.
    const analysis = attachQuality(
      reviewFallbackV2(ctxAll, [`Automated analysis was unavailable (${res.outcome}). A team member will review your photos.`]),
      gate,
      allImageIds,
    )
    return { analysis, ok: false, callId: res.callId, outcome: res.outcome, errorClass: res.errorClass }
  }

  const modelName = res.model || ''
  const ctxWithModel: NormalizeV2Ctx = { ...ctxModel, model: modelName }

  // First parse + normalize.
  let raw = parseJsonObject(res.text)
  let analysis = normalizeAnalysisV2(raw, ctxWithModel)

  // ── Repair retry: ONE terse re-prompt when the model returned no parseable object
  //    OR normalization yielded an empty read despite usable photos. ──
  let callId = res.callId
  let latencyMs = res.latencyMs
  let lastText = res.text
  if (raw == null || typeof raw !== 'object' || isEmptyRead(analysis)) {
    const repairText =
      `Your previous response could not be parsed into the required JunkPhotoAnalysisV2 shape. ` +
      `Return ONLY one valid minified JSON object matching that exact schema — no prose, no markdown, no code fences, no price. ` +
      `Image id legend: ${idLegend}`
    const repair = await runAi({
      taskId: 'ops.junkAnalysis',
      feature: 'ops.junkAnalysis',
      vars: {},
      messages: [{ role: 'user', content: buildContent(repairText) }],
      maxOutputTokens: 4000,
      temperature: 0,
      requestChars: usablePhotos.join(',').length,
    }).catch(() => null)

    if (repair && repair.ok) {
      callId = repair.callId
      latencyMs = repair.latencyMs
      lastText = repair.text
      const repairCtx: NormalizeV2Ctx = { ...ctxModel, model: repair.model || modelName }
      const repairRaw = parseJsonObject(repair.text)
      const repairAnalysis = normalizeAnalysisV2(repairRaw, repairCtx)
      raw = repairRaw
      analysis = repairAnalysis
    }

    // Still bad after the repair attempt → manual-review shell (never a bad 'completed').
    if (raw == null || typeof raw !== 'object' || isEmptyRead(analysis)) {
      const fallback = attachQuality(
        reviewFallbackV2(ctxAll, ['Automated analysis produced an unreadable result — a team member will review your photos.']),
        gate,
        allImageIds,
      )
      return {
        analysis: fallback,
        ok: false,
        callId,
        model: modelName,
        latencyMs,
        outcome: 'invalid_response',
        rawDebug: typeof lastText === 'string' ? lastText.slice(0, 2000) : undefined,
      }
    }
  }

  // Good read. Stamp the deterministic gate quality onto the analysis.
  const finalAnalysis = attachQuality({ ...analysis, model: modelName || analysis.model, promptVersion: ANALYSIS_V2_PROMPT_VERSION }, gate, allImageIds)
  // Model provider recorded for observability parity with junk-analysis.ts.
  void providerOf(modelName)
  return {
    analysis: finalAnalysis,
    ok: true,
    callId,
    model: modelName,
    latencyMs,
    outcome: 'completed',
    usage: res.usage,
    // Cost comes from the SAME estimator the AI telemetry uses — never a second formula.
    estCostUsd: res.usage ? estimateCostUsd(modelName, res.usage.inputTokens, res.usage.outputTokens) : undefined,
    promptVersion: ANALYSIS_V2_PROMPT_VERSION,
    imageCount: usablePhotos.length,
  }
}
