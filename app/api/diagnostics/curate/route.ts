// ─────────────────────────────────────────────────────────────────────────────
// Preview-only dataset curation endpoint.
//
// The AI Gateway authenticates from inside a deployment, not from a laptop —
// `vercel env pull` yields an OIDC token that fails with "AI is not connected"
// when used locally. So the curation pipeline runs HERE and the CLI drives it,
// exactly as run-benchmark.ts drives /api/quote/analyze.
//
// THREE GATES, all required, same shape as the provider diagnostic:
//   1. never in Production, whatever the flags say;
//   2. AI_CURATION_DIAGNOSTIC_ENABLED, OFF by default everywhere;
//   3. Vercel deployment protection fronts the host.
//
// The image arrives as a data URL in the request body. Nothing is persisted:
// the private dataset never reaches Blob storage, and this route writes no
// manifest, no label and no file. It returns a decision for the CLI to record.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server'

import { isEnabled } from '../../../lib/platform/flags'
import { runCandidate } from '../../../../tools/vision-benchmark/curation/runtime'
import { gatewayCaller } from '../../../../tools/vision-benchmark/curation/gateway'
import { memoryCache } from '../../../../tools/vision-benchmark/curation/runtime'
import { checkIndependence } from '../../../../tools/vision-benchmark/curation/roles'
import type { ManifestEntry } from '../../../../tools/vision-benchmark/schema'

export const maxDuration = 300

export async function POST(req: Request): Promise<NextResponse> {
  if (process.env.VERCEL_ENV === 'production') {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (!isEnabled('AI_CURATION_DIAGNOSTIC_ENABLED')) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  // Fail closed before any spend if the roles are not independent.
  const ind = checkIndependence()
  if (!ind.ok) {
    return NextResponse.json({ error: 'role independence violated', details: ind.errors }, { status: 500 })
  }

  let body: { entry?: ManifestEntry; imageDataUrl?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }) }
  const { entry, imageDataUrl } = body
  if (!entry?.id || !imageDataUrl) {
    return NextResponse.json({ error: 'entry and imageDataUrl are required' }, { status: 400 })
  }

  const started = Date.now()
  try {
    const outcome = await runCandidate(
      entry,
      { caller: gatewayCaller({ timeoutMs: 60_000 }), cache: memoryCache() },
      { imageRoot: '/unused', imageDataUrl, now: new Date().toISOString() },
      new Map(),
    )
    return NextResponse.json({
      ok: true,
      id: outcome.id,
      state: outcome.decision.state,
      tier: outcome.decision.tier,
      reason: outcome.decision.reason,
      confidence: outcome.decision.confidence,
      criticalDisagreements: outcome.decision.criticalDisagreements,
      deterministicProblems: outcome.decision.deterministicProblems,
      adjudicated: outcome.adjudicated,
      usd: outcome.usd,
      latencyMs: outcome.latencyMs,
      classifier: outcome.classifier ?? null,
      label: outcome.label ?? null,
      verifier: outcome.verifier ?? null,
      failure: outcome.failure ?? null,
      wallMs: Date.now() - started,
      warnings: ind.warnings,
    })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e), wallMs: Date.now() - started },
      { status: 500 },
    )
  }
}
