import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  toModelReadableImage, toModelReadableDataUrl, isHeic, UnreadableImageError,
} from '../app/lib/image-convert'

// A fake HEIC→JPEG converter so tests never need the wasm decoder or a real HEIC file.
const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) // JPEG SOI-ish
const okConvert = async () => fakeJpeg
const emptyConvert = async () => Buffer.alloc(0)
const throwConvert = async () => { throw new Error('libheif: not a heic') }

test('non-HEIC images pass through unchanged (no conversion)', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const r = await toModelReadableImage(png, 'image/png', okConvert)
  assert.equal(r.contentType, 'image/png')
  assert.equal(r.ext, 'png')
  assert.equal(r.buffer, png) // same buffer, untouched
})

test('jpeg keeps the jpg extension', async () => {
  const r = await toModelReadableImage(Buffer.from([1]), 'image/jpeg', okConvert)
  assert.equal(r.ext, 'jpg')
  assert.equal(r.contentType, 'image/jpeg')
})

test('HEIC is converted to JPEG', async () => {
  const heic = Buffer.from([0, 0, 0, 24]) // pretend HEIC bytes
  const r = await toModelReadableImage(heic, 'image/heic', okConvert)
  assert.equal(r.contentType, 'image/jpeg')
  assert.equal(r.ext, 'jpg')
  assert.deepEqual(r.buffer, fakeJpeg)
})

test('HEIF is also converted', async () => {
  const r = await toModelReadableImage(Buffer.from([1]), 'image/heif', okConvert)
  assert.equal(r.contentType, 'image/jpeg')
})

test('an undecodable HEIC throws UnreadableImageError (empty output)', async () => {
  await assert.rejects(() => toModelReadableImage(Buffer.from([1]), 'image/heic', emptyConvert), UnreadableImageError)
})

test('a converter that throws surfaces as UnreadableImageError', async () => {
  await assert.rejects(() => toModelReadableImage(Buffer.from([1]), 'image/heic', throwConvert), UnreadableImageError)
})

test('isHeic detects heic/heif case-insensitively', () => {
  assert.equal(isHeic('image/heic'), true)
  assert.equal(isHeic('IMAGE/HEIF'), true)
  assert.equal(isHeic('image/jpeg'), false)
})

test('toModelReadableDataUrl: non-HEIC data URL is unchanged', async () => {
  const url = 'data:image/png;base64,iVBOR'
  assert.equal(await toModelReadableDataUrl(url, okConvert), url)
})

test('toModelReadableDataUrl: HEIC data URL becomes a JPEG data URL', async () => {
  const url = `data:image/heic;base64,${Buffer.from([0, 0, 0, 24]).toString('base64')}`
  const out = await toModelReadableDataUrl(url, okConvert)
  assert.ok(out.startsWith('data:image/jpeg;base64,'))
  assert.equal(out, `data:image/jpeg;base64,${fakeJpeg.toString('base64')}`)
})

test('toModelReadableDataUrl: non-data-url string passes through', async () => {
  assert.equal(await toModelReadableDataUrl('https://x/y.heic', okConvert), 'https://x/y.heic')
})
