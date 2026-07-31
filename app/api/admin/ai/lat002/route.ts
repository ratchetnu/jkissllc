// LAT-002 — the photo-estimate latency experiment surface.
//
// GET  — list recent runs, or one run in full. ALWAYS available: a run recorded
//        while the flag was on must stay inspectable after it goes off, or the
//        evidence disappears exactly when someone wants to question the verdict.
// POST — record a run from submitted paired samples. Gated on
//        `LAT002_EXPERIMENT_ENABLED`, which is Preview-only by intent and OFF by
//        default in every environment.
//
// PERMISSION: `ai:analytics` to read (admin + manager — this is the same
// observability grant the AI Control Center uses), `ai:prompts:manage` to record
// (admin only — recording a run is what decides whether a model/prompt change is
// promotable, and rbac.ts already keeps that decision admin-only).
//
// The report is never accepted from the client: the store recomputes it from the
// submitted pairs, so a stored verdict cannot disagree with its own evidence.
//
// Tenant-scoped through the redis chokepoint, which fails closed with no tenant.
import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../_lib/session'
import { isEnabled } from '../../../../lib/platform/flags'
import { getLat002Run, listLat002Runs, saveLat002Run, MAX_RUN_PAIRS, RUN_ID_RE } from '../../../../lib/estimation/lat002-store'
import type { Lat002Pair, Lat002Sample } from '../../../../lib/estimation/lat002'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** Validate a sample completely. A partially-valid arm would silently score as
 *  zero latency / zero cost and flatter the candidate. */
function parseSample(v: unknown): Lat002Sample | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const latencyMs = num(o.latencyMs), outputTokens = num(o.outputTokens)
  const costUsd = num(o.costUsd), quoteUsd = num(o.quoteUsd), confidence = num(o.confidence)
  if (latencyMs == null || latencyMs < 0) return null
  if (outputTokens == null || outputTokens < 0) return null
  if (costUsd == null || costUsd < 0) return null
  if (quoteUsd == null || quoteUsd < 0) return null
  if (confidence == null || confidence < 0 || confidence > 1) return null
  if (typeof o.manualReview !== 'boolean' || typeof o.schemaValid !== 'boolean') return null
  return { latencyMs, outputTokens, costUsd, quoteUsd, confidence, manualReview: o.manualReview, schemaValid: o.schemaValid }
}

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'ai:analytics')
  if (who instanceof NextResponse) return who

  const runId = S(req.nextUrl.searchParams.get('runId'), 60)
  try {
    if (runId) {
      const run = await getLat002Run(runId)
      if (!run) return NextResponse.json({ error: 'not_found' }, { status: 404 })
      return NextResponse.json({ ok: true, run })
    }
    return NextResponse.json({ ok: true, runs: await listLat002Runs(20), recordingEnabled: isEnabled('LAT002_EXPERIMENT_ENABLED') })
  } catch {
    return NextResponse.json({ error: 'unavailable', message: 'Could not load LAT-002 runs right now.' }, { status: 503 })
  }
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'ai:prompts:manage')
  if (who instanceof NextResponse) return who

  if (!isEnabled('LAT002_EXPERIMENT_ENABLED')) {
    return NextResponse.json(
      { error: 'disabled', message: 'LAT-002 experiment recording is turned off in this environment.' },
      { status: 403 },
    )
  }

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const runId = S(body.runId, 60)
  if (!RUN_ID_RE.test(runId)) {
    return NextResponse.json({ error: 'invalid', message: 'runId must look like lat002_<id>.' }, { status: 400 })
  }
  const baselineArm = S((body.arms as Record<string, unknown>)?.baseline, 120)
  const candidateArm = S((body.arms as Record<string, unknown>)?.candidate, 120)
  if (!baselineArm || !candidateArm) {
    return NextResponse.json({ error: 'invalid', message: 'Both arms must be named.' }, { status: 400 })
  }

  const rawPairs = Array.isArray(body.pairs) ? body.pairs : []
  if (!rawPairs.length) {
    return NextResponse.json({ error: 'invalid', message: 'At least one pair is required.' }, { status: 400 })
  }
  if (rawPairs.length > MAX_RUN_PAIRS) {
    return NextResponse.json({ error: 'invalid', message: `At most ${MAX_RUN_PAIRS} pairs per run.` }, { status: 400 })
  }

  const pairs: Lat002Pair[] = []
  const seen = new Set<string>()
  for (const raw of rawPairs) {
    const o = (raw ?? {}) as Record<string, unknown>
    const bookingId = S(o.bookingId, 120)
    const baseline = parseSample(o.baseline)
    const candidate = parseSample(o.candidate)
    // Reject the whole run rather than skip a bad pair: a silently dropped pair
    // changes the denominator of every rate in the report.
    if (!bookingId || !baseline || !candidate) {
      return NextResponse.json({ error: 'invalid', message: 'Every pair needs a bookingId and two complete arms.' }, { status: 400 })
    }
    if (seen.has(bookingId)) {
      return NextResponse.json({ error: 'invalid', message: `Duplicate bookingId in pairs: ${bookingId}.` }, { status: 400 })
    }
    seen.add(bookingId)
    pairs.push({ bookingId, baseline, candidate })
  }

  try {
    // Idempotent by runId: re-POSTing the same run replaces it with an identical
    // record rather than minting a second one, so a retry after an unknown
    // response is safe.
    const existing = await getLat002Run(runId)
    const run = await saveLat002Run({
      runId,
      arms: { baseline: baselineArm, candidate: candidateArm },
      note: S(body.note, 500) || undefined,
      createdAt: existing?.createdAt ?? Date.now(),
      createdBy: existing?.createdBy ?? who.sub,
      pairs,
    })
    return NextResponse.json({ ok: true, replaced: !!existing, run })
  } catch {
    return NextResponse.json({ error: 'unavailable', message: 'Could not record that run.' }, { status: 503 })
  }
})
