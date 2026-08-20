import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

process.env.ADMIN_SESSION_SECRET = 'applicant-workflow-test-secret-32bytes'

import {
  createApplicantDocumentReceipt, createApplicantInformationToken,
  transitionApplicantStatus, validSealedApplicantDocumentPath,
  verifyApplicantDocumentReceipt, verifyApplicantInformationToken,
} from '../app/lib/applicant-workflow'

test('hired can only be reached by a decision-maker through Approve → Crew', () => {
  assert.equal(transitionApplicantStatus('interview', 'hired', { canDecide: false, viaHireAction: true }).ok, false)
  assert.equal(transitionApplicantStatus('interview', 'hired', { canDecide: true }).ok, false)
  assert.equal(transitionApplicantStatus('interview', 'hired', { canDecide: true, viaHireAction: true }).ok, true)
  assert.equal(transitionApplicantStatus('hired', 'rejected', { canDecide: true }).ok, false, 'crew and applicant state cannot diverge')
})

test('reviewers may move the non-terminal workflow but cannot deny', () => {
  assert.equal(transitionApplicantStatus('new', 'interview', { canDecide: false }).ok, true)
  assert.equal(transitionApplicantStatus('new', 'information_requested', { canDecide: false }).ok, true)
  assert.equal(transitionApplicantStatus('new', 'rejected', { canDecide: false }).ok, false)
})

test('document receipts bind kind, path, draft, expiry, and signature', () => {
  const input = { draftId: 'draft-1234567890123456', kind: 'ss_card' as const, path: 'driver-docs/ss_card/abc.jpg.enc', now: 1_000 }
  const receipt = createApplicantDocumentReceipt(input)
  assert.equal(verifyApplicantDocumentReceipt({ ...input, receipt, now: 2_000 }), true)
  assert.equal(verifyApplicantDocumentReceipt({ ...input, receipt, path: 'https://evil.test/fake.jpg', now: 2_000 }), false)
  assert.equal(verifyApplicantDocumentReceipt({ ...input, receipt, draftId: 'another-1234567890123456', now: 2_000 }), false)
  assert.equal(verifyApplicantDocumentReceipt({ ...input, receipt: `${receipt}x`, now: 2_000 }), false)
  assert.equal(verifyApplicantDocumentReceipt({ ...input, receipt, now: 8 * 24 * 60 * 60_000 }), false)
})

test('information-request tokens expire and cannot be tampered with', () => {
  const token = createApplicantInformationToken({ applicantId: 'a'.repeat(32), email: 'Person@Example.com', requestedAt: 500, now: 1_000 })
  assert.equal(verifyApplicantInformationToken(token, 2_000)?.email, 'person@example.com')
  assert.equal(verifyApplicantInformationToken(`${token}x`, 2_000), null)
  assert.equal(verifyApplicantInformationToken(token, 8 * 24 * 60 * 60_000), null)
})

test('sealed applicant paths support tenancy without admitting another tenant', () => {
  assert.equal(validSealedApplicantDocumentPath('driver-docs/ss_card/abc.jpg.enc', 'jkiss'), true)
  assert.equal(validSealedApplicantDocumentPath('tenants/jkiss/driver-docs/ss_card/abc.jpg.enc', 'jkiss'), true)
  assert.equal(validSealedApplicantDocumentPath('tenants/acme/driver-docs/ss_card/abc.jpg.enc', 'jkiss'), false)
  assert.equal(validSealedApplicantDocumentPath('../driver-docs/ss_card/abc.jpg.enc', 'jkiss'), false)
})

test('admin and applicant routes retain the workflow protections at their boundaries', () => {
  const root = path.resolve(import.meta.dirname, '..')
  const admin = fs.readFileSync(path.join(root, 'app/api/admin/careers/route.ts'), 'utf8')
  const update = fs.readFileSync(path.join(root, 'app/api/careers/update/route.ts'), 'utf8')
  const apply = fs.readFileSync(path.join(root, 'app/api/careers/apply/route.ts'), 'utf8')
  assert.match(admin, /transitionApplicantStatus/)
  assert.match(admin, /withLock\(`app:lock:/)
  assert.match(admin, /if \(!delivery\.ok\)/)
  assert.match(update, /informationRequest\?\.requestedAt !== verified\.claims\.requestedAt/)
  assert.match(apply, /verifyApplicantDocumentReceipt/)
  assert.match(apply, /submitApplicantOnce/)
})
