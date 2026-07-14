// Regression: `next build` (and CI, which has no production Upstash) prerenders
// "/", whose <Reviews/> server component reads listReviews() → redis.zrevrange.
// That read is non-critical (the homepage has a designed empty state), so it must
// fail SOFT to [] when Redis is not configured rather than throw
// UPSTASH_NOT_CONFIGURED and break the build. Only the not-configured case is
// swallowed — real Redis errors must still surface (asserted below).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listReviews } from '../app/lib/site-reviews'

async function withoutUpstash<T>(fn: () => Promise<T>): Promise<T> {
  const url = process.env.KV_REST_API_URL
  const token = process.env.KV_REST_API_TOKEN
  delete process.env.KV_REST_API_URL
  delete process.env.KV_REST_API_TOKEN
  try { return await fn() } finally {
    if (url !== undefined) process.env.KV_REST_API_URL = url
    if (token !== undefined) process.env.KV_REST_API_TOKEN = token
  }
}

test('listReviews() returns [] (does not throw) when Upstash is not configured', async () => {
  await withoutUpstash(async () => {
    const reviews = await listReviews()
    assert.deepEqual(reviews, [], 'homepage reviews read must fail-soft to an empty list at build time')
  })
})
