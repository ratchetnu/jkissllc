import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const route = readFileSync(new URL('../app/api/portal/upload/route.ts', import.meta.url), 'utf8')
const page = readFileSync(new URL('../app/portal/jobs/[id]/page.tsx', import.meta.url), 'utf8')

test('crew completion uploads use the OIDC-compatible presigned Blob transport end to end', () => {
  assert.match(route, /handleUploadPresigned/)
  assert.match(route, /issueSignedToken/)
  assert.match(route, /operations:\s*\['put'\]/)
  assert.match(route, /requireCrew\(req\)/)
  assert.match(route, /maximumSizeInBytes\s*=\s*15\s*\*\s*1024\s*\*\s*1024/)
  assert.match(page, /uploadPresigned/)

  assert.doesNotMatch(route, /\bhandleUpload\(/)
  assert.doesNotMatch(page, /\bupload\(/)
})
