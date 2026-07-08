// Customer damage claims + crew cost recovery — data layer (Upstash Redis).
//
// Shape mirrors lib/routes: one JSON blob per claim keyed by a CSPRNG token, a
// sorted-set index, an append-only audit trail, and pure mutators that the API
// routes call. A claim is the AGGREGATE ROOT — responsibility per crew member and
// the money ledger live inside it, exactly as assignees + audit live inside a
// RouteRecord. That keeps every read of a claim consistent with no joins.
//
// MONEY: integer cents everywhere, parsed by lib/finance.parseMoneyCents (the one
// definition of a valid amount). Nothing here is ever projected onto the public
// confirmation page — see the leakage rules on ClaimSnapshot.
//
// SNAPSHOT: a claim freezes what the route earned, what the crew were paid, and
// who the crew were, AT CLAIM TIME. Re-pricing a business or re-crewing a route
// later must never rewrite a claim's history. Same philosophy as RouteFinancials.
import { redis } from './redis'
import { addDaysStr, centralToday, isDateStr, mondayOf } from './dates'
import { bizKey, type Business } from './businesses'
import { computeRouteMoney } from './finance'
import { generateToken, type RouteRecord } from './routes'

// ── Status ───────────────────────────────────────────────────────────────────
export type ClaimStatus =
  | 'new' | 'under_review' | 'waiting_customer' | 'disputed' | 'approved'
  | 'deduction_active' | 'paid' | 'closed' | 'waived'

export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  new: 'New',
  under_review: 'Under Review',
  waiting_customer: 'Waiting on Customer',
  disputed: 'Disputed',
  approved: 'Approved',
  deduction_active: 'Deduction Active',
  paid: 'Paid',
  closed: 'Closed',
  waived: 'Waived',
}

// An admin has explicitly ended this claim. Nothing auto-transitions out of these.
const TERMINAL: ClaimStatus[] = ['closed', 'waived']
export const isTerminal = (s: ClaimStatus): boolean => TERMINAL.includes(s)

export type ClaimType =
  | 'property_damage' | 'vehicle_damage' | 'cargo_damage' | 'lost_item'
  | 'injury' | 'service_failure' | 'other'

export const CLAIM_TYPE_LABEL: Record<ClaimType, string> = {
  property_damage: 'Property Damage',
  vehicle_damage: 'Vehicle Damage',
  cargo_damage: 'Cargo Damage',
  lost_item: 'Lost / Missing Item',
  injury: 'Injury',
  service_failure: 'Service Failure',
  other: 'Other',
}

export type ResponsibilityStatus = 'pending' | 'active' | 'paused' | 'completed' | 'waived'

// ── Ledger ───────────────────────────────────────────────────────────────────
// Append-only money history for ONE crew member's responsibility. Never mutated
// or deleted: a mistake is corrected with a compensating entry, so the arithmetic
// and the story always agree.
//
// direction:
//   credit → reduces what they still owe (a deduction taken, cash paid, forgiven)
//   debit  → increases it (correcting an over-credit)
export type LedgerKind = 'scheduled' | 'payment' | 'waiver' | 'adjustment'
export type LedgerEntry = {
  id: string
  at: number
  kind: LedgerKind
  direction: 'credit' | 'debit'
  amountCents: number          // always positive; `direction` carries the sign
  periodDate: string           // YYYY-MM-DD the money belongs to (the pay week for 'scheduled')
  note?: string
  actor: string                // 'admin' | 'system' | 'cron'
}

// Money actually recovered from the crew member. A waiver forgives a balance —
// it must never be counted as recovered, or the reporting would claim revenue
// that never existed.
const RECOVERING: LedgerKind[] = ['scheduled', 'payment']

// ── Responsibility ───────────────────────────────────────────────────────────
export type ClaimAssignment = {
  staffId: string
  name: string
  role?: string

  responsibilityCents: number   // their share of the claim
  responsibilityPct?: number    // how the share was derived; display only

  weeklyDeductionCents?: number // 0/undefined = no schedule, balance sits open
  startDate?: string            // YYYY-MM-DD the schedule starts
  endDate?: string              // set when they finish paying / are waived
  nextDeductionOn?: string
  lastDeductionOn?: string

  status: ResponsibilityStatus
  pausedAt?: number
  pausedReason?: string
  waivedAt?: number
  waivedReason?: string

  ledger: LedgerEntry[]
}

// ── Attachments + audit ──────────────────────────────────────────────────────
export type AttachmentKind = 'photo' | 'video' | 'document'
export type ClaimAttachment = {
  id: string
  kind: AttachmentKind
  url: string
  name?: string
  addedAt: number
  addedBy: string
  // Attachments are soft-deleted: the evidence trail of a claim shouldn't be
  // silently rewritable. The UI hides these; the audit records who removed them.
  removedAt?: number
  removedBy?: string
}

export type ClaimAudit = {
  at: number
  actor: string
  action: string
  note?: string
}

// ── Snapshot (frozen at claim time) ──────────────────────────────────────────
// ADMIN-ONLY. Contains what the client pays and the crew's pay. This type must
// never be reachable from lib/routes.toPublicRouteFor — claims are not attached
// to RouteRecord at all, they only reference a route by token, which is what keeps
// that impossible rather than merely unlikely.
export type ClaimSnapshot = {
  at: number
  businessKey: string
  businessName: string
  businessContactName?: string
  businessContactPhone?: string
  businessPriceCents?: number          // what the client paid for the route
  priceSource?: 'contract' | 'manual' | 'none'
  routeToken?: string
  routeNumber?: string
  routeDate?: string
  reportAddress?: string
  routePayoutCents?: number            // total crew pay on the route
  routeProfitCents?: number | null
  crew: { staffId: string; name: string; role?: string; payCents?: number }[]
}

export type ClaimRecord = {
  id: string
  claimNumber: string                  // JK-C-1001
  status: ClaimStatus
  claimType: ClaimType

  businessKey: string
  businessName: string
  routeToken?: string
  routeNumber?: string

  claimDate: string                    // YYYY-MM-DD the damage happened
  reportedDate: string                 // YYYY-MM-DD the client told us
  description: string
  totalCents: number

  attachments: ClaimAttachment[]
  internalNotes?: string               // never leaves the admin UI
  businessContact?: string
  resolutionNotes?: string
  closedAt?: number

  assignments: ClaimAssignment[]
  snapshot: ClaimSnapshot
  audit: ClaimAudit[]

  createdAt: number
  updatedAt: number
}

// ── Pure money math ──────────────────────────────────────────────────────────
export const creditedCents = (a: Pick<ClaimAssignment, 'ledger'>): number =>
  a.ledger.reduce((s, e) => s + (e.direction === 'credit' ? e.amountCents : -e.amountCents), 0)

/** What this person still owes. Never negative — an over-credit is 0, not a refund. */
export const remainingCents = (a: Pick<ClaimAssignment, 'responsibilityCents' | 'ledger'>): number =>
  Math.max(0, a.responsibilityCents - creditedCents(a))

/** Money actually collected (deductions taken + cash paid). Waivers excluded. */
export const recoveredCents = (a: Pick<ClaimAssignment, 'ledger'>): number =>
  a.ledger.reduce((s, e) => s + (RECOVERING.includes(e.kind) && e.direction === 'credit' ? e.amountCents : 0), 0)

export const waivedCents = (a: Pick<ClaimAssignment, 'ledger'>): number =>
  a.ledger.reduce((s, e) => s + (e.kind === 'waiver' && e.direction === 'credit' ? e.amountCents : 0), 0)

export const assignedCents = (c: Pick<ClaimRecord, 'assignments'>): number =>
  c.assignments.reduce((s, a) => s + a.responsibilityCents, 0)

export const claimRemainingCents = (c: Pick<ClaimRecord, 'assignments'>): number =>
  c.assignments.reduce((s, a) => s + remainingCents(a), 0)

export const claimRecoveredCents = (c: Pick<ClaimRecord, 'assignments'>): number =>
  c.assignments.reduce((s, a) => s + recoveredCents(a), 0)

export const claimWaivedCents = (c: Pick<ClaimRecord, 'assignments'>): number =>
  c.assignments.reduce((s, a) => s + waivedCents(a), 0)

/** The part of the claim J KISS absorbs: never charged to anyone. */
export const unassignedCents = (c: Pick<ClaimRecord, 'totalCents' | 'assignments'>): number =>
  Math.max(0, c.totalCents - assignedCents(c))

// ── Responsibility allocation ────────────────────────────────────────────────
export type SplitMode = 'equal' | 'percent' | 'dollar'
export type SplitInput = { staffId: string; value?: number }   // percent (0-100) or dollar cents

/**
 * Divide `totalCents` across crew. Cents, not floats: an equal 3-way split of
 * $100 is 3334/3333/3333, never 33.33 × 3 = $99.99 with a penny unaccounted for.
 * The remainder lands on the earliest members, deterministically.
 *
 * Under-allocating is allowed (J KISS absorbs the rest). Over-allocating is not.
 */
export function allocate(
  totalCents: number, mode: SplitMode, members: SplitInput[],
): { ok: true; cents: Record<string, number> } | { ok: false; error: string } {
  if (!Number.isInteger(totalCents) || totalCents < 0) return { ok: false, error: 'Claim amount must be a positive dollar amount.' }
  if (!members.length) return { ok: false, error: 'Pick at least one crew member.' }
  if (new Set(members.map(m => m.staffId)).size !== members.length) return { ok: false, error: 'The same person is listed twice.' }

  const cents: Record<string, number> = {}

  if (mode === 'equal') {
    const base = Math.floor(totalCents / members.length)
    let rem = totalCents - base * members.length
    for (const m of members) { cents[m.staffId] = base + (rem-- > 0 ? 1 : 0) }
    return { ok: true, cents }
  }

  if (mode === 'percent') {
    let pctTotal = 0
    for (const m of members) {
      const p = m.value ?? 0
      if (!Number.isFinite(p) || p < 0) return { ok: false, error: 'Percentages must be zero or more.' }
      pctTotal += p
    }
    if (pctTotal > 100.0001) return { ok: false, error: `Responsibility adds up to ${pctTotal}% — it can't exceed 100%.` }
    let used = 0
    members.forEach((m, i) => {
      // Last member takes the rounding remainder so the parts sum exactly.
      const isLast = i === members.length - 1 && Math.abs(pctTotal - 100) < 0.0001
      const c = isLast ? totalCents - used : Math.round(totalCents * (m.value ?? 0) / 100)
      cents[m.staffId] = c
      used += c
    })
    return { ok: true, cents }
  }

  // dollar: explicit cents per person
  let sum = 0
  for (const m of members) {
    const c = m.value ?? 0
    if (!Number.isInteger(c) || c < 0) return { ok: false, error: 'Each amount must be a positive dollar amount.' }
    cents[m.staffId] = c
    sum += c
  }
  if (sum > totalCents) {
    return { ok: false, error: `Assigned responsibility (${(sum / 100).toFixed(2)}) is more than the claim itself (${(totalCents / 100).toFixed(2)}).` }
  }
  return { ok: true, cents }
}

// ── Status rollup ────────────────────────────────────────────────────────────
// Only ever moves a claim along the recovery track. An admin who set the claim to
// disputed / waiting_customer / closed / waived keeps that status.
export function rollupClaimStatus(c: ClaimRecord): ClaimStatus {
  if (isTerminal(c.status)) return c.status
  if (!c.assignments.length) return c.status
  const settled = c.assignments.every(a => a.status === 'completed' || a.status === 'waived')
  if (settled && (c.status === 'deduction_active' || c.status === 'approved')) return 'paid'
  if (c.assignments.some(a => a.status === 'active')) return 'deduction_active'
  return c.status
}

// ── Audit (append-only) ──────────────────────────────────────────────────────
export function pushClaimAudit(c: ClaimRecord, actor: string, action: string, note?: string): void {
  c.audit.push({ at: Date.now(), actor, action, note })
  // Deliberately generous: a claim's history is the evidence if a deduction is
  // ever challenged. Trim only to stop one pathological record growing forever.
  if (c.audit.length > 1000) c.audit = c.audit.slice(-1000)
}

const entryId = (): string => generateToken().slice(0, 16)

// ── Ledger mutators ──────────────────────────────────────────────────────────
function pushLedger(
  a: ClaimAssignment,
  e: Omit<LedgerEntry, 'id' | 'at'>,
): LedgerEntry {
  const entry: LedgerEntry = { id: entryId(), at: Date.now(), ...e }
  a.ledger.push(entry)
  return entry
}

/**
 * Recompute derived state after any ledger change. A share is settled the moment
 * nothing is left owing — including when it's paid off in cash before a weekly
 * plan was ever started, which is why this keys on the balance, not the status.
 * (A zero-dollar share was never owed, so it isn't "completed".)
 */
function settleAssignment(a: ClaimAssignment, today: string): void {
  if (a.status === 'waived') return
  if (a.responsibilityCents > 0 && remainingCents(a) === 0) {
    a.status = 'completed'
    a.endDate = a.endDate ?? today
    a.nextDeductionOn = undefined
  }
}

// ── Weekly deduction accrual ─────────────────────────────────────────────────
// A deduction is POSTED to the ledger on its due date and never recomputed. The
// pay run reads posted entries — it never derives them — so a contractor's pay
// can't silently change after the fact.
export type DueDeduction = { staffId: string; periodDate: string; amountCents: number }

const alreadyPosted = (a: ClaimAssignment, periodDate: string): boolean =>
  a.ledger.some(e => e.kind === 'scheduled' && e.periodDate === periodDate && e.direction === 'credit')

/**
 * Which scheduled deductions are due on/before `today` and not yet posted.
 * Pure — the cron calls this, then posts. Catches up if the cron missed days.
 */
export function dueDeductions(c: ClaimRecord, today: string): DueDeduction[] {
  if (isTerminal(c.status)) return []
  const out: DueDeduction[] = []
  for (const a of c.assignments) {
    if (a.status !== 'active') continue
    const weekly = a.weeklyDeductionCents ?? 0
    if (weekly <= 0) continue

    let cursor = a.nextDeductionOn ?? a.startDate
    if (!isDateStr(cursor)) continue

    // Model the balance forward so a multi-week catch-up can't over-deduct.
    let owed = remainingCents(a)
    let guard = 0
    while (cursor <= today && owed > 0 && guard++ < 260) {
      if (!alreadyPosted(a, cursor)) {
        const amount = Math.min(weekly, owed)
        out.push({ staffId: a.staffId, periodDate: cursor, amountCents: amount })
        owed -= amount
      }
      cursor = addDaysStr(cursor, 7)
    }
  }
  return out
}

/**
 * The contractor earned nothing (or too little) in this pay week, so there was
 * nothing to withhold. Advance the schedule WITHOUT touching the balance: the
 * plan simply takes one week longer. Nothing is forgiven, and the audit says why.
 *
 * This is the counterpart to capping a deduction at available pay — without it,
 * the cron would post a deduction against pay that never existed.
 */
export function skipScheduledDeduction(
  c: ClaimRecord, staffId: string, periodDate: string, reason: string, actor = 'cron',
): { ok: true } | { ok: false; error: string } {
  const a = c.assignments.find(x => x.staffId === staffId)
  if (!a) return { ok: false, error: 'That person is not responsible for this claim.' }
  if (alreadyPosted(a, periodDate)) return { ok: false, error: 'That deduction was already taken.' }
  a.nextDeductionOn = addDaysStr(periodDate, 7)
  pushClaimAudit(c, actor, `Skipped ${a.name}'s deduction for the week of ${periodDate}`, reason)
  return { ok: true }
}

/** Post one scheduled deduction. Idempotent per (staffId, periodDate). */
export function postScheduledDeduction(
  c: ClaimRecord, staffId: string, periodDate: string, amountCents: number, actor = 'system',
): { ok: true; entry: LedgerEntry } | { ok: false; error: string } {
  const a = c.assignments.find(x => x.staffId === staffId)
  if (!a) return { ok: false, error: 'That person is not responsible for this claim.' }
  if (a.status !== 'active') return { ok: false, error: `${a.name}'s deduction is not active.` }
  if (alreadyPosted(a, periodDate)) return { ok: false, error: 'That deduction was already taken.' }

  const amount = Math.min(amountCents, remainingCents(a))
  if (amount <= 0) return { ok: false, error: `${a.name} has nothing left to deduct.` }

  const entry = pushLedger(a, { kind: 'scheduled', direction: 'credit', amountCents: amount, periodDate, actor })
  a.lastDeductionOn = periodDate
  a.nextDeductionOn = addDaysStr(periodDate, 7)
  settleAssignment(a, periodDate)
  pushClaimAudit(c, actor, `Deducted ${fmt(amount)} from ${a.name}`, `week of ${periodDate}`)
  c.status = rollupClaimStatus(c)
  return { ok: true, entry }
}

// NOTE: there is deliberately no accrue-everything helper here. Posting a deduction
// requires knowing what the contractor actually earned that week, which this module
// cannot see — see lib/claim-accrual, which caps each deduction at available pay.

const fmt = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

// ── Responsibility mutators ──────────────────────────────────────────────────
export function setResponsibility(
  c: ClaimRecord,
  members: { staffId: string; name: string; role?: string; weeklyDeductionCents?: number; startDate?: string }[],
  mode: SplitMode,
  values: SplitInput[],
  actor = 'admin',
): { ok: true } | { ok: false; error: string } {
  // Re-allocating must never destroy money already taken from someone.
  for (const existing of c.assignments) {
    const keeping = members.some(m => m.staffId === existing.staffId)
    if (!keeping && recoveredCents(existing) > 0) {
      return { ok: false, error: `${existing.name} has already had ${fmt(recoveredCents(existing))} deducted — refund or waive it before removing them.` }
    }
  }

  const alloc = allocate(c.totalCents, mode, values)
  if (!alloc.ok) return alloc

  for (const m of members) {
    const share = alloc.cents[m.staffId] ?? 0
    const prev = c.assignments.find(a => a.staffId === m.staffId)

    // Never set someone's share below what they've already paid in.
    const paid = prev ? creditedCents(prev) : 0
    if (share < paid) {
      return { ok: false, error: `${m.name} has already settled ${fmt(paid)} — their share can't drop below that.` }
    }

    if (prev) {
      if (prev.responsibilityCents !== share) {
        pushClaimAudit(c, actor, `${m.name}'s responsibility changed to ${fmt(share)}`, `was ${fmt(prev.responsibilityCents)}`)
      }
      prev.responsibilityCents = share
      prev.responsibilityPct = c.totalCents ? Math.round((share / c.totalCents) * 1000) / 10 : 0
      if (m.weeklyDeductionCents !== undefined) prev.weeklyDeductionCents = m.weeklyDeductionCents
      if (m.startDate) prev.startDate = m.startDate
    } else {
      c.assignments.push({
        staffId: m.staffId, name: m.name, role: m.role,
        responsibilityCents: share,
        responsibilityPct: c.totalCents ? Math.round((share / c.totalCents) * 1000) / 10 : 0,
        weeklyDeductionCents: m.weeklyDeductionCents,
        startDate: m.startDate,
        status: 'pending',
        ledger: [],
      })
      pushClaimAudit(c, actor, `${m.name} made responsible for ${fmt(share)}`)
    }
  }

  const removed = c.assignments.filter(a => !members.some(m => m.staffId === a.staffId))
  for (const r of removed) pushClaimAudit(c, actor, `${r.name} removed from responsibility`)
  c.assignments = c.assignments.filter(a => members.some(m => m.staffId === a.staffId))

  c.status = rollupClaimStatus(c)
  return { ok: true }
}

export function startDeduction(
  c: ClaimRecord, staffId: string, opts: { weeklyCents?: number; startDate?: string } = {}, actor = 'admin',
): { ok: true } | { ok: false; error: string } {
  const a = c.assignments.find(x => x.staffId === staffId)
  if (!a) return { ok: false, error: 'That person is not responsible for this claim.' }
  if (a.status === 'waived') return { ok: false, error: `${a.name}'s balance was waived.` }
  if (a.status === 'completed') return { ok: false, error: `${a.name} has already paid this off.` }

  if (opts.weeklyCents !== undefined) a.weeklyDeductionCents = opts.weeklyCents
  if (opts.startDate) a.startDate = opts.startDate

  const weekly = a.weeklyDeductionCents ?? 0
  if (weekly <= 0) return { ok: false, error: 'Set a weekly deduction amount first.' }
  if (weekly > remainingCents(a)) a.weeklyDeductionCents = remainingCents(a)

  // Snap to the Monday of the pay week so a deduction period always lines up with
  // one whole pay period (route-pay.defaultPayPeriod is Mon–Sun).
  a.startDate = mondayOf(a.startDate ?? centralToday())
  a.nextDeductionOn = a.nextDeductionOn ?? a.startDate
  const resuming = a.status === 'paused'
  a.status = 'active'
  a.pausedAt = undefined
  a.pausedReason = undefined

  pushClaimAudit(c, actor, resuming
    ? `Resumed ${a.name}'s deduction (${fmt(a.weeklyDeductionCents!)}/week)`
    : `Started ${a.name}'s deduction — ${fmt(a.weeklyDeductionCents!)}/week from ${a.startDate}`)
  c.status = rollupClaimStatus(c)
  return { ok: true }
}

export function pauseDeduction(c: ClaimRecord, staffId: string, reason?: string, actor = 'admin'): { ok: true } | { ok: false; error: string } {
  const a = c.assignments.find(x => x.staffId === staffId)
  if (!a) return { ok: false, error: 'That person is not responsible for this claim.' }
  if (a.status !== 'active') return { ok: false, error: `${a.name}'s deduction isn't running.` }
  a.status = 'paused'
  a.pausedAt = Date.now()
  a.pausedReason = reason
  pushClaimAudit(c, actor, `Paused ${a.name}'s deduction`, reason)
  c.status = rollupClaimStatus(c)
  return { ok: true }
}

/** Forgive whatever is left. Recorded as a waiver credit so the books still balance. */
export function waiveBalance(c: ClaimRecord, staffId: string, reason?: string, actor = 'admin'): { ok: true } | { ok: false; error: string } {
  const a = c.assignments.find(x => x.staffId === staffId)
  if (!a) return { ok: false, error: 'That person is not responsible for this claim.' }
  if (a.status === 'waived') return { ok: false, error: `${a.name}'s balance is already waived.` }
  const left = remainingCents(a)
  if (left > 0) {
    pushLedger(a, { kind: 'waiver', direction: 'credit', amountCents: left, periodDate: centralToday(), note: reason, actor })
  }
  a.status = 'waived'
  a.waivedAt = Date.now()
  a.waivedReason = reason
  a.endDate = a.endDate ?? centralToday()
  a.nextDeductionOn = undefined
  pushClaimAudit(c, actor, `Waived ${fmt(left)} of ${a.name}'s balance`, reason)
  c.status = rollupClaimStatus(c)
  return { ok: true }
}

/** Crew member handed over cash / paid outside payroll. */
export function recordPayment(
  c: ClaimRecord, staffId: string, amountCents: number, opts: { date?: string; note?: string } = {}, actor = 'admin',
): { ok: true } | { ok: false; error: string } {
  const a = c.assignments.find(x => x.staffId === staffId)
  if (!a) return { ok: false, error: 'That person is not responsible for this claim.' }
  if (amountCents <= 0) return { ok: false, error: 'Payment must be a positive dollar amount.' }
  const left = remainingCents(a)
  if (left === 0) return { ok: false, error: `${a.name} has nothing left to pay.` }
  if (amountCents > left) return { ok: false, error: `That's more than ${a.name} still owes (${fmt(left)}).` }

  const date = opts.date && isDateStr(opts.date) ? opts.date : centralToday()
  pushLedger(a, { kind: 'payment', direction: 'credit', amountCents, periodDate: date, note: opts.note, actor })
  settleAssignment(a, date)
  pushClaimAudit(c, actor, `${a.name} paid ${fmt(amountCents)}`, opts.note)
  c.status = rollupClaimStatus(c)
  return { ok: true }
}

/**
 * Correct the balance without touching history. `direction: 'debit'` puts money
 * back onto what they owe (e.g. reversing a deduction taken in error).
 */
export function adjustBalance(
  c: ClaimRecord, staffId: string, amountCents: number, direction: 'credit' | 'debit', reason: string, actor = 'admin',
): { ok: true } | { ok: false; error: string } {
  const a = c.assignments.find(x => x.staffId === staffId)
  if (!a) return { ok: false, error: 'That person is not responsible for this claim.' }
  if (amountCents <= 0) return { ok: false, error: 'Adjustment must be a positive dollar amount.' }
  if (!reason.trim()) return { ok: false, error: 'An adjustment needs a reason.' }
  if (direction === 'credit' && amountCents > remainingCents(a)) {
    return { ok: false, error: `That credit is larger than ${a.name}'s remaining balance (${fmt(remainingCents(a))}).` }
  }
  if (direction === 'debit' && creditedCents(a) - amountCents < 0) {
    return { ok: false, error: `That debit is larger than what ${a.name} has settled so far.` }
  }

  pushLedger(a, { kind: 'adjustment', direction, amountCents, periodDate: centralToday(), note: reason, actor })
  // A debit can re-open a completed balance.
  if (a.status === 'completed' && remainingCents(a) > 0) { a.status = 'paused'; a.endDate = undefined }
  settleAssignment(a, centralToday())
  pushClaimAudit(c, actor, `${direction === 'credit' ? 'Credited' : 'Debited'} ${fmt(amountCents)} ${direction === 'credit' ? 'to' : 'against'} ${a.name}`, reason)
  c.status = rollupClaimStatus(c)
  return { ok: true }
}

export function closeClaim(c: ClaimRecord, resolutionNotes?: string, actor = 'admin'): void {
  c.status = 'closed'
  c.closedAt = Date.now()
  if (resolutionNotes) c.resolutionNotes = resolutionNotes
  pushClaimAudit(c, actor, 'Claim closed', resolutionNotes)
}

// ── Snapshot ─────────────────────────────────────────────────────────────────
// Built once, at claim creation. Nothing in this module ever rewrites it.
export function snapshotFromRoute(route: RouteRecord, biz: Business | null | undefined): ClaimSnapshot {
  const money = computeRouteMoney(route)
  return {
    at: Date.now(),
    businessKey: bizKey(route.businessName),
    businessName: route.businessName,
    businessContactName: biz?.contactName,
    businessContactPhone: biz?.contactPhone,
    businessPriceCents: route.financials?.businessPriceCents,
    priceSource: route.financials?.priceSource,
    routeToken: route.token,
    routeNumber: route.routeNumber,
    routeDate: route.routeDate,
    reportAddress: route.reportAddress,
    routePayoutCents: money.payoutCents,
    routeProfitCents: money.profitCents,
    crew: (route.assignees ?? []).map(a => ({ staffId: a.staffId, name: a.name, role: a.role, payCents: a.payCents })),
  }
}

export function snapshotFromBusiness(businessName: string, biz: Business | null | undefined): ClaimSnapshot {
  return {
    at: Date.now(),
    businessKey: bizKey(businessName),
    businessName,
    businessContactName: biz?.contactName,
    businessContactPhone: biz?.contactPhone,
    businessPriceCents: biz?.contractRateCents,
    priceSource: biz?.contractRateCents == null ? 'none' : 'contract',
    crew: [],
  }
}

// ── Data layer ───────────────────────────────────────────────────────────────
const KEY = (id: string) => `clm:${id}`
const KEY_NUM = (n: string) => `clm:num:${n}`
const KEY_INDEX = 'clm:index'        // zset, score = createdAt, member = id
const KEY_COUNTER = 'clm:counter'
const ID_RE = /^[a-f0-9]{16,}$/i

export const generateClaimId = generateToken

// No Redis fallback on purpose — see the note in lib/bookings.ts.
export async function nextClaimNumber(): Promise<string> {
  const n = await redis.incr(KEY_COUNTER)
  return `JK-C-${1000 + n}`
}

// Old records predate fields added later; make every read total.
function normalize(c: ClaimRecord): ClaimRecord {
  c.assignments = Array.isArray(c.assignments) ? c.assignments : []
  for (const a of c.assignments) a.ledger = Array.isArray(a.ledger) ? a.ledger : []
  c.attachments = Array.isArray(c.attachments) ? c.attachments : []
  c.audit = Array.isArray(c.audit) ? c.audit : []
  return c
}

export async function getClaim(id: string): Promise<ClaimRecord | null> {
  if (!id || !ID_RE.test(id)) return null
  const raw = await redis.get(KEY(id))
  if (!raw) return null
  try { return normalize(JSON.parse(raw) as ClaimRecord) } catch { return null }
}

export async function saveClaim(c: ClaimRecord): Promise<void> {
  c.updatedAt = Date.now()
  await redis.set(KEY(c.id), JSON.stringify(c))
  await redis.set(KEY_NUM(c.claimNumber.toUpperCase()), c.id)
  await redis.zadd(KEY_INDEX, c.createdAt, c.id)
}

export async function deleteClaim(id: string): Promise<void> {
  const c = await getClaim(id)
  await redis.del(KEY(id))
  if (c) await redis.del(KEY_NUM(c.claimNumber.toUpperCase()))
  await redis.zrem(KEY_INDEX, id)
}

// Bounded scan, same as listRoutes. Claims are low-volume (tens per year); if that
// ever changes, add per-business/per-staff zset indexes rather than raising this.
export async function listClaims(limit = 500): Promise<ClaimRecord[]> {
  const ids = await redis.zrevrange(KEY_INDEX, 0, limit - 1)
  if (!ids.length) return []
  const raws = await Promise.all(ids.map(i => redis.get(KEY(i))))
  return raws
    .filter(Boolean)
    .map(r => { try { return normalize(JSON.parse(r as string) as ClaimRecord) } catch { return null } })
    .filter((c): c is ClaimRecord => c !== null)
}

export const claimsForBusiness = (claims: ClaimRecord[], key: string): ClaimRecord[] =>
  claims.filter(c => c.businessKey === key)

export const claimsForStaff = (claims: ClaimRecord[], staffId: string): ClaimRecord[] =>
  claims.filter(c => c.assignments.some(a => a.staffId === staffId))

export const claimsForRoute = (claims: ClaimRecord[], routeToken: string): ClaimRecord[] =>
  claims.filter(c => c.routeToken === routeToken)
