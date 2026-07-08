// Applying a pricing / pay change to routes that already exist.
//
// The rule that matters: a route's money is a SNAPSHOT. Editing a business's
// contract rate or a crew member's pay changes what FUTURE routes will carry —
// it never rewrites a route that already ran. Completed and cancelled routes are
// settled history and are skipped unconditionally, even if explicitly selected.
//
//   'none'      → change the rate only; touch no existing routes (the default)
//   'future'    → re-price live routes dated today or later
//   'selected'  → re-price exactly the routes the admin ticked (still not frozen ones)
import { listRoutes, saveRoute, pushAudit, type RouteRecord } from './routes'
import { getBusiness, bizKey, type Business } from './businesses'
import { snapshotBusinessPrice, snapshotCrewPay, isFrozen, fmtCents } from './finance'
import type { Staff } from './staff'

export type ApplyTo = 'none' | 'future' | 'selected'

export const isApplyTo = (v: unknown): v is ApplyTo => v === 'none' || v === 'future' || v === 'selected'

// Today in Central — the calendar day the business actually runs on, so a route
// dated today still counts as "future" until it's marked complete.
const centralToday = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date())

export type RepriceResult = {
  updated: { routeNumber: string; token: string }[]
  skippedFrozen: number      // completed/cancelled routes deliberately left alone
}

// Which routes an apply-mode selects. Frozen routes are filtered out here so no
// caller can accidentally rewrite settled money.
function targets(all: RouteRecord[], applyTo: ApplyTo, routeTokens: string[]): { pick: RouteRecord[]; skippedFrozen: number } {
  if (applyTo === 'none') return { pick: [], skippedFrozen: 0 }
  const today = centralToday()
  const wanted = applyTo === 'selected'
    ? all.filter(r => routeTokens.includes(r.token))
    : all.filter(r => r.routeDate >= today)
  const pick = wanted.filter(r => !isFrozen(r))
  return { pick, skippedFrozen: wanted.length - pick.length }
}

// Re-stamp the client's (already-saved) contract rate onto their live routes.
export async function repriceBusinessRoutes(
  businessName: string, applyTo: ApplyTo, routeTokens: string[] = [],
): Promise<RepriceResult> {
  if (applyTo === 'none') return { updated: [], skippedFrozen: 0 }

  const key = bizKey(businessName)
  const biz: Business | null = await getBusiness(key)
  const all = (await listRoutes(2000)).filter(r => bizKey(r.businessName) === key)
  const { pick, skippedFrozen } = targets(all, applyTo, routeTokens)

  const updated: RepriceResult['updated'] = []
  for (const r of pick) {
    const before = r.financials?.businessPriceCents
    snapshotBusinessPrice(r, biz)
    const after = r.financials?.businessPriceCents
    if (before === after) continue
    pushAudit(r, 'admin', `Route price updated to ${after == null ? 'no rate' : fmtCents(after)} (contract rate changed)`)
    try { await saveRoute(r); updated.push({ routeNumber: r.routeNumber, token: r.token }) }
    catch { /* one bad write shouldn't abort the rest */ }
  }
  return { updated, skippedFrozen }
}

// Re-stamp a crew member's (already-saved) pay onto the live routes they're on.
// Only touches THIS person's assignee row; other crew keep their own snapshots.
// A pay explicitly typed in for one route (paySource 'manual') is left alone —
// the admin overrode the rate on purpose.
export async function repriceCrewRoutes(
  staff: Staff, applyTo: ApplyTo, routeTokens: string[] = [],
): Promise<RepriceResult> {
  if (applyTo === 'none') return { updated: [], skippedFrozen: 0 }

  const all = (await listRoutes(2000)).filter(r => (r.assignees ?? []).some(a => a.staffId === staff.id))
  const { pick, skippedFrozen } = targets(all, applyTo, routeTokens)

  const updated: RepriceResult['updated'] = []
  for (const r of pick) {
    const a = (r.assignees ?? []).find(x => x.staffId === staff.id)
    if (!a || a.paySource === 'manual') continue
    const before = a.payCents
    // Clear the snapshot so snapshotCrewPay re-resolves from the new settings.
    a.payCents = undefined
    a.paySource = undefined
    snapshotCrewPay(a, staff, r.businessName)
    if (before === a.payCents) continue
    pushAudit(r, 'admin', `${a.name}'s pay updated to ${a.payCents == null ? 'no rate' : fmtCents(a.payCents)} (pay settings changed)`)
    try { await saveRoute(r); updated.push({ routeNumber: r.routeNumber, token: r.token }) }
    catch { /* keep going */ }
  }
  return { updated, skippedFrozen }
}

// Live routes an admin could choose from when picking "selected" — what the UI
// lists with checkboxes. Frozen routes are excluded because they're never valid
// targets.
export async function repriceCandidates(opts: { businessName?: string; staffId?: string }): Promise<
  { token: string; routeNumber: string; routeDate: string; businessName: string; status: string; currentPriceCents?: number; currentPayCents?: number }[]
> {
  const today = centralToday()
  const all = await listRoutes(2000)
  return all
    .filter(r => !isFrozen(r) && r.routeDate >= today)
    .filter(r => (opts.businessName ? bizKey(r.businessName) === bizKey(opts.businessName) : true))
    .filter(r => (opts.staffId ? (r.assignees ?? []).some(a => a.staffId === opts.staffId) : true))
    .sort((a, b) => a.routeDate.localeCompare(b.routeDate) || a.routeNumber.localeCompare(b.routeNumber))
    .map(r => ({
      token: r.token, routeNumber: r.routeNumber, routeDate: r.routeDate,
      businessName: r.businessName, status: r.status,
      currentPriceCents: r.financials?.businessPriceCents,
      currentPayCents: opts.staffId ? (r.assignees ?? []).find(a => a.staffId === opts.staffId)?.payCents : undefined,
    }))
}
