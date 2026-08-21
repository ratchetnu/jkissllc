import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { CONTRACTOR_ONBOARDING_DOCS, REQUIRED_DOCS } from '../app/lib/ats-config'
import { APPLICANT_RETENTION, applicantRetentionDecision } from '../app/lib/applicant-retention'
import type { Applicant } from '../app/lib/applicants'
import { contractorReadiness, staffCanAcceptAssignments, staffMayReceivePay } from '../app/lib/staff'

const DAY = 86_400_000
const NOW = 2_000_000_000_000

function applicant(over: Partial<Applicant> = {}): Applicant {
  return {
    id: 'a'.repeat(32), applicantNumber: 'JK-A-1001', position: 'driver', name: 'Pat Contractor',
    email: 'pat@example.test', phone: '2145550101', skills: {}, scenarios: [], documents: [],
    score: { score: 0, band: 'not_qualified', components: [], strengths: [], weaknesses: [], riskFactors: [], suggestedQuestions: [], scenarioRubric: { safety: 0, customerService: 0, problemSolving: 0, honesty: 0, professionalism: 0 }, documentsComplete: true, missingDocs: [] },
    status: 'new', createdAt: NOW, updatedAt: NOW, ...over,
  }
}

test('public contractor applications require no identity, tax, agreement, insurance, or badge uploads', () => {
  assert.deepEqual(REQUIRED_DOCS.driver, [])
  assert.deepEqual(REQUIRED_DOCS.helper, [])
  for (const position of ['driver', 'helper'] as const) {
    assert.equal(CONTRACTOR_ONBOARDING_DOCS[position].some(doc => doc.kind === 'ss_card'), false)
    assert.equal(CONTRACTOR_ONBOARDING_DOCS[position].some(doc => doc.kind === 'w9'), true)
    assert.equal(CONTRACTOR_ONBOARDING_DOCS[position].some(doc => doc.kind === 'contractor_agreement'), false,
      'Operion generates the final agreement after two-party electronic signature')
    assert.equal(CONTRACTOR_ONBOARDING_DOCS[position].some(doc => doc.kind === 'headshot'), true)
  }
  assert.equal(CONTRACTOR_ONBOARDING_DOCS.driver.some(doc => doc.kind === 'drivers_license'), true)
  assert.equal(CONTRACTOR_ONBOARDING_DOCS.helper.some(doc => doc.kind === 'drivers_license'), false)
})

test('the legacy public upload route is closed and the application drops document input', () => {
  const root = path.resolve(process.cwd())
  const upload = fs.readFileSync(path.join(root, 'app/api/careers/upload/route.ts'), 'utf8')
  const apply = fs.readFileSync(path.join(root, 'app/api/careers/apply/route.ts'), 'utf8')
  assert.match(upload, /status: 410/)
  assert.doesNotMatch(upload, /KINDS.*ss_card/)
  assert.match(apply, /documents: \[\]/)
  assert.doesNotMatch(apply, /body\.documents/)
})

test('ending the contractor relationship invalidates both onboarding submission and upload routes', () => {
  const root = path.resolve(process.cwd())
  const submission = fs.readFileSync(path.join(root, 'app/api/careers/onboarding/route.ts'), 'utf8')
  const upload = fs.readFileSync(path.join(root, 'app/api/careers/onboarding/upload/route.ts'), 'utf8')
  assert.match(submission, /applicant\.contractEndedAt/)
  assert.match(upload, /applicant\.contractEndedAt/)
})

test('rejected contractor retention waits 30 days for documents and four years for the application', () => {
  const deniedAt = NOW - APPLICANT_RETENTION.rejectedSensitiveDocumentMs
  const a = applicant({ status: 'rejected', updatedAt: deniedAt, events: [{ at: deniedAt, actor: 'admin', action: 'Status → Denied' }] })
  const justBefore = applicantRetentionDecision(a, NOW - 1)
  assert.equal(justBefore.purgeRejectedDocuments, false)
  assert.equal(justBefore.purgeRecord, false)
  const atThirtyDays = applicantRetentionDecision(a, NOW)
  assert.equal(atThirtyDays.purgeRejectedDocuments, true)
  assert.equal(atThirtyDays.purgeRecord, false)
  const atFourYears = applicantRetentionDecision(a, deniedAt + APPLICANT_RETENTION.rejectedApplicationMs)
  assert.equal(atFourYears.purgeRecord, true)
})

test('approved contractor W-9 and record clocks start only when the relationship ends', () => {
  const active = applicant({ status: 'hired', promotedStaffId: 'staff-1' })
  assert.deepEqual(applicantRetentionDecision(active, NOW + 20 * 365 * DAY), { held: false, purgeRejectedDocuments: false, purgeW9: false, purgeRecord: false })
  const endedAt = NOW - APPLICANT_RETENTION.w9Ms
  const ended = applicant({ status: 'hired', promotedStaffId: 'staff-1', contractEndedAt: endedAt })
  assert.equal(applicantRetentionDecision(ended, NOW).purgeW9, true)
  assert.equal(applicantRetentionDecision(ended, NOW).purgeRecord, false)
  assert.equal(applicantRetentionDecision(ended, endedAt + APPLICANT_RETENTION.approvedRecordMs).purgeRecord, true)
})

test('a legal hold suspends every deletion regardless of age', () => {
  const old = applicant({
    status: 'rejected', updatedAt: 1, events: [{ at: 1, actor: 'admin', action: 'Status → Denied' }],
    contractEndedAt: 1, promotedStaffId: 'staff-1',
    legalHold: { active: true, placedAt: 2, placedBy: 'admin', reason: 'Dispute' },
  })
  assert.deepEqual(applicantRetentionDecision(old, NOW), { held: true, purgeRejectedDocuments: false, purgeW9: false, purgeRecord: false })
})

test('contractor readiness is one shared gate for work and pay', () => {
  const pending = { active: false, contractorStatus: 'pending_onboarding' as const }
  assert.equal(staffCanAcceptAssignments(pending), false)
  assert.equal(staffMayReceivePay(pending), false)
  assert.equal(contractorReadiness(pending).nextAction, 'Contractor completes secure onboarding')

  const submitted = { active: false, contractorStatus: 'pending_verification' as const }
  assert.equal(staffCanAcceptAssignments(submitted), false)
  assert.equal(staffMayReceivePay(submitted), false)

  const ready = { active: true, contractorStatus: 'ready' as const }
  assert.equal(staffCanAcceptAssignments(ready), true)
  assert.equal(staffMayReceivePay(ready), true)

  const ended = { active: false, contractorStatus: 'ended' as const }
  assert.equal(staffCanAcceptAssignments(ended), false)
  assert.equal(staffMayReceivePay(ended), true, 'final and historical statements remain possible after work ends')

  assert.equal(staffCanAcceptAssignments({ active: true }), true, 'legacy crew retain active semantics')
})
