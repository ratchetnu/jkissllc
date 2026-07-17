// ── Operion Shadow — owner evaluation actions (PURE decision core) ───────────
//
// The owner works a disagreement: classifies it (FP/FN/…), assigns it, or adds a note.
// This is the pure transform (job + action → updated job + audit intent); the route does the
// I/O (save + recordPlatformAudit). No clock/randomness → the caller passes `now`/`actor`,
// so every transition is unit-testable. Shadow-only diagnostics — never a customer price.

import type { V2ShadowJob, ShadowClassification } from './shadow-types'

export const CLASSIFICATIONS: readonly ShadowClassification[] = [
  'false_positive', 'false_negative', 'needs_investigation', 'expected_difference', 'accepted_v2', 'ignored',
] as const

export function isClassification(v: unknown): v is ShadowClassification {
  return typeof v === 'string' && (CLASSIFICATIONS as readonly string[]).includes(v)
}

export type ShadowAction =
  | { type: 'classify'; classification: ShadowClassification }
  | { type: 'assign'; assignee: string }
  | { type: 'note'; note: string }
  | { type: 'clear_classification' }

export type ApplyResult =
  | { ok: true; job: V2ShadowJob; auditAction: string; summary: string; priorStatus?: string; newStatus?: string }
  | { ok: false; error: string }

const MAX_NOTES = 50

/** Apply one owner action to a shadow job. Returns a NEW job object + the audit intent. */
export function applyShadowAction(job: V2ShadowJob, action: ShadowAction, actor: string, now: number): ApplyResult {
  const base: V2ShadowJob = { ...job, updatedAt: now }
  switch (action.type) {
    case 'classify': {
      if (!isClassification(action.classification)) return { ok: false, error: 'invalid classification' }
      const prior = job.classification
      return {
        ok: true,
        job: { ...base, classification: action.classification, classifiedBy: actor, classifiedAt: now },
        auditAction: 'status.manual_correction',
        summary: `Classified shadow ${job.bookingId}: ${prior ?? '(none)'} → ${action.classification}`,
        priorStatus: prior, newStatus: action.classification,
      }
    }
    case 'clear_classification':
      return {
        ok: true,
        job: { ...base, classification: undefined, classifiedBy: undefined, classifiedAt: undefined },
        auditAction: 'status.manual_correction',
        summary: `Cleared classification on shadow ${job.bookingId}`,
        priorStatus: job.classification, newStatus: '(none)',
      }
    case 'assign': {
      const a = action.assignee.trim().slice(0, 120)
      if (!a) return { ok: false, error: 'assignee required' }
      return { ok: true, job: { ...base, assignee: a }, auditAction: 'status.manual_correction', summary: `Assigned shadow ${job.bookingId} to ${a}` }
    }
    case 'note': {
      const n = action.note.trim().slice(0, 2000)
      if (!n) return { ok: false, error: 'note is empty' }
      const notes = [...(job.ownerNotes ?? []), { note: n, by: actor, at: now }].slice(-MAX_NOTES)
      return { ok: true, job: { ...base, ownerNotes: notes }, auditAction: 'status.manual_correction', summary: `Note added to shadow ${job.bookingId}` }
    }
    default:
      return { ok: false, error: 'unknown action' }
  }
}
