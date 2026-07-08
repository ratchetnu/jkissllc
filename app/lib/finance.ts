// Route money — what a business pays J KISS per route, what each crew member is
// paid, and the profit between them. Admin-only: none of this may ever reach the
// public confirmation page (see toPublicRouteFor in lib/routes).
//
// Contract model: each business has ONE contract rate per route. Crew pay is a
// per-person default with optional per-business overrides. Both are SNAPSHOTTED
// onto the route when it's created/assigned, so editing a rate later never
// rewrites the history of routes already run.
//
// Money is stored as integer cents everywhere. The legacy free-text fields
// (route.payRate, assignee.pay) are kept in sync for display + back-compat with
// route-pay.ts / route-invoices.ts, which parse them with a regex.
import { redis } from './redis'
import { bizKey, type Business } from './businesses'
import { listStaff, type Staff } from './staff'
import type { RouteRecord, RouteStatus, Assignee } from './routes'

// ── Money ────────────────────────────────────────────────────────────────────
// Parse a user-entered DOLLAR amount into integer cents. Returns null for blank,
// malformed, or negative input — callers turn null into a validation error.
// Numbers are treated as dollars (17500 cents is never passed in as a number).
export function parseMoneyCents(input: unknown): number | null {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) return null
    return Math.round(input * 100)
  }
  if (typeof input !== 'string') return null
  const s = input.trim()
  if (!s) return null
  if (s.includes('-')) return null                       // no negative amounts
  const cleaned = s.replace(/[$,\s]/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null    // no "175/route", no "abc"
  const n = Number(cleaned)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

export function fmtCents(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

// Cents → the free-text form the legacy fields expect ("$175.00"). parsePayCents()
// in route-pay.ts reads this back correctly.
export const centsToLegacy = (cents: number): string => fmtCents(cents)

// ── Settings ─────────────────────────────────────────────────────────────────
const SETTINGS_KEY = 'settings:finance'

export type FinanceSettings = {
  showPayInConfirm: boolean   // include the crew member's own pay in their text + confirm page
}
const SETTINGS_DEFAULT: FinanceSettings = { showPayInConfirm: true }

export async function getFinanceSettings(): Promise<FinanceSettings> {
  try {
    const raw = await redis.get(SETTINGS_KEY)
    if (raw) return { ...SETTINGS_DEFAULT, ...(JSON.parse(raw) as Partial<FinanceSettings>) }
  } catch { /* fall back to defaults */ }
  return SETTINGS_DEFAULT
}

export async function setFinanceSettings(patch: Partial<FinanceSettings>): Promise<FinanceSettings> {
  const next: FinanceSettings = { ...(await getFinanceSettings()), ...patch }
  await redis.set(SETTINGS_KEY, JSON.stringify(next))
  return next
}

// ── Resolution ───────────────────────────────────────────────────────────────
// What this business pays per route, or null if no active contract rate is set.
export function resolveBusinessPrice(biz: Business | null | undefined): number | null {
  if (!biz) return null
  if (biz.pricingActive === false) return null
  const c = biz.contractRateCents
  return typeof c === 'number' && Number.isFinite(c) && c >= 0 ? c : null
}

export type PaySource = 'crew_business' | 'crew_default' | 'manual'

// What this crew member is paid for a route at this business. A per-business
// override beats their default. Returns null when neither is set.
export function resolveCrewPay(
  staff: Pick<Staff, 'defaultPayCents' | 'payByBusiness' | 'payActive'> | null | undefined,
  businessName: string,
): { cents: number; source: PaySource } | null {
  if (!staff || staff.payActive === false) return null
  const override = staff.payByBusiness?.[bizKey(businessName)]
  if (typeof override === 'number' && Number.isFinite(override) && override >= 0) {
    return { cents: override, source: 'crew_business' }
  }
  const def = staff.defaultPayCents
  if (typeof def === 'number' && Number.isFinite(def) && def >= 0) {
    return { cents: def, source: 'crew_default' }
  }
  return null
}

// ── Per-route math ───────────────────────────────────────────────────────────
// A crew member who DECLINED isn't paid, so they don't count against profit.
// This mirrors computePay() in route-pay.ts, which skips declined assignees too.
export const payableCrew = (r: Pick<RouteRecord, 'assignees'>): Assignee[] =>
  (r.assignees ?? []).filter(a => !a.declinedAt)

export type RouteMoney = {
  revenueCents: number | null    // null = this route has no contract price recorded
  payoutCents: number            // sum of payable crew pay that IS priced
  profitCents: number | null     // null when revenue is unknown
  unpricedCrew: number           // payable crew with no pay recorded
}

export function computeRouteMoney(r: RouteRecord): RouteMoney {
  const revenueCents = r.financials?.businessPriceCents ?? null
  let payoutCents = 0
  let unpricedCrew = 0
  for (const a of payableCrew(r)) {
    if (typeof a.payCents === 'number' && Number.isFinite(a.payCents)) payoutCents += a.payCents
    else unpricedCrew++
  }
  return {
    revenueCents,
    payoutCents,
    profitCents: revenueCents == null ? null : revenueCents - payoutCents,
    unpricedCrew,
  }
}

// Validation warning (not an error): paying out more than the route brings in.
// The admin may still save — some routes legitimately run at a loss.
export function payExceedsPrice(revenueCents: number | null, payoutCents: number): boolean {
  return revenueCents != null && payoutCents > revenueCents
}

// ── Snapshotting ─────────────────────────────────────────────────────────────
// Stamp the business contract price onto a route. Called at create time and by an
// explicit re-price; NEVER called for a completed/cancelled route.
export function snapshotBusinessPrice(r: RouteRecord, biz: Business | null | undefined): void {
  const cents = resolveBusinessPrice(biz)
  r.financials = {
    businessPriceCents: cents ?? undefined,
    priceSource: cents == null ? 'none' : 'contract',
    snapshotAt: Date.now(),
  }
}

// Stamp a manual (typed-in) price, overriding the contract rate for this route.
export function snapshotManualPrice(r: RouteRecord, cents: number): void {
  r.financials = { businessPriceCents: cents, priceSource: 'manual', snapshotAt: Date.now() }
}

// Stamp one crew member's pay. `manual` wins over the crew's configured rate, and
// keeps assignee.pay (free text) in sync so route-pay.ts keeps working.
export function snapshotCrewPay(
  a: Assignee,
  staff: Pick<Staff, 'defaultPayCents' | 'payByBusiness' | 'payActive'> | undefined,
  businessName: string,
  manualCents?: number | null,
): void {
  if (typeof manualCents === 'number') {
    a.payCents = manualCents
    a.paySource = 'manual'
    a.pay = centsToLegacy(manualCents)
    return
  }
  const resolved = resolveCrewPay(staff, businessName)
  if (resolved) {
    a.payCents = resolved.cents
    a.paySource = resolved.source
    a.pay = centsToLegacy(resolved.cents)
  }
  // No rate anywhere → leave payCents undefined; the route shows as "unpriced crew".
}

// A route whose money is settled history. Re-pricing these is never automatic.
const FROZEN: RouteStatus[] = ['completed', 'cancelled']
export const isFrozen = (r: Pick<RouteRecord, 'status'>): boolean => FROZEN.includes(r.status)

// ── Dashboard reporting ──────────────────────────────────────────────────────
export type FinanceFilters = {
  start?: string          // YYYY-MM-DD, inclusive (route date)
  end?: string            // YYYY-MM-DD, inclusive
  business?: string       // business name (case-insensitive)
  staffId?: string        // only routes this person is payable on
  status?: string         // a RouteStatus, or 'all'
}

export type FinanceRouteLine = {
  token: string
  routeNumber: string
  routeDate: string
  businessName: string
  status: RouteStatus
  revenueCents: number | null
  payoutCents: number
  profitCents: number | null
  unpricedCrew: number
  crew: { staffId: string; name: string; role?: string; payCents?: number }[]
}

export type FinanceGroup = {
  key: string
  label: string
  routeCount: number
  revenueCents: number
  payoutCents: number
  profitCents: number
}

export type FinanceSummary = {
  filters: Required<Pick<FinanceFilters, 'status'>> & FinanceFilters
  routeCount: number
  revenueCents: number
  payoutCents: number
  driverPayoutCents: number
  helperPayoutCents: number
  otherPayoutCents: number
  profitCents: number
  unpricedRoutes: number        // routes with no contract price recorded
  unpricedCrewRoutes: number    // routes with at least one crew member missing pay
  byBusiness: FinanceGroup[]
  byCrew: FinanceGroup[]
  routes: FinanceRouteLine[]
}

// Which payout bucket a crew member falls in. `payKind` of driver/helper is a
// direct answer; contractor/employee describe employment type, not the job, so
// those fall through to the role stamped on the route.
function bucketOf(payKind: Staff['payKind'] | undefined, role: string | undefined): 'driver' | 'helper' | 'other' {
  if (payKind === 'driver') return 'driver'
  if (payKind === 'helper') return 'helper'
  const r = (role || '').toLowerCase()
  if (r.includes('driver')) return 'driver'
  if (r.includes('helper')) return 'helper'
  return 'other'
}

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)

// Cancelled routes are excluded from every total unless explicitly asked for —
// they earn nothing and pay nothing.
export function computeFinance(routes: RouteRecord[], staff: Staff[], f: FinanceFilters = {}): FinanceSummary {
  const status = f.status && f.status.trim() ? f.status.trim() : 'all'
  const bizFilter = f.business?.trim().toLowerCase()
  const staffById = new Map(staff.map(s => [s.id, s]))

  const lines: FinanceRouteLine[] = []
  let revenue = 0, payout = 0, driverPay = 0, helperPay = 0, otherPay = 0
  let unpricedRoutes = 0, unpricedCrewRoutes = 0
  const byBusiness = new Map<string, FinanceGroup>()
  const byCrew = new Map<string, FinanceGroup>()

  for (const r of routes) {
    if (status === 'all' ? r.status === 'cancelled' : r.status !== status) continue
    if (isDate(f.start) && r.routeDate < f.start) continue
    if (isDate(f.end) && r.routeDate > f.end) continue
    if (bizFilter && r.businessName.trim().toLowerCase() !== bizFilter) continue

    const crew = payableCrew(r)
    if (f.staffId && !crew.some(a => a.staffId === f.staffId)) continue

    const m = computeRouteMoney(r)
    revenue += m.revenueCents ?? 0
    payout += m.payoutCents
    if (m.revenueCents == null) unpricedRoutes++
    if (m.unpricedCrew > 0) unpricedCrewRoutes++

    // Payout buckets + per-crew rollup
    for (const a of crew) {
      const cents = typeof a.payCents === 'number' ? a.payCents : 0
      const bucket = bucketOf(staffById.get(a.staffId)?.payKind, a.role)
      if (bucket === 'driver') driverPay += cents
      else if (bucket === 'helper') helperPay += cents
      else otherPay += cents

      // Per-crew rollup is a COST sheet: only routeCount + payoutCents are
      // meaningful. A person doesn't own a share of revenue, so revenue/profit
      // stay zero here rather than carrying a number that means nothing.
      let g = byCrew.get(a.staffId)
      if (!g) { g = { key: a.staffId, label: staffById.get(a.staffId)?.name || a.name, routeCount: 0, revenueCents: 0, payoutCents: 0, profitCents: 0 }; byCrew.set(a.staffId, g) }
      g.routeCount++
      g.payoutCents += cents
    }

    const bk = r.businessName.trim().toLowerCase()
    let bg = byBusiness.get(bk)
    if (!bg) { bg = { key: bk, label: r.businessName.trim(), routeCount: 0, revenueCents: 0, payoutCents: 0, profitCents: 0 }; byBusiness.set(bk, bg) }
    bg.routeCount++
    bg.revenueCents += m.revenueCents ?? 0
    bg.payoutCents += m.payoutCents
    bg.profitCents += m.profitCents ?? 0

    lines.push({
      token: r.token, routeNumber: r.routeNumber, routeDate: r.routeDate,
      businessName: r.businessName, status: r.status,
      revenueCents: m.revenueCents, payoutCents: m.payoutCents, profitCents: m.profitCents,
      unpricedCrew: m.unpricedCrew,
      crew: crew.map(a => ({ staffId: a.staffId, name: a.name, role: a.role, payCents: a.payCents })),
    })
  }

  lines.sort((a, b) => b.routeDate.localeCompare(a.routeDate) || a.routeNumber.localeCompare(b.routeNumber))
  return {
    filters: { ...f, status },
    routeCount: lines.length,
    revenueCents: revenue,
    payoutCents: payout,
    driverPayoutCents: driverPay,
    helperPayoutCents: helperPay,
    otherPayoutCents: otherPay,
    profitCents: revenue - payout,
    unpricedRoutes,
    unpricedCrewRoutes,
    byBusiness: [...byBusiness.values()].sort((a, b) => b.profitCents - a.profitCents),
    byCrew: [...byCrew.values()].sort((a, b) => b.payoutCents - a.payoutCents),
    routes: lines,
  }
}

// Convenience wrapper for the API route.
export async function loadFinance(routes: RouteRecord[], f: FinanceFilters): Promise<FinanceSummary> {
  return computeFinance(routes, await listStaff(), f)
}
