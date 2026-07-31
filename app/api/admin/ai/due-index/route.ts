// Due-index backfill + coverage — the operator surface for the staged enable.
//
// GET  ?action=coverage — read-only proof of how many due jobs the index knows
//                         about, and which due jobs it is MISSING (the dangerous
//                         direction: those would be stranded if the read source
//                         flipped now).
// POST ?action=backfill — walk a bounded slice of the booking index and populate
//                         the due indexes. DRY RUN BY DEFAULT: writing requires an
//                         explicit `dryRun: false`, so a mis-typed request prices
//                         the work instead of performing it.
//
// PERMISSION: `ai:prompts:manage` — admin only. This decides whether the AI cron's
// work-selection is safe to switch, which is the same class of decision rbac.ts
// already keeps admin-only. Reading coverage takes the same grant: `missingFromIndex`
// leaks booking tokens, so it is not an `ai:analytics` read.
//
// NOT gated on OPERION_DUE_INDEX. The whole point is to establish coverage BEFORE
// the flag is enabled; gating it on the flag would make the safe sequence impossible.
//
// Tenant-scoped through the redis chokepoint, which fails closed with no tenant —
// so a backfill runs against exactly one tenant's bookings and index per request.
import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../_lib/session'
import { backfillDueIndexes, verifyDueIndexCoverage, BACKFILL_PAGE, BACKFILL_MAX_PAGES_PER_CALL } from '../../../../lib/ai-due-backfill'
import { readDueTokens, type DueLane } from '../../../../lib/ai-due-index'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const int = (v: unknown, dflt: number, max: number): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), max) : dflt
}

const readIndex = async (lane: DueLane, at: number, limit: number): Promise<string[]> => {
  const r = await readDueTokens(lane, at, limit)
  // Coverage must not report "covered" off an unreadable index. Throwing surfaces
  // it as a 503 rather than an empty set that looks like agreement.
  if (!r.ok) throw new Error(r.error)
  return r.tokens
}

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'ai:prompts:manage')
  if (who instanceof NextResponse) return who

  if (req.nextUrl.searchParams.get('action') !== 'coverage') {
    return NextResponse.json({ error: 'invalid', message: 'Use ?action=coverage.' }, { status: 400 })
  }
  try {
    const report = await verifyDueIndexCoverage(readIndex, {
      pageSize: int(req.nextUrl.searchParams.get('pageSize'), BACKFILL_PAGE, 500),
      maxPages: int(req.nextUrl.searchParams.get('maxPages'), BACKFILL_MAX_PAGES_PER_CALL, 100),
    })
    return NextResponse.json({ ok: true, ...report })
  } catch {
    return NextResponse.json({ error: 'unavailable', message: 'Could not verify due-index coverage right now.' }, { status: 503 })
  }
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'ai:prompts:manage')
  if (who instanceof NextResponse) return who

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  if (body.action !== 'backfill') {
    return NextResponse.json({ error: 'invalid', message: 'Use {"action":"backfill"}.' }, { status: 400 })
  }

  // SAFE BY DEFAULT: only an explicit `false` writes. Anything else — absent, null,
  // the string "false", a typo — prices the work instead of performing it.
  const dryRun = body.dryRun !== false

  try {
    const result = await backfillDueIndexes({
      dryRun,
      cursor: int(body.cursor, 0, Number.MAX_SAFE_INTEGER),
      pageSize: int(body.pageSize, BACKFILL_PAGE, 500),
      maxPages: int(body.maxPages, BACKFILL_MAX_PAGES_PER_CALL, 100),
    })
    if (!dryRun) {
      console.log('[due-index] backfill wrote', JSON.stringify({
        by: who.sub, startCursor: result.startCursor, nextCursor: result.nextCursor,
        written: result.written, writeFailures: result.writeFailures,
        requests: result.estimatedRedisRequests,
      }))
    }
    return NextResponse.json({ ok: true, ...result })
  } catch {
    return NextResponse.json({ error: 'unavailable', message: 'Could not run the due-index backfill right now.' }, { status: 503 })
  }
})
