import { NextRequest, NextResponse } from 'next/server'
import { getEvaluation } from '../../../../lib/ai/eval-telemetry'
import { getAiCall } from '../../../../lib/ai/telemetry'
import { isEnabled } from '../../../../lib/platform/flags'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation read — PREVIEW ONLY, flag-gated.
//
// Returns the joined view a benchmark needs for one analysis:
//   • the ESTIMATE side (lib/ai/eval-telemetry) — truck-load fraction, all five
//     confidence sub-scores, monitor concerns, critic verdict, quote;
//   • the PROVIDER side (the existing AI audit log, joined by call id) — token
//     usage, estimated and actual cost, attempts, retries, provider latency.
//
// The join is deliberate: token usage and cost already have exactly one source
// of truth in `recordAiCall`, and copying them into a second record would let
// the two drift. This route reads both and hands back one object.
//
// Same three gates as the provider diagnostic: 404 in Production regardless of
// flags, an explicitly-enabled flag (OFF by default), and Preview deployment
// protection in front of the host. Returns no secrets — the AI call record's
// prompt/response text is never included, only counts, costs and timings.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ analysisId: string }> },
) {
  if (process.env.VERCEL_ENV === 'production') {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (!isEnabled('AI_EVAL_TELEMETRY_ENABLED')) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const { analysisId } = await ctx.params
  const evaluation = await getEvaluation(analysisId)
  if (!evaluation) {
    return NextResponse.json(
      { error: 'no evaluation record', analysisId, hint: 'AI_EVAL_TELEMETRY_ENABLED must be set BEFORE the analysis runs' },
      { status: 404 },
    )
  }

  // Provider-side facts, joined by call id. Absent when the analysis never
  // reached the provider (no call was recorded) — that is a valid state, not an
  // error, and the benchmark reports it as "usage unavailable" rather than zero.
  let provider: Record<string, unknown> | null = null
  if (evaluation.aiCallId) {
    const call = await getAiCall(evaluation.aiCallId)
    if (call) {
      provider = {
        callId: call.id,
        model: call.model,
        outcome: call.outcome,
        errorClass: call.errorClass,
        latencyMs: call.latencyMs,
        attempts: call.attempts ?? 1,
        retried: call.retried ?? false,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        totalTokens: call.totalTokens,
        estCostUsd: call.estCostUsd,
        actualCostUsd: call.actualCostUsd,
        costSource: call.costSource,
        imageCount: call.imageCount,
        qualityScore: call.qualityScore,
      }
    }
  }

  return NextResponse.json(
    { ok: true, evaluation, provider },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
