// Crew notifications for claims + deductions.
//
// LEAKAGE RULE (do not relax): a contractor may be told about THEIR OWN
// responsibility and deduction. They are never told what the client paid for the
// route, what the route earned, what J KISS made on it, what another crew member
// owes, or anything from the claim's internal notes. Every message here is built
// from a whitelist of fields — no ClaimRecord or ClaimSnapshot is ever spread into
// a message body.
import { sendSms } from './sms'
import { remainingCents, type ClaimAssignment, type ClaimRecord } from './claims'

const money = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

/** The only claim fields a crew message may reference. */
type CrewSafe = { claimNumber: string; businessName: string; name: string }
const safe = (c: ClaimRecord, a: ClaimAssignment): CrewSafe =>
  ({ claimNumber: c.claimNumber, businessName: c.businessName, name: a.name })

export function assignedSms(c: ClaimRecord, a: ClaimAssignment): string {
  const s = safe(c, a)
  return `J KISS: A damage claim (${s.claimNumber}) from ${s.businessName} has been assigned to you. Your share is ${money(a.responsibilityCents)}. We'll go over it with you — reply or call with questions.`
}

export function deductionStartedSms(c: ClaimRecord, a: ClaimAssignment): string {
  const s = safe(c, a)
  const weekly = a.weeklyDeductionCents ?? 0
  return `J KISS: Starting ${money(weekly)}/week toward claim ${s.claimNumber} (${s.businessName}) from the week of ${a.startDate}. Balance: ${money(remainingCents(a))}. Each deduction shows on your pay statement.`
}

export function deductionChangedSms(c: ClaimRecord, a: ClaimAssignment): string {
  const s = safe(c, a)
  const weekly = a.weeklyDeductionCents ?? 0
  return `J KISS: Your weekly deduction for claim ${s.claimNumber} (${s.businessName}) is now ${money(weekly)}/week. Balance: ${money(remainingCents(a))}.`
}

export function deductionCompleteSms(c: ClaimRecord, a: ClaimAssignment): string {
  const s = safe(c, a)
  return `J KISS: Claim ${s.claimNumber} (${s.businessName}) is paid off. No further deductions. Thank you.`
}

export function balanceWaivedSms(c: ClaimRecord, a: ClaimAssignment): string {
  const s = safe(c, a)
  return `J KISS: The remaining balance on claim ${s.claimNumber} (${s.businessName}) has been waived. No further deductions.`
}

export type CrewClaimEvent = 'assigned' | 'deduction_started' | 'deduction_changed' | 'deduction_complete' | 'waived'

const BODY: Record<CrewClaimEvent, (c: ClaimRecord, a: ClaimAssignment) => string> = {
  assigned: assignedSms,
  deduction_started: deductionStartedSms,
  deduction_changed: deductionChangedSms,
  deduction_complete: deductionCompleteSms,
  waived: balanceWaivedSms,
}

/**
 * Text one crew member about their own claim. Best-effort: a failed text must
 * never roll back the money change that triggered it.
 */
export async function notifyCrewOfClaim(
  c: ClaimRecord, a: ClaimAssignment, event: CrewClaimEvent, phone: string | undefined,
): Promise<boolean> {
  if (!phone) return false
  try { return await sendSms(phone, BODY[event](c, a)) } catch { return false }
}
