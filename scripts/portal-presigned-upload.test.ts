import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const route = readFileSync(new URL('../app/api/portal/upload/route.ts', import.meta.url), 'utf8')
// The upload lives in the CLIENT half of the job screen; ./page.tsx is now the
// server component that gates the whole segment on BOOKING_ASSIGNMENT_ENABLED.
const page = readFileSync(new URL('../app/portal/jobs/[id]/JobDetailClient.tsx', import.meta.url), 'utf8')

test('crew completion uploads use the OIDC-compatible presigned Blob transport end to end', () => {
  assert.match(route, /handleUploadPresigned/)
  assert.match(route, /issueSignedToken/)
  assert.match(route, /operations:\s*\['put'\]/)
  assert.match(route, /oidcToken,\s*storeId,/)
  assert.match(route, /getVercelOidcToken\(\)/)
  assert.match(route, /parseStoreIdFromDelegationToken/)
  assert.match(route, /blob_store_not_configured/)
  assert.match(route, /blob_store_mismatch/)
  assert.match(route, /requireCrew\(req\)/)
  assert.match(route, /maximumSizeInBytes\s*=\s*15\s*\*\s*1024\s*\*\s*1024/)
  assert.match(page, /uploadPresigned/)

  assert.doesNotMatch(route, /\bhandleUpload\(/)
  assert.doesNotMatch(page, /\bupload\(/)
})

// ── P1-A: a misconfigured deployment must fail EXPLICITLY, not generically ───

test('P1-A: the flag gate still precedes every store lookup, so flag-off stays a bare 404', () => {
  const gate = route.indexOf("isEnabled('BOOKING_ASSIGNMENT_ENABLED')")
  // The CALL SITE, not the import line at the top of the file.
  const store = route.indexOf('completionUploadReadiness(process.env')
  assert.ok(gate > -1 && store > -1)
  assert.ok(gate < store, 'the 404 must short-circuit before any readiness or store logic runs')
  assert.match(route, /error: 'not_found' \}, \{ status: 404 \}/)
})

test('P1-A: readiness is delegated to the shared helper, with no silent fallback store', () => {
  assert.match(route, /completionUploadReadiness\(process\.env\.BLOB_STORE_ID\)/)
  assert.match(route, /if \(!readiness\.ready\) throw new Error\(readiness\.reason\)/)
  // The mismatch guard that verifies the minted token names the expected store
  // must survive — it is the second half of the fail-closed pair.
  assert.match(route, /parseStoreIdFromDelegationToken/)
  assert.match(route, /blob_store_mismatch/)
})

test('P1-A: configuration failures answer 503 with a distinguishable code, not a generic 400', () => {
  assert.match(route, /blob_store_not_configured:\s*\{\s*status:\s*503/)
  assert.match(route, /blob_store_mismatch:\s*\{\s*status:\s*503/)
  assert.match(route, /unauthorized:\s*\{\s*status:\s*401/)
})

test('P1-A: internal error text is never echoed to a client', () => {
  // The old handler returned `err.message` verbatim, so any Blob SDK internal made
  // it to a crew member's phone. Unknown causes now collapse to one safe shape.
  assert.doesNotMatch(route, /error:\s*msg/)
  assert.match(route, /error:\s*'upload_failed'/)
})

test('P1-A: the crew screen distinguishes "not set up" from "bad signal"', () => {
  assert.match(page, /blob_store_\(not_configured\|mismatch\)/)
  assert.match(page, /Tell the office/)
  // The retryable message must still exist for genuine transport failures.
  assert.match(page, /check your signal/)
})
