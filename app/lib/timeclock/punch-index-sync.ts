// Sprint 3.1 Phase C — keeping the open-punch index in step with a punch write.
//
// One helper, called by every site that persists a change to an assignee's clock
// fields: the public route link, the portal clock, the public-link automatic
// clock-out on completion, and the booking lane. Correction-driven changes are
// handled inside `appendCorrection`, which already knows the new effective state.
//
// It reads the punch's corrections before deciding, because the INDEX tracks the
// EFFECTIVE punch. A raw clock-in on a punch an admin has already corrected closed
// must not be filed as open — that would block the crew member's next job on the
// strength of a shift the timesheet considers finished.
//
// Never throws. The index is a cache of derivable truth: a failed cache write must
// not turn a successful punch into a failed one, and drift is what reconciliation
// exists for. An index that has drifted is also, by construction, an index whose
// completion marker can be cleared — it is never silently trusted.
import { isEnabled } from '../platform/flags'
import { effectivePunch, listCorrections, punchId, type WorkType } from '../time-corrections'
import { syncPunchIndex } from './open-punch-index'

export async function syncAssigneePunchIndex(
  workType: WorkType,
  jobToken: string,
  serviceDate: string | null | undefined,
  assignee: { staffId?: string; clockInAt?: number | null; clockOutAt?: number | null },
): Promise<void> {
  if (!isEnabled('OPEN_PUNCH_INDEX_ENABLED')) return
  const staffId = String(assignee.staffId ?? '').trim()
  if (!staffId || !String(jobToken ?? '').trim()) return

  try {
    const id = punchId(workType, jobToken, staffId)
    const effective = effectivePunch(
      { clockInAt: assignee.clockInAt ?? null, clockOutAt: assignee.clockOutAt ?? null },
      await listCorrections(id),
    )
    await syncPunchIndex({
      punchId: id,
      staffId,
      serviceDate,
      open: effective.clockInAt != null && effective.clockOutAt == null,
      clockInAt: effective.clockInAt,
    })
  } catch {
    /* see the note above */
  }
}

/**
 * Drop a punch from the index because the punch itself no longer exists — the
 * assignee was removed from the job. Distinct from a clock-out: there is no
 * record left to read, so nothing could ever close this entry again, and a
 * phantom would block the crew member's next clock-in permanently.
 */
export async function clearPunchFromIndex(
  workType: WorkType,
  jobToken: string,
  staffId: string,
): Promise<void> {
  if (!isEnabled('OPEN_PUNCH_INDEX_ENABLED')) return
  const sid = String(staffId ?? '').trim()
  if (!sid || !String(jobToken ?? '').trim()) return
  try {
    await syncPunchIndex({ punchId: punchId(workType, jobToken, sid), staffId: sid, serviceDate: null, open: false })
  } catch {
    /* cache write; reconciliation repairs drift */
  }
}
