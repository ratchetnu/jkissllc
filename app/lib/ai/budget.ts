import { redis } from '../redis'
import { tenantId } from '../tenant'
import { centralToday, addDaysStr } from '../dates'

// AI cost governance (LLMOps Phase 2). A per-tenant, per-day running total of the
// estimated AI spend, with an optional hard cap. When AI_DAILY_COST_CAP_USD is set
// and today's estimated spend reaches it, the AI service refuses further calls
// fail-soft (OpsPilot keeps working; only AI features pause until tomorrow). Default:
// no cap. The counter is atomic (INCRBYFLOAT via Lua) so concurrent calls can't race.

const key = (tid: string, day: string) => `ai:cost:${tid}:${day}`
// Retain ~40 days so the cost-forecast series (default 30d) has history to project from.
const DAY_TTL_MS = 40 * 24 * 60 * 60 * 1000

export function costCapUsd(): number {
  const v = parseFloat(process.env.AI_DAILY_COST_CAP_USD ?? '')
  return Number.isFinite(v) && v > 0 ? v : 0   // 0 = no cap
}

export async function addCost(usd: number, tid: string = tenantId(), day: string = centralToday()): Promise<number> {
  if (!(usd > 0)) return todaysCost(tid, day)
  try {
    const res = await redis.eval(
      "local v = redis.call('INCRBYFLOAT', KEYS[1], ARGV[1]); redis.call('PEXPIRE', KEYS[1], ARGV[2]); return v",
      [key(tid, day)], [String(usd), String(DAY_TTL_MS)],
    )
    return parseFloat(String(res)) || 0
  } catch (e) { console.error('[ai/budget] addCost', e); return 0 }
}

export async function todaysCost(tid: string = tenantId(), day: string = centralToday()): Promise<number> {
  try { const v = await redis.get(key(tid, day)); return v ? parseFloat(v as string) || 0 : 0 } catch { return 0 }
}

// True when the configured daily cap has been reached. No cap → never over.
export async function overBudget(tid: string = tenantId()): Promise<boolean> {
  const cap = costCapUsd()
  if (cap <= 0) return false
  return (await todaysCost(tid)) >= cap
}

export type DailyCost = { day: string; usd: number }

// The last `days` calendar days of estimated AI spend (oldest→newest), read by
// reconstructing each day key (no SCAN in the Redis wrapper). Powers the cost
// forecast + trend charts. TTL on the counters is short, so only recent days return
// non-zero — which is exactly the window a forecast should use.
export async function costSeries(days = 30, tid: string = tenantId(), today: string = centralToday()): Promise<DailyCost[]> {
  const dayStrs: string[] = []
  for (let i = days - 1; i >= 0; i--) dayStrs.push(addDaysStr(today, -i))
  const vals = await Promise.all(dayStrs.map(async d => {
    try { const v = await redis.get(key(tid, d)); return v ? parseFloat(v as string) || 0 : 0 } catch { return 0 }
  }))
  return dayStrs.map((day, i) => ({ day, usd: Math.round(vals[i] * 1_000_000) / 1_000_000 }))
}
