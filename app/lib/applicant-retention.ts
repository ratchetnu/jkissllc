import { del } from '@vercel/blob'
import { getApplicant, listApplicants, purgeApplicantAfterRetention, pushApplicantEvent, rejectionEventAt, saveApplicant, type Applicant } from './applicants'
import { getStaff, saveStaff } from './staff'
import { pendingContractorUploadsBefore, removePendingContractorUpload } from './contractor-upload-registry'
import { recordAudit } from './audit'

const DAY = 86_400_000
export const APPLICANT_RETENTION = {
  abandonedUploadMs: 7 * DAY,
  rejectedSensitiveDocumentMs: 30 * DAY,
  rejectedApplicationMs: 4 * 365 * DAY,
  w9Ms: 4 * 365 * DAY,
  approvedRecordMs: 7 * 365 * DAY,
} as const

const sensitiveRejectedKinds = new Set(['drivers_license', 'id', 'ss_card', 'w9', 'contractor_agreement', 'insurance', 'headshot'])

export type ApplicantRetentionDecision = {
  held: boolean
  purgeRejectedDocuments: boolean
  purgeW9: boolean
  purgeRecord: boolean
}

/**
 * The authoritative instant for the CURRENT rejection episode. It never moves
 * while that episode remains rejected, so a later note, rescore, or legal-hold
 * edit cannot push a deletion deadline. A later reopen + rejection starts a new
 * episode; the append-only applicant events preserve every earlier decision.
 * Legacy records
 * fall back to their rejection EVENT (append-only, therefore stable); only a
 * record with neither is seeded from `updatedAt`, and `cleanupApplicantRetention`
 * persists that seed immediately so it is read from the record from then on.
 */
export function rejectionTimestamp(a: Applicant): number | undefined {
  if (a.status !== 'rejected') return undefined
  return a.rejectedAt ?? rejectionEventAt(a) ?? a.updatedAt
}

export function applicantRetentionDecision(a: Applicant, now = Date.now()): ApplicantRetentionDecision {
  if (a.legalHold?.active) return { held: true, purgeRejectedDocuments: false, purgeW9: false, purgeRecord: false }
  const rejectedAt = rejectionTimestamp(a)
  const endedAt = a.contractEndedAt
  return {
    held: false,
    purgeRejectedDocuments: Boolean(rejectedAt && now - rejectedAt >= APPLICANT_RETENTION.rejectedSensitiveDocumentMs),
    purgeW9: Boolean(endedAt && now - endedAt >= APPLICANT_RETENTION.w9Ms),
    purgeRecord: a.status === 'rejected'
      ? Boolean(rejectedAt && now - rejectedAt >= APPLICANT_RETENTION.rejectedApplicationMs)
      : Boolean(a.promotedStaffId && endedAt && now - endedAt >= APPLICANT_RETENTION.approvedRecordMs),
  }
}

export function applicantRetentionMustBeDryRun(requestedDryRun: boolean, deleteSetting?: string): boolean {
  return requestedDryRun || deleteSetting !== 'true'
}

export async function runApplicantRetentionSweep(
  now: number,
  requestedDryRun: boolean,
  deleteSetting = process.env.APPLICANT_RETENTION_DELETE_ENABLED,
  cleanup: (at: number, dryRun: boolean) => Promise<Record<string, number>> = cleanupApplicantRetention,
): Promise<{ result: Record<string, number>; dryRun: boolean }> {
  const dryRun = applicantRetentionMustBeDryRun(requestedDryRun, deleteSetting)
  return { result: await cleanup(now, dryRun), dryRun }
}

async function deleteBlob(path: string): Promise<boolean> {
  if (!path) return true
  try { await del(path); return true } catch (error) { console.error('[applicant-retention] blob delete', error); return false }
}

// Daily cleanup is dry-run unless APPLICANT_RETENTION_DELETE_ENABLED=true. Blob
// deletion happens before metadata removal; a storage failure leaves the record
// intact so the next run can retry. Legal hold overrides every deletion class.
export async function cleanupApplicantRetention(now = Date.now(), dryRun = true): Promise<Record<string, number>> {
  const counts = { scanned: 0, held: 0, abandonedUploads: 0, documents: 0, records: 0, rejectionStamped: 0, errors: 0 }
  const pending = await pendingContractorUploadsBefore(now - APPLICANT_RETENTION.abandonedUploadMs)
  for (const upload of pending) {
    const owner = upload.applicantId ? await getApplicant(upload.applicantId) : null
    if (owner?.documents.some(doc => doc.url === upload.path)) {
      if (!dryRun) await removePendingContractorUpload(upload.id)
      continue
    }
    if (dryRun) { counts.abandonedUploads++; continue }
    if (await deleteBlob(upload.path)) { await removePendingContractorUpload(upload.id); counts.abandonedUploads++ }
    else counts.errors++
  }

  for (const applicant of await listApplicants()) {
    counts.scanned++
    // One-time backfill: freeze the rejection instant onto the record so no later
    // edit can move it. Done even in dry-run — writing a stable timestamp deletes
    // nothing, and leaving it unwritten is what allowed the clock to drift.
    if (applicant.status === 'rejected' && applicant.rejectedAt === undefined) {
      applicant.rejectedAt = rejectionEventAt(applicant) ?? applicant.updatedAt
      await saveApplicant(applicant)
      counts.rejectionStamped++
    }
    const decision = applicantRetentionDecision(applicant, now)
    if (decision.held) { counts.held++; continue }
    if (decision.purgeRecord) {
      if (dryRun) { counts.records++; continue }
      const deleted = await Promise.all(applicant.documents.map(doc => deleteBlob(doc.url)))
      if (deleted.some(ok => !ok)) { counts.errors++; continue }
      await recordAudit({ actor: 'system', actorRole: 'system', action: 'applicant.retention_purged', entity: 'applicant', entityId: applicant.id, summary: 'Applicant record reached its retention deadline and was purged.', meta: { applicantNumber: applicant.applicantNumber } })
      await purgeApplicantAfterRetention(applicant)
      counts.records++
      continue
    }
    const kinds = new Set<string>()
    if (decision.purgeRejectedDocuments) for (const kind of sensitiveRejectedKinds) kinds.add(kind)
    if (decision.purgeW9) kinds.add('w9')
    const targets = applicant.documents.filter(doc => kinds.has(doc.kind))
    if (!targets.length && !decision.purgeW9) continue
    if (dryRun) { counts.documents += targets.length; continue }
    if (targets.length) {
      const deleted = await Promise.all(targets.map(doc => deleteBlob(doc.url)))
      if (deleted.some(ok => !ok)) { counts.errors++; continue }
      applicant.documents = applicant.documents.filter(doc => !kinds.has(doc.kind))
      if (kinds.has('headshot')) applicant.badgeHeadshotUrl = undefined
      pushApplicantEvent(applicant, 'system', 'Sensitive documents purged under retention policy')
      await saveApplicant(applicant)
    }
    if (decision.purgeW9 && applicant.promotedStaffId) {
      const staff = await getStaff(applicant.promotedStaffId)
      if (staff?.w9) {
        staff.w9 = { status: 'not_collected', addressComplete: staff.w9.addressComplete }
        await saveStaff(staff)
      }
    }
    counts.documents += targets.length
  }
  return counts
}
