// Applicant lifecycle helpers — activity timeline + status vocabulary. Pure.
import assert from 'node:assert/strict'
import test from 'node:test'
import { pushApplicantEvent, APPLICANT_STATUS_LABEL, APPLICANT_INACTIVE, type Applicant } from '../app/lib/applicants'

test('pushApplicantEvent appends to the timeline and caps at 200', () => {
  const a = { events: [] } as unknown as Applicant
  pushApplicantEvent(a, 'admin', 'Status → Approved', 'was New')
  assert.equal(a.events!.length, 1)
  assert.equal(a.events![0].action, 'Status → Approved')
  assert.equal(a.events![0].note, 'was New')
  assert.equal(a.events![0].actor, 'admin')
  // Blank notes collapse to undefined.
  pushApplicantEvent(a, 'admin', 'Note updated', '   ')
  assert.equal(a.events![1].note, undefined)
  // Cap.
  for (let i = 0; i < 250; i++) pushApplicantEvent(a, 'admin', `e${i}`)
  assert.equal(a.events!.length, 200)
  // Initializes a missing array.
  const b = {} as unknown as Applicant
  pushApplicantEvent(b, 'applicant', 'Application submitted')
  assert.equal(b.events!.length, 1)
})

test('the requested applicant statuses all exist with labels', () => {
  for (const s of ['new', 'reviewed', 'information_requested', 'interview', 'second_interview', 'waitlist', 'hired', 'rejected', 'withdrawn', 'archived'] as const)
    assert.ok(APPLICANT_STATUS_LABEL[s], `label for ${s}`)
  // The request's user-facing names map onto our statuses.
  assert.equal(APPLICANT_STATUS_LABEL.reviewed, 'Under Review')
  assert.equal(APPLICANT_STATUS_LABEL.information_requested, 'Information Requested')
  assert.equal(APPLICANT_STATUS_LABEL.hired, 'Approved')
  assert.equal(APPLICANT_STATUS_LABEL.rejected, 'Denied')
  // Inactive = out of the active review queue.
  assert.deepEqual(APPLICANT_INACTIVE, ['rejected', 'withdrawn', 'archived'])
})
