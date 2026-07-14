// Photo-URL allow-list — the SSRF / cost-abuse / link-injection guard on the
// public quote routes. Only our Vercel Blob store is ever accepted.
import assert from 'node:assert/strict'
import test from 'node:test'

import { isAllowedPhotoUrl, filterPhotoUrls } from '../app/lib/photo-url'

const BLOB = 'https://abc123.public.blob.vercel-storage.com/quote-photos/x-abc.jpg'

test('accepts our Vercel Blob host over https only', () => {
  assert.equal(isAllowedPhotoUrl(BLOB), true)
  assert.equal(isAllowedPhotoUrl('https://store.blob.vercel-storage.com/y.png'), true)
})

test('rejects arbitrary hosts, http, and non-URLs (SSRF / injection surface)', () => {
  assert.equal(isAllowedPhotoUrl('https://evil.example.com/x.jpg'), false)
  assert.equal(isAllowedPhotoUrl('http://abc.public.blob.vercel-storage.com/x.jpg'), false) // not https
  assert.equal(isAllowedPhotoUrl('https://169.254.169.254/latest/meta-data'), false)        // cloud metadata
  assert.equal(isAllowedPhotoUrl('https://public.blob.vercel-storage.com.evil.com/x'), false) // suffix spoof
  assert.equal(isAllowedPhotoUrl('javascript:alert(1)'), false)
  assert.equal(isAllowedPhotoUrl(''), false)
  assert.equal(isAllowedPhotoUrl(null), false)
  assert.equal(isAllowedPhotoUrl('data:image/png;base64,AAAA'), false)
})

test('filterPhotoUrls dedups, caps, and drops disallowed entries', () => {
  const out = filterPhotoUrls([BLOB, BLOB, 'https://evil.example.com/a.jpg', 'https://store.blob.vercel-storage.com/b.png'], 8)
  assert.deepEqual(out, [BLOB, 'https://store.blob.vercel-storage.com/b.png'])
  assert.equal(filterPhotoUrls([BLOB, 'https://store.blob.vercel-storage.com/2', 'https://store.blob.vercel-storage.com/3'], 2).length, 2)
  assert.deepEqual(filterPhotoUrls('not-an-array', 8), [])
})
