// Sprint 4 acceptance: public quote submissions persist into the same booking
// store OpsPilot reads, preserve photo boundaries, and dedupe browser retries.
import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

process.env.KV_REST_API_URL = 'http://sprint4-kv.local'
process.env.KV_REST_API_TOKEN = 'test-token'
delete process.env.RESEND_API_KEY
delete process.env.OWNER_SMS

const KV = 'http://sprint4-kv.local'
const values = new Map<string, string>()
const zsets = new Map<string, Map<string, number>>()
const zset = (key: string) => zsets.get(key) ?? zsets.set(key, new Map()).get(key)!

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url) !== KV) {
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const [rawCommand, ...args] = JSON.parse(String(init?.body)) as string[]
  const command = rawCommand.toUpperCase()
  const key = args[0]
  let result: unknown = null
  switch (command) {
    case 'GET':
      result = values.get(key) ?? null
      break
    case 'SET': {
      const nx = args.some(arg => arg.toUpperCase() === 'NX')
      if (nx && values.has(key)) result = null
      else {
        values.set(key, args[1])
        result = 'OK'
      }
      break
    }
    case 'DEL':
      result = values.delete(key) ? 1 : 0
      break
    case 'INCR': {
      const next = Number(values.get(key) ?? 0) + 1
      values.set(key, String(next))
      result = next
      break
    }
    case 'ZADD':
      zset(key).set(args[2], Number(args[1]))
      result = 1
      break
    case 'ZREVRANGE': {
      const start = Number(args[1])
      const stop = Number(args[2])
      result = [...zset(key).entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(start, stop + 1)
        .map(([member]) => member)
      break
    }
    case 'PEXPIRE':
    case 'EXPIRE':
      result = 1
      break
    default:
      throw new Error(`Sprint 4 fake KV does not implement ${command}`)
  }
  return new Response(JSON.stringify({ result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}) as typeof fetch

import { persistQuoteRequest } from '../app/lib/booking-requests'
import { listBookings } from '../app/lib/bookings'
import { bookNowStage, isBookNow } from '../app/lib/book-now-queue'

const photo = (n: number) =>
  `https://sprint4.public.blob.vercel-storage.com/quote-${n}.jpg`

beforeEach(() => {
  values.clear()
  zsets.clear()
})

test('zero, one, and six-photo submissions persist and read back through OpsPilot', async () => {
  const zero = await persistQuoteRequest({
    name: 'Zero Photos',
    serviceType: 'junk-removal',
    photos: [],
    idempotencyKey: 'sprint4-zero',
  })
  const one = await persistQuoteRequest({
    name: 'One Photo',
    serviceType: 'junk-removal',
    photos: [photo(1)],
    idempotencyKey: 'sprint4-one',
  })
  const six = await persistQuoteRequest({
    name: 'Six Photos',
    serviceType: 'junk-removal',
    photos: Array.from({ length: 6 }, (_, i) => photo(i + 1)),
    idempotencyKey: 'sprint4-six',
  })

  assert.ok(zero && one && six)
  assert.equal(zero.invoicePhotos?.length, 0)
  assert.equal(one.invoicePhotos?.length, 1)
  assert.equal(six.invoicePhotos?.length, 6)
  assert.equal(zero.aiJob, undefined)
  assert.equal(one.aiJob?.status, 'queued')
  assert.equal(six.aiJob?.status, 'queued')

  const opsRows = await listBookings()
  assert.equal(opsRows.length, 3)
  assert.ok(opsRows.every(isBookNow))
  assert.equal(bookNowStage(opsRows.find(row => row.token === zero.token)!), 'awaiting_photos')
  assert.equal(bookNowStage(opsRows.find(row => row.token === one.token)!), 'ai_queued')
  assert.equal(bookNowStage(opsRows.find(row => row.token === six.token)!), 'ai_queued')
})

test('replaying the same quote idempotency key returns one durable booking', async () => {
  const input = {
    name: 'Duplicate Submit',
    serviceType: 'junk-removal' as const,
    photos: [photo(1)],
    idempotencyKey: 'sprint4-duplicate',
  }
  const first = await persistQuoteRequest(input)
  const replay = await persistQuoteRequest(input)

  assert.ok(first && replay)
  assert.equal(replay.token, first.token)
  assert.equal(replay.bookingNumber, first.bookingNumber)
  assert.equal((await listBookings()).length, 1)
})

test('provider failure still saves a manual-review booking and queues recovery', async () => {
  const url = photo(1)
  const analysisId = 'sprint4-failed-analysis'
  values.set(`qa:${analysisId}`, JSON.stringify({
    id: analysisId,
    createdAt: '2026-07-30T00:00:00.000Z',
    status: 'failed',
    decision: 'manual_review',
    provider: 'unavailable',
    model: 'unavailable',
    schemaVersion: 1,
    inputPhotoUrls: [url],
    analysis: {
      bookingId: 'draft',
      confidence: { overall: 0 },
    },
    pricing: {
      recommendedUsd: 0,
      lowUsd: 0,
      highUsd: 0,
      breakdown: { disposalCents: 0 },
    },
    reviewReasons: ['AI provider unavailable — manual review required.'],
  }))

  const saved = await persistQuoteRequest({
    name: 'Provider Failure',
    serviceType: 'junk-removal',
    photos: [url],
    analysisId,
    idempotencyKey: 'sprint4-provider-failure',
  })

  assert.ok(saved)
  assert.equal(saved.aiEstimate?.status, 'failed')
  assert.equal(saved.aiEstimate?.decision, 'manual_review')
  assert.equal(saved.aiJob?.status, 'queued', 'transient provider recovery remains durable')
  const opsRow = (await listBookings()).find(row => row.token === saved.token)
  assert.ok(opsRow, 'manual-review evidence is readable in OpsPilot')
  assert.equal(opsRow.aiEstimate?.reviewReasons[0], 'AI provider unavailable — manual review required.')
})
