import test from 'node:test'
import assert from 'node:assert/strict'
import { Jimp } from 'jimp'
import { reconcilePhotoSet } from '../app/lib/ai/photo-reconciliation'
import { normalizeMovingAnalysis } from '../app/lib/ai/analysis-schema-moving'
import { normalizeAnalysis } from '../app/lib/ai/analysis-schema'

async function jpeg(color: number, quality = 90): Promise<Buffer> {
  const image = new Jimp({ width: 32, height: 32, color })
  image.scan(0, 0, 16, 32, (_x, _y, index) => { image.bitmap.data[index] = 240 })
  return await image.getBuffer('image/jpeg', { quality }) as Buffer
}

function fetcher(files: Record<string, Buffer>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const data = files[String(input)]
    return data ? new Response(new Uint8Array(data), { status: 200, headers: { 'content-length': String(data.length) } }) : new Response('', { status: 404 })
  }) as typeof fetch
}

test('exact duplicate bytes contribute one active photo', async () => {
  const image = await jpeg(0x224466ff)
  const result = await reconcilePhotoSet(['https://blob/a.jpg', 'https://blob/b.jpg'], fetcher({
    'https://blob/a.jpg': image, 'https://blob/b.jpg': image,
  }))
  assert.equal(result.active.length, 1)
  assert.equal(result.exactDuplicateCount, 1)
  assert.equal(result.all[1].exactDuplicateOf, 'p0')
  assert.equal(result.all[1].duplicateRelationshipConfidence, 1)
})

test('re-encoded views are evidence, not automatic additional inventory', async () => {
  const original = await jpeg(0x224466ff, 92)
  const reencoded = await jpeg(0x224466ff, 65)
  const result = await reconcilePhotoSet(['https://blob/a.jpg', 'https://blob/crop.jpg'], fetcher({
    'https://blob/a.jpg': original, 'https://blob/crop.jpg': reencoded,
  }))
  assert.equal(result.active.length, 2)
  assert.equal(result.nearDuplicateCount, 1)
  assert.equal(result.all[1].nearDuplicateOf, 'p0')
  assert.ok(result.all[1].duplicateRelationshipConfidence >= 0.5)
})

test('distinct photos remain separate', async () => {
  const a = await jpeg(0x224466ff)
  const b = await jpeg(0xee6622ff)
  const result = await reconcilePhotoSet(['https://blob/a.jpg', 'https://blob/b.jpg'], fetcher({
    'https://blob/a.jpg': a, 'https://blob/b.jpg': b,
  }))
  assert.equal(result.active.length, 2)
  assert.equal(result.exactDuplicateCount, 0)
})

test('fingerprints are request-local and cannot leak across tenants', async () => {
  const same = await jpeg(0x224466ff)
  const tenantA = await reconcilePhotoSet(['https://blob/tenant-a.jpg'], fetcher({ 'https://blob/tenant-a.jpg': same }))
  const tenantB = await reconcilePhotoSet(['https://blob/tenant-b.jpg'], fetcher({ 'https://blob/tenant-b.jpg': same }))
  assert.equal(tenantA.exactDuplicateCount, 0)
  assert.equal(tenantB.exactDuplicateCount, 0)
  assert.equal(tenantB.all[0].exactDuplicateOf, undefined)
})

test('moving same-item-across-views preserves all source photo ids once', () => {
  const analysis = normalizeMovingAnalysis(JSON.stringify({
    items: [{ cat: 'furn', l: 'sofa', q: 1, s: 'l', v: 85, c: 0.72, p: [0, 1] }],
    truck: [0.1, 0.2, 0.3], crew: [2, 2, 3], load: [1, 2, 3], unload: [1, 2, 3],
    conf: { o: 0.65, i: 0.7, q: 0.65, v: 0.7, a: 0.5, l: 0.65 },
  }), { analysisId: 'a', bookingId: 'b', photoUrls: ['u0', 'u1'], modelProvider: 'test', modelName: 'test', analyzedAt: 'now' })
  assert.equal(analysis.normalizedItems.length, 1)
  assert.deepEqual(analysis.normalizedItems[0].sourcePhotoIds ?? [], ['p0', 'p1'])
  assert.equal(analysis.normalizedItems[0].quantity.likely, 1)
})

test('junk reconciled inventory preserves source photo ids', () => {
  const analysis = normalizeAnalysis({ normalizedItems: [{
    category: 'furniture', label: 'sofa', estimatedQuantity: 1, estimatedVolumeCubicYards: 3,
    confidence: 0.7, sourcePhotoIds: ['p0', 'p1'],
  }], confidence: { overall: 0.7, volume: 0.7 } }, {
    analysisId: 'a', bookingId: 'b', photoUrls: ['u0', 'u1'], modelProvider: 'test', modelName: 'test', analyzedAt: 'now',
  })
  assert.equal(analysis.normalizedItems.length, 1)
  assert.deepEqual(analysis.normalizedItems[0].sourcePhotoIds ?? [], ['p0', 'p1'])
})
