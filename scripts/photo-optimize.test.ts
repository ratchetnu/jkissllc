import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aiDerivativeUrl, resolveAiPhotoUrls } from '../app/lib/ai/photo-optimize'

const BLOB = 'https://store.public.blob.vercel-storage.com'

test('aiDerivativeUrl maps <id>.<ext> → <id>.ai.jpg on the same path', () => {
  assert.equal(
    aiDerivativeUrl(`${BLOB}/quote-photos/abc-123.jpg`),
    `${BLOB}/quote-photos/abc-123.ai.jpg`,
  )
  assert.equal(
    aiDerivativeUrl(`${BLOB}/quote-photos/abc-123.png?token=xyz`),
    `${BLOB}/quote-photos/abc-123.ai.jpg?token=xyz`,
  )
})

test('aiDerivativeUrl refuses a URL that is already a derivative', () => {
  assert.equal(aiDerivativeUrl(`${BLOB}/quote-photos/abc.ai.jpg`), null)
})

test('aiDerivativeUrl handles an extension-less filename deterministically', () => {
  assert.equal(aiDerivativeUrl(`${BLOB}/quote-photos/abc`), `${BLOB}/quote-photos/abc.ai.jpg`)
})

test('aiDerivativeUrl rejects non-URLs', () => {
  assert.equal(aiDerivativeUrl('not a url'), null)
  assert.equal(aiDerivativeUrl(''), null)
  // @ts-expect-error runtime guard
  assert.equal(aiDerivativeUrl(null), null)
})

test('resolveAiPhotoUrls is a no-op when optimization is disabled', async () => {
  const urls = [`${BLOB}/quote-photos/a.jpg`, `${BLOB}/quote-photos/b.jpg`]
  const r = await resolveAiPhotoUrls(urls, { enabled: false })
  assert.deepEqual(r.urls, urls)
  assert.equal(r.derivativeCount, 0)
})

test('resolveAiPhotoUrls swaps in derivatives that exist, keeps originals that do not', async () => {
  const a = `${BLOB}/quote-photos/a.jpg`
  const b = `${BLOB}/quote-photos/b.jpg`
  // Only a's derivative exists.
  const exists = async (u: string) => u === `${BLOB}/quote-photos/a.ai.jpg`
  const r = await resolveAiPhotoUrls([a, b], { enabled: true, exists })
  assert.deepEqual(r.urls, [`${BLOB}/quote-photos/a.ai.jpg`, b])
  assert.equal(r.derivativeCount, 1)
})

test('resolveAiPhotoUrls preserves order + length and never throws on exists() error', async () => {
  const urls = [`${BLOB}/quote-photos/a.jpg`, `${BLOB}/quote-photos/b.jpg`, `${BLOB}/quote-photos/c.jpg`]
  const exists = async (u: string) => { if (u.includes('b.ai')) throw new Error('network'); return true }
  const r = await resolveAiPhotoUrls(urls, { enabled: true, exists })
  assert.equal(r.urls.length, 3)
  assert.equal(r.urls[0], `${BLOB}/quote-photos/a.ai.jpg`)
  assert.equal(r.urls[1], `${BLOB}/quote-photos/b.jpg`) // fell back to original on error
  assert.equal(r.urls[2], `${BLOB}/quote-photos/c.ai.jpg`)
  assert.equal(r.derivativeCount, 2)
})

test('resolveAiPhotoUrls handles empty input', async () => {
  const r = await resolveAiPhotoUrls([], { enabled: true, exists: async () => true })
  assert.deepEqual(r.urls, [])
  assert.equal(r.derivativeCount, 0)
})
