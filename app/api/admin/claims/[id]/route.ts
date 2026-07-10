import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../../_lib/session'
import {
  getClaim, saveClaim, deleteClaim, pushClaimAudit, rollupClaimStatus,
  setResponsibility, startDeduction, pauseDeduction, waiveBalance, recordPayment, adjustBalance, closeClaim,
  claimRecoveredCents, remainingCents,
  CLAIM_STATUS_LABEL, CLAIM_TYPE_LABEL,
  type ClaimRecord, type ClaimStatus, type ClaimType, type SplitMode, type SplitInput, type AttachmentKind,
} from '../../../../lib/claims'
import { notifyCrewOfClaim, type CrewClaimEvent } from '../../../../lib/claim-notify'
import { parseMoneyCents } from '../../../../lib/finance'
import { listStaff } from '../../../../lib/staff'
import { isDateStr } from '../../../../lib/dates'

const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const isStatus = (v: string): v is ClaimStatus => v in CLAIM_STATUS_LABEL
const isType = (v: string): v is ClaimType => v in CLAIM_TYPE_LABEL
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status })

/** Text one crew member about their own claim. Never blocks the money change. */
async function tell(c: ClaimRecord, staffId: string, event: CrewClaimEvent, notify: boolean) {
  if (!notify) return
  const a = c.assignments.find(x => x.staffId === staffId)
  if (!a) return
  const phone = (await listStaff()).find(s => s.id === staffId)?.phone
  await notifyCrewOfClaim(c, a, event, phone)
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireSession(req))) return bad('unauthorized', 401)
  const { id } = await params
  const claim = await getClaim(id)
  if (!claim) return bad('Claim not found.', 404)

  const b = await req.json().catch(() => ({}))
  const action = S(b.action, 40)
  const notify = b.notify !== false
  const staffId = S(b.staffId, 80)

  try {
    if (action === 'update') {
      // Editing the facts of a claim. The SNAPSHOT is never touched — it records
      // what the route and pricing were when the claim was opened, and rewriting
      // that would destroy the historical record it exists to preserve.
      const fields: Array<[keyof ClaimRecord, number]> = [
        ['description', 4000], ['internalNotes', 4000], ['businessContact', 200], ['resolutionNotes', 4000],
        ['reportedBy', 200],
      ]
      for (const [k, max] of fields) {
        if (b[k] !== undefined) (claim as Record<string, unknown>)[k] = S(b[k], max) || undefined
      }
      if (b.responseDeadline !== undefined) {
        const d = S(b.responseDeadline, 20)
        claim.responseDeadline = isDateStr(d) ? d : undefined
      }
      if (b.claimType !== undefined) {
        const t = S(b.claimType, 40)
        if (!isType(t)) return bad('Unknown claim type.')
        claim.claimType = t
      }
      for (const k of ['claimDate', 'reportedDate'] as const) {
        if (b[k] !== undefined) {
          const d = S(b[k], 20)
          if (!isDateStr(d)) return bad('Dates must be YYYY-MM-DD.')
          claim[k] = d
        }
      }
      if (claim.reportedDate < claim.claimDate) return bad("A claim can't be reported before it happened.")

      if (b.total !== undefined) {
        const cents = parseMoneyCents(b.total)
        if (cents == null || cents === 0) return bad('Claim amount must be a positive dollar amount.')
        // Lowering the total below what crew already owe would leave the split
        // exceeding the claim. Re-assign responsibility first.
        const assigned = claim.assignments.reduce((s, a) => s + a.responsibilityCents, 0)
        if (cents < assigned) return bad(`Crew are already responsible for ${(assigned / 100).toFixed(2)}. Lower their shares before reducing the claim.`)
        if (cents !== claim.totalCents) pushClaimAudit(claim, 'admin', `Claim amount changed to ${(cents / 100).toFixed(2)}`, `was ${(claim.totalCents / 100).toFixed(2)}`)
        claim.totalCents = cents
      }
      pushClaimAudit(claim, 'admin', 'Claim edited')

    } else if (action === 'status') {
      const s = S(b.status, 40)
      if (!isStatus(s)) return bad('Unknown status.')
      if (s !== claim.status) {
        const from = claim.status
        claim.status = s
        pushClaimAudit(claim, 'admin', `Status → ${CLAIM_STATUS_LABEL[s]}`, `was ${CLAIM_STATUS_LABEL[from]}`)
      }

    } else if (action === 'responsibility') {
      const mode = S(b.mode, 20) as SplitMode
      if (!['equal', 'percent', 'dollar'].includes(mode)) return bad('Pick how to split responsibility.')

      const raw = Array.isArray(b.members) ? (b.members as Record<string, unknown>[]) : []
      if (!raw.length) return bad('Pick at least one crew member.')

      const roster = await listStaff()
      const members: Parameters<typeof setResponsibility>[1] = []
      const values: SplitInput[] = []

      for (const m of raw) {
        const sid = S(m.staffId, 80)
        const person = roster.find(s => s.id === sid)
        if (!person) return bad('That crew member is not on the roster.')

        let value: number | undefined
        if (mode === 'percent') {
          const p = Number(m.value)
          if (!Number.isFinite(p) || p < 0 || p > 100) return bad('Each percentage must be between 0 and 100.')
          value = p
        } else if (mode === 'dollar') {
          const cents = parseMoneyCents(m.value)
          if (cents == null) return bad(`${person.name}'s amount must be a positive dollar amount.`)
          value = cents
        }

        let weeklyCents: number | undefined
        if (m.weekly !== undefined && S(m.weekly, 40)) {
          const w = parseMoneyCents(m.weekly)
          if (w == null || w === 0) return bad(`${person.name}'s weekly deduction must be a positive dollar amount.`)
          weeklyCents = w
        }
        const start = S(m.startDate, 20)
        if (start && !isDateStr(start)) return bad('Start date must be YYYY-MM-DD.')

        members.push({ staffId: sid, name: person.name, role: person.role, weeklyDeductionCents: weeklyCents, startDate: start || undefined })
        values.push({ staffId: sid, value })
      }

      const before = new Set(claim.assignments.map(a => a.staffId))
      const res = setResponsibility(claim, members, mode, values)
      if (!res.ok) return bad(res.error)
      await saveClaim(claim)
      for (const m of members) if (!before.has(m.staffId)) await tell(claim, m.staffId, 'assigned', notify)
      return NextResponse.json({ ok: true, claim })

    } else if (action === 'start_deduction') {
      let weeklyCents: number | undefined
      if (b.weekly !== undefined && S(b.weekly, 40)) {
        const w = parseMoneyCents(b.weekly)
        if (w == null || w === 0) return bad('Weekly deduction must be a positive dollar amount.')
        weeklyCents = w
      }
      const start = S(b.startDate, 20)
      if (start && !isDateStr(start)) return bad('Start date must be YYYY-MM-DD.')

      const wasActive = claim.assignments.find(a => a.staffId === staffId)?.status === 'active'
      const res = startDeduction(claim, staffId, { weeklyCents, startDate: start || undefined })
      if (!res.ok) return bad(res.error)
      await saveClaim(claim)
      await tell(claim, staffId, wasActive ? 'deduction_changed' : 'deduction_started', notify)
      return NextResponse.json({ ok: true, claim })

    } else if (action === 'pause_deduction') {
      const res = pauseDeduction(claim, staffId, S(b.reason, 300) || undefined)
      if (!res.ok) return bad(res.error)

    } else if (action === 'waive') {
      const res = waiveBalance(claim, staffId, S(b.reason, 300) || undefined)
      if (!res.ok) return bad(res.error)
      await saveClaim(claim)
      await tell(claim, staffId, 'waived', notify)
      return NextResponse.json({ ok: true, claim })

    } else if (action === 'payment') {
      const cents = parseMoneyCents(b.amount)
      if (cents == null || cents === 0) return bad('Payment must be a positive dollar amount.')
      const date = S(b.date, 20)
      if (date && !isDateStr(date)) return bad('Date must be YYYY-MM-DD.')
      const res = recordPayment(claim, staffId, cents, { date: date || undefined, note: S(b.note, 300) || undefined })
      if (!res.ok) return bad(res.error)
      const done = remainingCents(claim.assignments.find(a => a.staffId === staffId)!) === 0
      await saveClaim(claim)
      if (done) await tell(claim, staffId, 'deduction_complete', notify)
      return NextResponse.json({ ok: true, claim })

    } else if (action === 'adjust') {
      const cents = parseMoneyCents(b.amount)
      if (cents == null || cents === 0) return bad('Adjustment must be a positive dollar amount.')
      const direction = S(b.direction, 10)
      if (direction !== 'credit' && direction !== 'debit') return bad('An adjustment is either a credit or a debit.')
      const res = adjustBalance(claim, staffId, cents, direction, S(b.reason, 300))
      if (!res.ok) return bad(res.error)

    } else if (action === 'attach') {
      const kind = S(b.kind, 20) as AttachmentKind
      if (!['photo', 'video', 'document'].includes(kind)) return bad('Unknown attachment type.')
      const url = S(b.url, 1000)
      if (!/^https:\/\/\S+$/.test(url)) return bad('Attachment must be an https URL.')
      claim.attachments.push({ id: `${Date.now()}-${claim.attachments.length}`, kind, url, name: S(b.name, 200) || undefined, addedAt: Date.now(), addedBy: 'admin' })
      pushClaimAudit(claim, 'admin', `Attached a ${kind}`, S(b.name, 200) || undefined)

    } else if (action === 'detach') {
      // Soft delete — a claim's evidence trail is not silently rewritable.
      const att = claim.attachments.find(a => a.id === S(b.attachmentId, 80))
      if (!att) return bad('Attachment not found.')
      if (att.removedAt) return NextResponse.json({ ok: true, claim })
      att.removedAt = Date.now()
      att.removedBy = 'admin'
      pushClaimAudit(claim, 'admin', `Removed a ${att.kind}`, att.name)

    } else if (action === 'close') {
      const outstanding = claim.assignments.reduce((s, a) => s + remainingCents(a), 0)
      if (outstanding > 0 && b.acknowledgeOutstanding !== true) {
        return NextResponse.json({
          warning: 'outstanding_balance',
          message: `Crew still owe ${(outstanding / 100).toFixed(2)} on this claim. Close it anyway? Their deductions will stop.`,
          outstandingCents: outstanding,
        }, { status: 409 })
      }
      closeClaim(claim, S(b.resolutionNotes, 4000) || undefined)

    } else {
      return bad('Unknown action.')
    }

    claim.status = rollupClaimStatus(claim)
    await saveClaim(claim)
    return NextResponse.json({ ok: true, claim })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'update failed'
    if (msg === 'UPSTASH_NOT_CONFIGURED') return bad('UPSTASH_NOT_CONFIGURED', 503)
    console.error('[admin/claims PATCH]', err)
    return bad('update failed', 500)
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireSession(req))) return bad('unauthorized', 401)
  const { id } = await params
  const claim = await getClaim(id)
  if (!claim) return NextResponse.json({ ok: true })

  // Deleting a claim that already moved money would erase the only record of why
  // a contractor's pay was reduced. Require an explicit acknowledgement.
  const recovered = claimRecoveredCents(claim)
  const settled = claim.status === 'paid' || claim.status === 'closed'
  const confirmed = new URL(req.url).searchParams.get('confirm') === '1'
  if ((recovered > 0 || settled) && !confirmed) {
    return NextResponse.json({
      warning: 'has_history',
      message: recovered > 0
        ? `${(recovered / 100).toFixed(2)} has already been deducted against this claim. Deleting it destroys the record of those deductions. Delete anyway?`
        : 'This claim is settled. Deleting it destroys its financial history. Delete anyway?',
    }, { status: 409 })
  }

  await deleteClaim(id)
  return NextResponse.json({ ok: true })
}
