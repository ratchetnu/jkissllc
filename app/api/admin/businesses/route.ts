import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import { listBusinesses, getBusiness, saveBusiness, deleteBusiness, bizKey, type Business, type RateHistoryEntry } from '../../../lib/businesses'
import { endBusinessContract, isFutureContractRoute, reopenBusinessContract, routeScanFetchSize } from '../../../lib/business-contract-lifecycle'
import { parseMoneyCents } from '../../../lib/finance'
import { repriceBusinessRoutes, repriceCandidates, isApplyTo, type ApplyTo } from '../../../lib/route-reprice'
import { centralToday } from '../../../lib/dates'
import { listRoutes, getRouteByToken, pushAuditFor, saveRoute } from '../../../lib/routes'
import { withRouteLock } from '../../../lib/route-mutex'
import { listTemplates, saveTemplate } from '../../../lib/route-templates'

const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'businesses:manage')
  if (who instanceof NextResponse) return who
  try {
    // ?candidates=<business name> lists the live routes a rate change could apply
    // to, so the UI can offer "apply to selected upcoming routes".
    const candidatesFor = new URL(req.url).searchParams.get('candidates')
    if (candidatesFor) return NextResponse.json({ items: await repriceCandidates({ businessName: candidatesFor }) })
    return NextResponse.json({ items: await listBusinesses() })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'list failed'
    if (msg === 'UPSTASH_NOT_CONFIGURED') return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    return NextResponse.json({ error: 'list failed' }, { status: 500 })
  }
})

// Upsert a business's editable details + its route contract rate, keyed by its
// (normalized) name. Gated on businesses:manage (admin + manager); the public
// route projection never exposes this pricing.
export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'businesses:manage')
  if (who instanceof NextResponse) return who
  const b = await req.json().catch(() => ({}))
  const name = S(b.name, 200)
  if (!name) return NextResponse.json({ error: 'Business name is required.' }, { status: 400 })

  const key = bizKey(name)
  const existing = await getBusiness(key)
  const now = Date.now()

  // ── Contract rate ──
  // `contractRate` is a dollar amount typed by the admin. Absent = leave as-is;
  // empty string = clear the rate. Negative/garbage is rejected, not coerced.
  let contractRateCents = existing?.contractRateCents
  let rateChanged = false
  if (b.contractRate !== undefined) {
    const raw = S(b.contractRate, 40)
    if (!raw) {
      rateChanged = contractRateCents !== undefined
      contractRateCents = undefined
    } else {
      const cents = parseMoneyCents(raw)
      if (cents == null) return NextResponse.json({ error: 'Route price must be a positive dollar amount (e.g. 350 or $350.00).' }, { status: 400 })
      rateChanged = cents !== contractRateCents
      contractRateCents = cents
    }
  }

  const pricingActive = typeof b.pricingActive === 'boolean' ? b.pricingActive : (existing?.pricingActive ?? true)
  if (pricingActive && contractRateCents === undefined && b.contractRate !== undefined) {
    return NextResponse.json({ error: 'Set a route price, or mark this pricing inactive.' }, { status: 400 })
  }

  const rateEffectiveDate = b.rateEffectiveDate !== undefined
    ? (isDate(S(b.rateEffectiveDate, 20)) ? S(b.rateEffectiveDate, 20) : undefined)
    : existing?.rateEffectiveDate
  const billingNotes = b.billingNotes !== undefined ? (S(b.billingNotes, 1000) || undefined) : existing?.billingNotes

  const activeChanged = existing ? (existing.pricingActive ?? true) !== pricingActive : false
  const history: RateHistoryEntry[] = [...(existing?.rateHistory ?? [])]
  if (rateChanged || activeChanged) {
    history.push({ at: now, contractRateCents, effectiveDate: rateEffectiveDate, active: pricingActive, notes: billingNotes })
    if (history.length > 50) history.splice(0, history.length - 50)
  }

  const rec: Business = {
    key, name,
    stableId: existing?.stableId,
    contactName: S(b.contactName, 160) || undefined,
    contactPhone: S(b.contactPhone, 40) || undefined,
    contactEmail: S(b.contactEmail, 200) || undefined,
    address: S(b.address, 300) || undefined,
    notes: S(b.notes, 1000) || undefined,
    requiresHelper: typeof b.requiresHelper === 'boolean' ? b.requiresHelper : existing?.requiresHelper,
    contractRateCents,
    billingNotes,
    rateEffectiveDate,
    pricingActive,
    rateHistory: history.length ? history : undefined,
    contractEndedAt: existing?.contractEndedAt,
    contractEndReason: existing?.contractEndReason,
    contractEndedBy: existing?.contractEndedBy,
    contractEndedByRole: existing?.contractEndedByRole,
    pricingActiveBeforeContractEnd: existing?.pricingActiveBeforeContractEnd,
    contractHistory: existing?.contractHistory,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await saveBusiness(rec)

  // ── Apply the new rate to routes that already exist ──
  // Default 'none': the rate changes going forward and nothing already on the
  // board moves. Completed routes are never touched, whatever is requested.
  let reprice = null
  if (rateChanged || activeChanged) {
    const applyTo: ApplyTo = isApplyTo(b.applyTo) ? b.applyTo : 'none'
    const tokens = Array.isArray(b.routeTokens) ? (b.routeTokens as unknown[]).filter((t): t is string => typeof t === 'string') : []
    try { reprice = await repriceBusinessRoutes(name, applyTo, tokens) }
    catch { reprice = null /* the rate saved; re-pricing is best-effort */ }
  }

  return NextResponse.json({ ok: true, business: rec, reprice })
})

export const PATCH = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'businesses:manage')
  if (who instanceof NextResponse) return who
  const routesWho = await requirePermission(req, 'routes:manage')
  if (routesWho instanceof NextResponse) return routesWho
  const recurringWho = await requirePermission(req, 'recurring:manage')
  if (recurringWho instanceof NextResponse) return recurringWho

  const body = await req.json().catch(() => ({}))
  const action = S(body.action, 40)
  const name = S(body.businessName, 200)
  const key = S(body.businessKey, 220) || (name ? bizKey(name) : '')
  if (!key) return NextResponse.json({ error: 'Business is required.' }, { status: 400 })
  if (name && key !== bizKey(name)) return NextResponse.json({ error: 'Business identity does not match its name.' }, { status: 409 })

  if (action === 'reopen_contract') {
    const business = await getBusiness(key)
    if (!business) return NextResponse.json({ error: 'Business record not found.' }, { status: 404 })
    const reopened = await reopenBusinessContract(business, who, Date.now(), saveBusiness)
    return NextResponse.json({
      ok: true,
      business: reopened,
      warning: 'Recurring schedules and cancelled operations were not restarted.',
    })
  }

  if (action !== 'end_contract') return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
  if (!name) return NextResponse.json({ error: 'Business name is required.' }, { status: 400 })

  const now = Date.now()
  const today = centralToday(now)
  const input = {
    businessKey: key,
    businessName: name,
    reason: S(body.reason, 500) || undefined,
    now,
    today,
    actor: who,
  }

  const result = await endBusinessContract(input, {
    getBusiness,
    saveBusiness,
    // Fetch one beyond the supported completeness boundary, from the SAME source of
    // truth as the limit itself. If that extra record exists the lifecycle service
    // refuses to archive rather than silently leave older live work behind an ended
    // contract. The limit is the service's fail-closed default, so it is not repeated
    // here — the two numbers can no longer drift apart.
    listRoutes: () => listRoutes(routeScanFetchSize()),
    listTemplates: () => listTemplates(500),
    saveTemplate,
    cancelRoute: async (token, contractInput) => {
      return withRouteLock(token, async () => {
        const route = await getRouteByToken(token)
        if (!route || !isFutureContractRoute(route, contractInput.businessKey, contractInput.today)) return 'skipped'
        const from = route.status
        route.status = 'cancelled'
        pushAuditFor(route, contractInput.actor, contractInput.actor.role, 'Contract ended — operation cancelled', {
          from,
          to: 'cancelled',
          note: contractInput.reason,
        })
        await saveRoute(route)
        return 'cancelled'
      })
    },
  })

  if (!result.ok) {
    const error = result.incompleteReason
      ?? (result.failedTemplates.length
        ? `The contract was not archived because ${result.failedTemplates.length} recurring schedule${result.failedTemplates.length === 1 ? '' : 's'} could not be paused. Retry to finish.`
        : `The contract was not archived because ${result.failedRoutes.length} operation${result.failedRoutes.length === 1 ? '' : 's'} could not be cancelled. Retry to finish.`)
    return NextResponse.json({
      error,
      ...result,
    }, { status: 409 })
  }
  return NextResponse.json(result)
})

export const DELETE = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'businesses:manage')
  if (who instanceof NextResponse) return who
  const key = new URL(req.url).searchParams.get('key')
  if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 })
  await deleteBusiness(key)
  return NextResponse.json({ ok: true })
})
