import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('../app/admin/careers/page.tsx', import.meta.url), 'utf8')

test('admin careers page exposes an explicit approved-PDF publication ceremony', () => {
  assert.match(page, /className="file-input-a11y" type="file"[^>]+accept="application\/pdf,\.pdf"/)
  assert.match(page, /I confirm this exact PDF is the approved agreement authorized for contractor use\./)
  assert.match(page, /fetch\('\/api\/admin\/contractor-agreement'/)
  assert.match(page, /method: 'POST'/)
  assert.match(page, /disabled=\{!agreementFile \|\| !agreementApproved \|\| publishingAgreement\}/)
})

test('publication UI reports immutable versioning and successful onboarding unblock', () => {
  assert.match(page, /creates a new immutable version/)
  assert.match(page, /New onboarding requests can now be sent\./)
})
