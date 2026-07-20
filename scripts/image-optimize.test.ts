import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Jimp } from 'jimp'
import {
  optimizeForModel, optimizeDataUrlForModel, estimateImageTokens,
  DEFAULT_MAX_EDGE,
} from '../app/lib/image-optimize'

// Build a real, decodable JPEG at the given dimensions (deterministic content).
async function jpegOf(w: number, h: number, quality = 92): Promise<Buffer> {
  const img = new Jimp({ width: w, height: h, color: 0x3366aaff })
  // Composite a lighter quadrant so it isn't a single flat color (still deterministic).
  const patch = new Jimp({ width: Math.floor(w / 2), height: Math.floor(h / 2), color: 0xddaa22ff })
  img.composite(patch, 0, 0)
  return (await img.getBuffer('image/jpeg', { quality })) as Buffer
}

test('estimateImageTokens ≈ w·h / 750, 0 for degenerate dims', () => {
  assert.equal(estimateImageTokens(1500, 750), Math.ceil((1500 * 750) / 750))
  assert.equal(estimateImageTokens(0, 100), 0)
  assert.equal(estimateImageTokens(undefined, undefined), 0)
})

test('a large JPEG is downscaled to the long-edge cap and tokens drop', async () => {
  const buf = await jpegOf(3000, 2000)
  const r = await optimizeForModel(buf, 'image/jpeg')
  assert.equal(r.metrics.applied, true)
  assert.equal(r.contentType, 'image/jpeg')
  assert.equal(r.ext, 'jpg')
  assert.equal(Math.max(r.metrics.optimizedWidth!, r.metrics.optimizedHeight!), DEFAULT_MAX_EDGE)
  assert.ok(r.metrics.estTokenReductionPct! > 0, 'tokens should be reduced')
  assert.ok(r.metrics.pixelReductionPct! > 0)
  assert.ok(r.metrics.ops.includes('orient'))
  assert.ok(r.metrics.ops.includes('strip_metadata'))
  assert.ok(r.metrics.ops.includes('resize'))
  assert.ok(r.metrics.ops.includes('quality'))
})

test('an already-small image is not upscaled (no resize op)', async () => {
  const buf = await jpegOf(800, 600)
  const r = await optimizeForModel(buf, 'image/jpeg')
  // May still be applied (re-encode) or no_gain; either way it is never enlarged.
  assert.ok((r.metrics.optimizedWidth ?? 800) <= 800)
  assert.ok(!r.metrics.ops.includes('resize'))
})

test('undecodable content type passes through unchanged (never throws)', async () => {
  const buf = Buffer.from([1, 2, 3, 4])
  const r = await optimizeForModel(buf, 'image/webp')
  assert.equal(r.metrics.applied, false)
  assert.ok(r.metrics.skippedReason!.startsWith('undecodable_type'))
  assert.equal(r.buffer, buf) // original returned untouched
})

test('garbage bytes for a decodable type fail soft to the original', async () => {
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]) // PNG magic then junk
  const r = await optimizeForModel(buf, 'image/png')
  assert.equal(r.metrics.applied, false)
  assert.ok(/decode_failed|no_gain/.test(r.metrics.skippedReason!))
  assert.equal(r.buffer, buf)
})

test('empty buffer is a safe passthrough', async () => {
  const r = await optimizeForModel(Buffer.alloc(0), 'image/jpeg')
  assert.equal(r.metrics.applied, false)
  assert.equal(r.metrics.skippedReason, 'empty')
})

test('higher-risk ops run when enabled and still produce a valid derivative', async () => {
  const buf = await jpegOf(2000, 1500)
  const r = await optimizeForModel(buf, 'image/jpeg', {
    autocrop: true, normalize: true, sharpen: true, denoise: true,
  })
  assert.equal(r.metrics.applied, true)
  for (const op of ['autocrop', 'normalize', 'denoise', 'sharpen']) {
    assert.ok(r.metrics.ops.includes(op), `expected op ${op}`)
  }
  // The output must still decode as an image.
  const decoded = await Jimp.read(r.buffer)
  assert.ok(decoded.width > 0 && decoded.height > 0)
})

test('optimizeDataUrlForModel shrinks a large data URL and stays a jpeg data URL', async () => {
  const buf = await jpegOf(3000, 2000)
  const dataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`
  const { dataUrl: out, metrics } = await optimizeDataUrlForModel(dataUrl)
  assert.equal(metrics.applied, true)
  assert.ok(out.startsWith('data:image/jpeg;base64,'))
  assert.ok(out.length < dataUrl.length, 'optimized data URL should be smaller')
})

test('optimizeDataUrlForModel passes a non-data-url string through', async () => {
  const { dataUrl, metrics } = await optimizeDataUrlForModel('https://x/y.jpg')
  assert.equal(dataUrl, 'https://x/y.jpg')
  assert.equal(metrics.applied, false)
})
