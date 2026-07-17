// Photo content-hash de-duplication — exact duplicate uploads must collapse so they
// can't multiply the inventory/volume, while genuinely different photos are preserved.
import assert from 'node:assert/strict'
import test from 'node:test'
import { dedupePhotoUrls } from '../app/lib/ai/photo-dedup'

// Fake fetch: map url -> bytes. Identical bytes ⇒ same content hash ⇒ duplicate.
const fakeFetch = (bytes: Record<string, string>) => (async (url: string) => {
  const b = bytes[url]
  if (b === undefined) return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) } as any
  return { ok: true, arrayBuffer: async () => new TextEncoder().encode(b).buffer } as any
}) as unknown as typeof fetch

test('exact byte-duplicates collapse to one (order preserved)', async () => {
  const bytes = { 'u/a': 'IMG_ONE', 'u/b': 'IMG_ONE', 'u/c': 'IMG_TWO' }  // a and b identical
  const r = await dedupePhotoUrls(['u/a', 'u/b', 'u/c'], fakeFetch(bytes))
  assert.deepEqual(r.uniqueUrls, ['u/a', 'u/c'])
  assert.equal(r.duplicateCount, 1)
})

test('all-distinct photos are all kept', async () => {
  const bytes = { 'u/a': 'A', 'u/b': 'B', 'u/c': 'C' }
  const r = await dedupePhotoUrls(['u/a', 'u/b', 'u/c'], fakeFetch(bytes))
  assert.deepEqual(r.uniqueUrls, ['u/a', 'u/b', 'u/c'])
  assert.equal(r.duplicateCount, 0)
})

test('fail-open: a fetch error keeps the photo (never silently dropped)', async () => {
  const bad = (async () => { throw new Error('network') }) as unknown as typeof fetch
  const r = await dedupePhotoUrls(['u/a', 'u/b'], bad)
  assert.deepEqual(r.uniqueUrls, ['u/a', 'u/b'])
  assert.equal(r.duplicateCount, 0)
})

test('three identical uploads collapse to one', async () => {
  const bytes = { 'u/a': 'SAME', 'u/b': 'SAME', 'u/c': 'SAME' }
  const r = await dedupePhotoUrls(['u/a', 'u/b', 'u/c'], fakeFetch(bytes))
  assert.deepEqual(r.uniqueUrls, ['u/a'])
  assert.equal(r.duplicateCount, 2)
})
