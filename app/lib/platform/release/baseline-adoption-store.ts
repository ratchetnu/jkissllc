// ── Operion baseline adoption store (server-only) ────────────────────────────
//
// One atomic Lua write updates the business and appends its evidence record. The script
// compares the exact business JSON read for the dry run, so concurrent drift refuses the
// adoption instead of applying approval to a different baseline.

import { redis } from '../../redis'
import type { PlatformBusiness } from '../updates/types'
import type { BaselineAdoptionRecord } from './baseline-adoption'

const K_RECORD = 'platform:baseline-adoption:'
const K_INDEX = 'platform:baseline-adoption:index'
const K_BUSINESS = 'platform:business:'

const ADOPT_ATOMIC = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], ARGV[3])
redis.call('ZADD', KEYS[3], ARGV[4], ARGV[5])
return 1
`

export async function persistApprovedAdoption(input: {
  expectedBusiness: PlatformBusiness
  nextBusiness: PlatformBusiness
  record: BaselineAdoptionRecord
}): Promise<'written' | 'business_changed'> {
  const result = await redis.eval(
    ADOPT_ATOMIC,
    [K_BUSINESS + input.expectedBusiness.id, K_RECORD + input.record.id, K_INDEX],
    [
      JSON.stringify(input.expectedBusiness),
      JSON.stringify(input.nextBusiness),
      JSON.stringify(input.record),
      String(input.record.adoptedAt),
      input.record.id,
    ],
  )
  return Number(result) === 1 ? 'written' : 'business_changed'
}

export async function listBaselineAdoptions(limit = 100): Promise<BaselineAdoptionRecord[]> {
  const ids = await redis.zrevrange(K_INDEX, 0, Math.max(0, limit - 1))
  const rows = await Promise.all(ids.map(id => redis.get(K_RECORD + id)))
  return rows.flatMap(raw => {
    if (!raw) return []
    try { return [JSON.parse(raw) as BaselineAdoptionRecord] } catch { return [] }
  })
}
