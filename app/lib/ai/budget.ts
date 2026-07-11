import { redis } from '../redis'
import { tenantId } from '../tenant'
import { centralToday } from '../dates'

// AI cost governance (LLMOps Phase 2). A per-tenant, per-day running total of the
// estimated AI spend, with an optional hard cap. When AI_DAILY_COST_CAP_USD is set
// and today's estimated spend reaches it, the AI service refuses further calls
// fail-soft (OpsPilot keeps working; only AI features pause until tomorrow). Default:
// no cap. The counter is atomic (INCRBYFLOAT via Lua) so concurrent calls can't race.

const key = (tid: string, day: string) => `ai:cost:${tid}:${day}`
const DAY_TTL_MS = 3 * 24 * 60 * 60 * 1000

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
