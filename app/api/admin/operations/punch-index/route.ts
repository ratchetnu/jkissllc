// Sprint 3.1 Phase C — operating the open-punch index.
//
// GET  — the parity report: index versus a complete scan, plus the completion
//        marker. This is the evidence that must be clean BEFORE
//        `OPEN_PUNCH_INDEX_ENABLED` is turned on anywhere, and the drift check
//        afterwards. Read-only; it never writes an index key.
// POST — `backfill` (build the index and mark it ready) or `reconcile` (report,
//        optionally repairing drift).
//
// PERMISSION: `audit:view` to read (admin only, matching the other operational
// evidence surfaces), `settings:manage` to write — building or repairing an index
// that enforcement will consult is a release-governance act, not a report.
//
// Nothing here enables enforcement. `SINGLE_OPEN_PUNCH_ENABLED` remains a separate
// owner decision, and a ready index with enforcement off changes no behaviour.
import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../_lib/session'
import { isEnabled } from '../../../../lib/platform/flags'
import { indexIsAuthoritative, readReadyMarker } from '../../../../lib/timeclock/open-punch-index'
import { backfillOpenPunchIndex, planOpenPunchBackfill, reconcileOpenPunchIndex } from '../../../../lib/timeclock/open-punch-backfill'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'audit:view')
  if (who instanceof NextResponse) return who

  try {
    const [marker, authoritative, drift] = await Promise.all([
      readReadyMarker(),
      indexIsAuthoritative(),
      reconcileOpenPunchIndex(),
    ])
    return NextResponse.json({
      ok: true,
      flagEnabled: isEnabled('OPEN_PUNCH_INDEX_ENABLED'),
      enforcementEnabled: isEnabled('SINGLE_OPEN_PUNCH_ENABLED'),
      marker,
      authoritative,
      drift,
      // The single fact a reader needs before activating anything.
      atParity: drift.complete && !drift.missing.length && !drift.extra.length && !drift.misfiled.length,
    })
  } catch {
    return NextResponse.json({ error: 'unavailable', message: 'Could not read the open-punch index right now.' }, { status: 503 })
  }
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'settings:manage')
  if (who instanceof NextResponse) return who

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const action = S(body.action, 40)

  try {
    if (action === 'backfill') {
      // Dry run FIRST, before runId is minted or the lease is reachable. A planning
      // request must be structurally incapable of falling through into a real
      // backfill — so this returns rather than setting a flag the code below reads.
      if (body.dryRun === true) {
        const plan = await planOpenPunchBackfill()
        if (!plan.ok) {
          return NextResponse.json({ error: 'incomplete', message: plan.reason }, { status: 409 })
        }
        return NextResponse.json({ ok: true, plan })
      }

      const runId = S(body.runId, 60) || `bf_${Date.now().toString(36)}`
      const result = await backfillOpenPunchIndex(runId, Date.now())
      if (!result.ok) {
        // `incomplete` means the evidence was not there — a 409, not a server
        // error, because retrying the identical request will not help until the
        // underlying scan can complete.
        return NextResponse.json(
          { error: result.block === 'busy' ? 'busy' : 'incomplete', message: result.reason },
          { status: result.block === 'busy' ? 409 : 409 },
        )
      }
      return NextResponse.json({ ok: true, marker: result.marker, removedStale: result.removedStale })
    }

    if (action === 'reconcile') {
      const drift = await reconcileOpenPunchIndex({ repair: body.repair === true })
      if (!drift.complete) {
        return NextResponse.json({ error: 'incomplete', message: drift.reason }, { status: 409 })
      }
      return NextResponse.json({ ok: true, drift })
    }

    return NextResponse.json({ error: 'invalid', message: 'Unknown action.' }, { status: 400 })
  } catch {
    return NextResponse.json({ error: 'unavailable', message: 'Could not run that right now.' }, { status: 503 })
  }
})
