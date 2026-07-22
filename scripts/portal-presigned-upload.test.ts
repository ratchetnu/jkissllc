import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Set before the route module is imported: it pulls in the session and flag
// modules, which read these at load time.
process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret-32byteslong!!'
process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'
process.env.BLOB_WEBHOOK_PUBLIC_KEY = 'test-webhook-public-key'

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

// ── Malformed body: BEHAVIOURAL, not source-text ─────────────────────────────
// Found against the deployed Preview, not by these tests: `await req.json()` ran
// OUTSIDE the try/catch, so a truncated or malformed POST — a phone losing signal
// mid-upload is the ordinary cause — threw unhandled and answered 500 with an
// empty body, bypassing the whole safe-shape contract this route exists to keep.
// Every other test in this file reads the file as a string, which is exactly why
// none of them could catch it. These drive the real exported handler.

const CTX = { params: Promise.resolve({} as Record<string, string>) }

const withFlag = async <T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> => {
  const prev = process.env.BOOKING_ASSIGNMENT_ENABLED
  if (value === undefined) delete process.env.BOOKING_ASSIGNMENT_ENABLED
  else process.env.BOOKING_ASSIGNMENT_ENABLED = value
  try { return await fn() } finally {
    if (prev === undefined) delete process.env.BOOKING_ASSIGNMENT_ENABLED
    else process.env.BOOKING_ASSIGNMENT_ENABLED = prev
  }
}

const postRaw = async (raw: string) => {
  const { NextRequest } = await import('next/server')
  const { POST } = await import('../app/api/portal/upload/route')
  const req = new NextRequest('https://example.test/api/portal/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  })
  return POST(req, CTX)
}

test('malformed JSON answers the generic 400, never an unhandled 500', async () => {
  await withFlag('true', async () => {
    for (const raw of ['{not valid json', '', '{"type":', 'null']) {
      const res = await postRaw(raw)
      assert.notEqual(res.status, 500, `a malformed body must not escape as a 500: ${JSON.stringify(raw)}`)
      assert.equal(res.status, 400, `expected the generic client-error shape for ${JSON.stringify(raw)}`)
    }
  })
})

test('the malformed-JSON response carries ONLY the safe client message', async () => {
  await withFlag('true', async () => {
    const res = await postRaw('{not valid json')
    const body = await res.json()

    assert.deepEqual(body, {
      error: 'upload_failed',
      message: 'Upload failed — check your signal and try again.',
    })

    // No parser internals may reach a crew member's phone: a JSON SyntaxError
    // names the offending token and byte offset.
    const serialized = JSON.stringify(body)
    for (const leak of ['SyntaxError', 'Unexpected', 'position', 'JSON.parse', 'at Object']) {
      assert.ok(!serialized.includes(leak), `internal parser text leaked to the client: ${leak}`)
    }
  })
})

test('the flag gate still precedes body parsing — flag-off stays a bare 404', async () => {
  await withFlag('false', async () => {
    const res = await postRaw('{not valid json')
    assert.equal(res.status, 404)
    assert.deepEqual(await res.json(), { error: 'not_found' })
  })
})
