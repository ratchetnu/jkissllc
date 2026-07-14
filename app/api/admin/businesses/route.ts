import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireSession } from '../_lib/session'
import { listBusinesses, getBusiness, saveBusiness, deleteBusiness, bizKey, type Business, type RateHistoryEntry } from '../../../lib/businesses'
import { parseMoneyCents } from '../../../lib/finance'
import { repriceBusinessRoutes, repriceCandidates, isApplyTo, type ApplyTo } from '../../../lib/route-reprice'

const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)

export const GET = withTenantRoute(async (req: NextRequest) => {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
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
// (normalized) name. Admin-only — pricing never leaves this boundary.
export const POST = withTenantRoute(async (req: NextRequest) => {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
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

export const DELETE = withTenantRoute(async (req: NextRequest) => {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const key = new URL(req.url).searchParams.get('key')
  if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 })
  await deleteBusiness(key)
  return NextResponse.json({ ok: true })
})
