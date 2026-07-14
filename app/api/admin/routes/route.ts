import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireSession } from '../_lib/session'
import {
  listRoutes, saveRoute, generateToken, nextRouteNumber, pushAudit,
  type RouteRecord,
} from '../../../lib/routes'
import { addCrew } from '../../../lib/route-notify'
import { contractorStatsObject } from '../../../lib/route-stats'
import { getBusiness, bizKey } from '../../../lib/businesses'
import { listStaff } from '../../../lib/staff'
import {
  parseMoneyCents, snapshotBusinessPrice, snapshotManualPrice,
  computeRouteMoney, payExceedsPrice, fmtCents,
} from '../../../lib/finance'

const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export const GET = withTenantRoute(async (req: NextRequest) => {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    // One scan: load once, derive stats from the same list, return the newest 500.
    const routes = await listRoutes(1000)
    const stats = await contractorStatsObject(routes)
    return NextResponse.json({ items: routes.slice(0, 500), stats })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'list failed'
    if (msg === 'UPSTASH_NOT_CONFIGURED') return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    console.error('[admin/routes GET]', err)
    return NextResponse.json({ error: 'list failed' }, { status: 500 })
  }
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({}))

  const businessName = S(body.businessName, 200)
  const reportAddress = S(body.reportAddress, 300)
  const reportTime = S(body.reportTime, 60)
  const routeDate = S(body.routeDate, 20)
  if (!businessName) return NextResponse.json({ error: 'Business/client name is required.' }, { status: 400 })
  if (!reportAddress) return NextResponse.json({ error: 'Report/pickup address is required.' }, { status: 400 })
  if (!reportTime) return NextResponse.json({ error: 'Report time is required.' }, { status: 400 })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(routeDate)) return NextResponse.json({ error: 'A valid route date is required.' }, { status: 400 })

  const now = Date.now()
  // routeNumber is claimed LAST, just before the save. nextRouteNumber() INCRs a
  // Redis counter, so allocating it up front would burn a number every time the
  // pay-exceeds-price warning is declined, leaving permanent gaps in JK-R-####.
  const route: RouteRecord = {
    token: generateToken(),
    routeNumber: '',
    status: 'draft',
    businessName,
    contactPerson: S(body.contactPerson, 120) || undefined,
    contactPhone: S(body.contactPhone, 40) || undefined,
    reportAddress,
    reportTime,
    routeDate,
    description: S(body.description, 2000) || undefined,
    payRate: S(body.payRate, 80) || undefined,
    vehicle: S(body.vehicle, 200) || 'Box truck',   // snapshot equipment name; default kept for legacy/template callers
    equipmentId: S(body.equipmentId, 80) || undefined,
    specialNotes: S(body.specialNotes, 2000) || undefined,
    events: [],
    audit: [],
    createdAt: now,
    updatedAt: now,
    createdBy: 'admin',
  }
  pushAudit(route, 'admin', `Route created for ${businessName}`)

  // Inherit the client's crew requirement (driver + helper), if set, and SNAPSHOT
  // what they pay per route. Editing the contract rate later never rewrites this.
  let biz = null
  try { biz = await getBusiness(bizKey(businessName)) } catch { /* non-fatal */ }
  if (biz?.requiresHelper) route.requiresHelper = true
  snapshotBusinessPrice(route, biz)

  // An explicit price for THIS route overrides the contract rate.
  if (body.businessPrice !== undefined && S(body.businessPrice, 40)) {
    const cents = parseMoneyCents(body.businessPrice)
    if (cents == null) return NextResponse.json({ error: 'Route price must be a positive dollar amount.' }, { status: 400 })
    snapshotManualPrice(route, cents)
  }

  // Optionally add crew (no text — the owner sends it explicitly). Accepts a
  // single staffId or a crew:[{staffId,pay}] array. `pay` is a per-person dollar
  // amount for this route; omit it to use the person's configured rate.
  const rawCrew: Array<{ staffId: string; pay?: string }> = Array.isArray(body.crew)
    ? (body.crew as unknown[]).map(c => { const o = c as Record<string, unknown>; return { staffId: S(o.staffId, 80), pay: S(o.pay, 80) || undefined } }).filter(c => c.staffId)
    : (S(body.staffId, 80) ? [{ staffId: S(body.staffId, 80), pay: S(body.crewPay, 80) || undefined }] : [])
  if (rawCrew.length) {
    const staffList = await listStaff()
    for (const c of rawCrew) {
      const staff = staffList.find(s => s.id === c.staffId)
      if (!staff) continue
      let manualCents: number | null | undefined
      if (c.pay) {
        manualCents = parseMoneyCents(c.pay)
        if (manualCents == null) return NextResponse.json({ error: `Pay for ${staff.name} must be a positive dollar amount.` }, { status: 400 })
      }
      addCrew(route, staff, manualCents)
    }
  }

  // Paying out more than the route earns is allowed, but never silently. The
  // client re-posts with acknowledgeWarning:true to confirm.
  const money = computeRouteMoney(route)
  if (payExceedsPrice(money.revenueCents, money.payoutCents) && body.acknowledgeWarning !== true) {
    return NextResponse.json({
      warning: 'pay_exceeds_price',
      message: `Crew pay (${fmtCents(money.payoutCents)}) is more than this route earns (${fmtCents(money.revenueCents ?? 0)}). Save anyway?`,
      revenueCents: money.revenueCents, payoutCents: money.payoutCents,
    }, { status: 409 })
  }

  // Past every rejection path — now claim the number and persist.
  route.routeNumber = await nextRouteNumber()
  await saveRoute(route)
  return NextResponse.json({ ok: true, route })
})
