// Claims reporting — pure aggregation over ClaimRecord[], no Redis. Mirrors
// lib/finance.computeFinance: the API route loads the records, this turns them
// into the numbers the dashboard renders.
//
// ADMIN-ONLY. Business pricing and route profit live in claim snapshots, so no
// part of this may be projected to a crew- or client-facing surface.
import { isDateStr } from './dates'
import {
  assignedCents, claimRecoveredCents, claimRemainingCents, claimWaivedCents,
  isTerminal, remainingCents, recoveredCents, unassignedCents,
  type ClaimRecord, type ClaimStatus,
} from './claims'

export type ClaimFilters = {
  start?: string        // YYYY-MM-DD, inclusive (claim date)
  end?: string
  businessKey?: string
  staffId?: string
  status?: ClaimStatus | 'all' | 'open'
}

export type ClaimGroup = {
  key: string
  label: string
  claimCount: number
  totalCents: number
  recoveredCents: number
  outstandingCents: number
}

export type ClaimTrendPoint = { month: string; claimCount: number; totalCents: number }

export type ClaimsSummary = {
  claimCount: number
  openCount: number
  closedCount: number
  thisMonthCount: number
  thisMonthCents: number

  totalCents: number            // gross value of all claims
  assignedCents: number         // charged to crew
  absorbedCents: number         // J KISS eats this
  recoveredCents: number        // actually collected from crew
  waivedCents: number
  outstandingCents: number      // still owed by crew

  averageCents: number
  largestCents: number
  largest?: { claimNumber: string; businessName: string; totalCents: number }

  byBusiness: ClaimGroup[]
  byCrew: ClaimGroup[]
  trend: ClaimTrendPoint[]      // newest last, by claim month
}

// A claim is "open" until it stops being worked: paid/closed/waived are done.
const CLOSED: ClaimStatus[] = ['paid', 'closed', 'waived']
export const isOpen = (c: ClaimRecord): boolean => !CLOSED.includes(c.status)

function matches(c: ClaimRecord, f: ClaimFilters): boolean {
  if (isDateStr(f.start) && c.claimDate < f.start) return false
  if (isDateStr(f.end) && c.claimDate > f.end) return false
  if (f.businessKey && c.businessKey !== f.businessKey) return false
  if (f.staffId && !c.assignments.some(a => a.staffId === f.staffId)) return false
  if (f.status && f.status !== 'all') {
    if (f.status === 'open') { if (!isOpen(c)) return false }
    else if (c.status !== f.status) return false
  }
  return true
}

export function computeClaimsReport(
  claims: ClaimRecord[], f: ClaimFilters = {}, now: number = Date.now(),
): ClaimsSummary {
  const rows = claims.filter(c => matches(c, f))
  const monthOf = (d: string) => d.slice(0, 7)
  const thisMonth = new Date(now).toISOString().slice(0, 7)

  let total = 0, assigned = 0, absorbed = 0, recovered = 0, waived = 0, outstanding = 0
  let openCount = 0, thisMonthCount = 0, thisMonthCents = 0
  let largest: ClaimsSummary['largest']

  const byBusiness = new Map<string, ClaimGroup>()
  const byCrew = new Map<string, ClaimGroup>()
  const trend = new Map<string, ClaimTrendPoint>()

  for (const c of rows) {
    total += c.totalCents
    assigned += assignedCents(c)
    absorbed += unassignedCents(c)
    recovered += claimRecoveredCents(c)
    waived += claimWaivedCents(c)
    outstanding += claimRemainingCents(c)
    if (isOpen(c)) openCount++
    if (monthOf(c.claimDate) === thisMonth) { thisMonthCount++; thisMonthCents += c.totalCents }
    if (!largest || c.totalCents > largest.totalCents) {
      largest = { claimNumber: c.claimNumber, businessName: c.businessName, totalCents: c.totalCents }
    }

    let bg = byBusiness.get(c.businessKey)
    if (!bg) { bg = { key: c.businessKey, label: c.businessName, claimCount: 0, totalCents: 0, recoveredCents: 0, outstandingCents: 0 }; byBusiness.set(c.businessKey, bg) }
    bg.claimCount++
    bg.totalCents += c.totalCents
    bg.recoveredCents += claimRecoveredCents(c)
    bg.outstandingCents += claimRemainingCents(c)

    // Per-crew rollup is a RESPONSIBILITY sheet: a person owns their share of the
    // claim, never the whole claim value. Summing totalCents here would double-count
    // a claim split across a driver and a helper.
    for (const a of c.assignments) {
      let g = byCrew.get(a.staffId)
      if (!g) { g = { key: a.staffId, label: a.name, claimCount: 0, totalCents: 0, recoveredCents: 0, outstandingCents: 0 }; byCrew.set(a.staffId, g) }
      g.claimCount++
      g.totalCents += a.responsibilityCents
      g.recoveredCents += recoveredCents(a)
      g.outstandingCents += remainingCents(a)
    }

    const m = monthOf(c.claimDate)
    let t = trend.get(m)
    if (!t) { t = { month: m, claimCount: 0, totalCents: 0 }; trend.set(m, t) }
    t.claimCount++
    t.totalCents += c.totalCents
  }

  return {
    claimCount: rows.length,
    openCount,
    closedCount: rows.length - openCount,
    thisMonthCount,
    thisMonthCents,
    totalCents: total,
    assignedCents: assigned,
    absorbedCents: absorbed,
    recoveredCents: recovered,
    waivedCents: waived,
    outstandingCents: outstanding,
    averageCents: rows.length ? Math.round(total / rows.length) : 0,
    largestCents: largest?.totalCents ?? 0,
    largest,
    byBusiness: [...byBusiness.values()].sort((a, b) => b.totalCents - a.totalCents),
    byCrew: [...byCrew.values()].sort((a, b) => b.outstandingCents - a.outstandingCents || b.totalCents - a.totalCents),
    trend: [...trend.values()].sort((a, b) => a.month.localeCompare(b.month)),
  }
}

// ── Per-crew view (the Employees page section) ───────────────────────────────
export type CrewClaimLine = {
  claimId: string
  claimNumber: string
  businessName: string
  routeNumber?: string
  claimDate: string
  claimStatus: ClaimStatus
  responsibilityCents: number
  recoveredCents: number
  remainingCents: number
  weeklyDeductionCents?: number
  nextDeductionOn?: string
  lastDeductionOn?: string
  assignmentStatus: string
  open: boolean
}

export type CrewClaimSummary = {
  staffId: string
  lines: CrewClaimLine[]
  openCount: number
  closedCount: number
  responsibilityCents: number
  recoveredCents: number
  outstandingCents: number
  weeklyDeductionCents: number   // sum of ACTIVE weekly deductions
}

export function crewClaimSummary(claims: ClaimRecord[], staffId: string): CrewClaimSummary {
  const lines: CrewClaimLine[] = []
  let responsibility = 0, recovered = 0, outstanding = 0, weekly = 0, openCount = 0

  for (const c of claims) {
    const a = c.assignments.find(x => x.staffId === staffId)
    if (!a) continue
    const rec = recoveredCents(a)
    const rem = remainingCents(a)
    const open = isOpen(c) || rem > 0
    responsibility += a.responsibilityCents
    recovered += rec
    outstanding += rem
    if (a.status === 'active') weekly += a.weeklyDeductionCents ?? 0
    if (open) openCount++

    lines.push({
      claimId: c.id, claimNumber: c.claimNumber, businessName: c.businessName,
      routeNumber: c.routeNumber, claimDate: c.claimDate, claimStatus: c.status,
      responsibilityCents: a.responsibilityCents,
      recoveredCents: rec, remainingCents: rem,
      weeklyDeductionCents: a.weeklyDeductionCents,
      nextDeductionOn: a.nextDeductionOn, lastDeductionOn: a.lastDeductionOn,
      assignmentStatus: a.status,
      open,
    })
  }

  lines.sort((x, y) => y.claimDate.localeCompare(x.claimDate))
  return {
    staffId, lines, openCount, closedCount: lines.length - openCount,
    responsibilityCents: responsibility, recoveredCents: recovered,
    outstandingCents: outstanding, weeklyDeductionCents: weekly,
  }
}

// ── Per-business view (the Businesses page section) ──────────────────────────
export type BusinessClaimSummary = {
  businessKey: string
  claimCount: number
  openCount: number
  closedCount: number
  totalCents: number
  averageCents: number
  largestCents: number
  outstandingCents: number
  recoveredCents: number
  claims: { id: string; claimNumber: string; claimDate: string; status: ClaimStatus; totalCents: number; outstandingCents: number; routeNumber?: string }[]
}

export function businessClaimSummary(claims: ClaimRecord[], businessKey: string): BusinessClaimSummary {
  const rows = claims.filter(c => c.businessKey === businessKey)
  let total = 0, outstanding = 0, recovered = 0, openCount = 0, largest = 0
  for (const c of rows) {
    total += c.totalCents
    outstanding += claimRemainingCents(c)
    recovered += claimRecoveredCents(c)
    if (isOpen(c)) openCount++
    if (c.totalCents > largest) largest = c.totalCents
  }
  return {
    businessKey,
    claimCount: rows.length,
    openCount,
    closedCount: rows.length - openCount,
    totalCents: total,
    averageCents: rows.length ? Math.round(total / rows.length) : 0,
    largestCents: largest,
    outstandingCents: outstanding,
    recoveredCents: recovered,
    claims: rows
      .sort((a, b) => b.claimDate.localeCompare(a.claimDate))
      .map(c => ({
        id: c.id, claimNumber: c.claimNumber, claimDate: c.claimDate, status: c.status,
        totalCents: c.totalCents, outstandingCents: claimRemainingCents(c), routeNumber: c.routeNumber,
      })),
  }
}

/** Claims still costing someone money — the dashboard's "needs attention" list. */
export const activeRecoveries = (claims: ClaimRecord[]): ClaimRecord[] =>
  claims.filter(c => !isTerminal(c.status) && claimRemainingCents(c) > 0)
