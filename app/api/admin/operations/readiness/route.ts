// Sprint 7 — operational readiness surface.
//
// GET  — the gap log, the readings, the observation windows and the readiness
//        verdict. The verdict is DERIVED on every read, never stored, so it cannot
//        be left stale or set optimistically.
// POST — record a gap, resolve a gap, or capture a reading (baseline / follow-up).
//
// PERMISSION: `audit:view` to read (admin only — `rbac.ts` states that grant stays
// admin-only, and this is an operational record of what went wrong), `settings:manage`
// to write (admin only — recording readiness evidence is a release-governance act).
//
// The Upstash request COUNT arrives as a human-transcribed reading. It is accepted
// only with its source and reader attached, because a number with no provenance is
// indistinguishable from a guess — and this whole surface exists to stop guesses
// being read as observations.
//
// Tenant-scoped through the redis chokepoint, which fails closed with no tenant.
import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../_lib/session'
import {
  saveGap, getGap, listGaps, saveReading, getReading, listReadings,
  summariseGaps, windowStatus, compareUsage, readinessVerdict,
  WINDOW_24H, WINDOW_7D, GAP_SEVERITIES, READING_ID_RE, GAP_ID_RE,
  type OpsGap, type OpsReading, type GapSeverity, type ExternalUsageReading,
} from '../../../../lib/platform/ops-readiness'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const posInt = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
}

function parseUsage(v: unknown, who: string): ExternalUsageReading | null | 'invalid' {
  if (v == null) return null
  if (typeof v !== 'object') return 'invalid'
  const o = v as Record<string, unknown>
  const requestsUsed = posInt(o.requestsUsed)
  const allowance = posInt(o.allowance)
  const source = S(o.source, 200)
  if (requestsUsed == null || allowance == null) return 'invalid'
  // Provenance is mandatory. A transcribed number without a stated source is the
  // thing this surface exists to make impossible.
  if (!source) return 'invalid'
  return { requestsUsed, allowance, readAt: posInt(o.readAt) ?? Date.now(), source, readBy: who }
}

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'audit:view')
  if (who instanceof NextResponse) return who

  try {
    const [gaps, readings] = await Promise.all([listGaps(50), listReadings(20)])
    const summary = summariseGaps(gaps)

    const baseline = readings.filter(r => r.kind === 'baseline').sort((a, b) => a.capturedAt - b.capturedAt)[0] ?? null
    const followUps = readings.filter(r => r.kind === 'follow_up').sort((a, b) => b.capturedAt - a.capturedAt)
    const now = Date.now()

    const windows = baseline
      ? [WINDOW_24H, WINDOW_7D].map(t => {
          // A follow-up only counts for a window if it was captured after the
          // window's target had actually elapsed — otherwise an early reading
          // would satisfy a window it never observed.
          const eligible = followUps.find(f => f.capturedAt - baseline.capturedAt >= t.hours * 3_600_000) ?? null
          return windowStatus(t, baseline.capturedAt, now, eligible)
        })
      : []

    const latestFollowUp = followUps[0] ?? null
    const usage = baseline && latestFollowUp ? compareUsage(baseline, latestFollowUp) : null

    return NextResponse.json({
      ok: true,
      generatedAt: now,
      gaps, summary,
      readings, baseline, latestFollowUp,
      windows,
      usage,
      verdict: readinessVerdict(summary, windows),
    })
  } catch {
    return NextResponse.json({ error: 'unavailable', message: 'Could not load operational readiness right now.' }, { status: 503 })
  }
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'settings:manage')
  if (who instanceof NextResponse) return who

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const action = S(body.action, 40)

  try {
    if (action === 'record_gap') {
      const id = S(body.id, 60)
      if (!GAP_ID_RE.test(id)) {
        return NextResponse.json({ error: 'invalid', message: 'id must look like gap_<id>.' }, { status: 400 })
      }
      const severity = S(body.severity, 20) as GapSeverity
      if (!GAP_SEVERITIES.includes(severity)) {
        return NextResponse.json({ error: 'invalid', message: `severity must be one of ${GAP_SEVERITIES.join(', ')}.` }, { status: 400 })
      }
      const summary = S(body.summary, 300)
      const surface = S(body.surface, 80)
      if (!summary || !surface) {
        return NextResponse.json({ error: 'invalid', message: 'surface and summary are required.' }, { status: 400 })
      }
      // Idempotent by id: re-recording preserves the ORIGINAL observation time and
      // observer, so a retry cannot backdate or re-attribute a gap.
      const existing = await getGap(id)
      const gap: OpsGap = {
        id,
        at: existing?.at ?? Date.now(),
        observedBy: existing?.observedBy ?? who.sub,
        severity, surface, summary,
        detail: S(body.detail, 2000) || undefined,
        resolvedAt: existing?.resolvedAt,
        resolutionNote: existing?.resolutionNote,
      }
      await saveGap(gap)
      return NextResponse.json({ ok: true, replaced: !!existing, gap })
    }

    if (action === 'resolve_gap') {
      const id = S(body.id, 60)
      const gap = await getGap(id)
      if (!gap) return NextResponse.json({ error: 'not_found' }, { status: 404 })
      // Idempotent: the FIRST resolution time stands.
      const resolved: OpsGap = {
        ...gap,
        resolvedAt: gap.resolvedAt ?? Date.now(),
        resolutionNote: gap.resolutionNote ?? (S(body.resolutionNote, 1000) || undefined),
      }
      await saveGap(resolved)
      return NextResponse.json({ ok: true, gap: resolved })
    }

    if (action === 'capture_reading') {
      const id = S(body.id, 60)
      if (!READING_ID_RE.test(id)) {
        return NextResponse.json({ error: 'invalid', message: 'id must look like ops_<id>.' }, { status: 400 })
      }
      const kind = S(body.kind, 20)
      if (kind !== 'baseline' && kind !== 'follow_up') {
        return NextResponse.json({ error: 'invalid', message: "kind must be 'baseline' or 'follow_up'." }, { status: 400 })
      }
      const health = S(body.health, 20)
      if (!['healthy', 'degraded', 'unhealthy'].includes(health)) {
        return NextResponse.json({ error: 'invalid', message: 'health must be healthy, degraded or unhealthy.' }, { status: 400 })
      }
      const usage = parseUsage(body.upstash, who.sub)
      if (usage === 'invalid') {
        return NextResponse.json(
          { error: 'invalid', message: 'upstash needs requestsUsed, allowance and a source — a transcribed number without provenance is not a reading.' },
          { status: 400 },
        )
      }
      const existing = await getReading(id)
      const reading: OpsReading = {
        id, kind: kind as OpsReading['kind'],
        capturedAt: existing?.capturedAt ?? Date.now(),
        capturedBy: existing?.capturedBy ?? who.sub,
        build: S(body.build, 120),
        health: health as OpsReading['health'],
        cronRunsPerDay: posInt(body.cronRunsPerDay) ?? 0,
        estimatedRedisRequestsPerDay: posInt(body.estimatedRedisRequestsPerDay) ?? 0,
        upstash: usage ?? undefined,
        notes: S(body.notes, 2000) || undefined,
        baselineId: S(body.baselineId, 60) || undefined,
      }
      await saveReading(reading)
      return NextResponse.json({ ok: true, replaced: !!existing, reading })
    }

    return NextResponse.json({ error: 'invalid', message: 'Unknown action.' }, { status: 400 })
  } catch {
    return NextResponse.json({ error: 'unavailable', message: 'Could not record that right now.' }, { status: 503 })
  }
})
