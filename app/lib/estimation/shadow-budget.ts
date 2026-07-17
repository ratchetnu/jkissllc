// ── Operion Shadow — AI credit-protection budget (PURE decision core) ────────
//
// The gate that sits in front of every V2 inference call. Its whole job is to answer one
// question deterministically: "may this shadow job spend a model call right now?" — and to
// make the answer NO for the cheap, safe reasons before any credits are touched.
//
// PURE: no I/O, no clock (caller passes `now` + the day's counters). The worker reads the
// counters from Redis and calls decideShadowSpend(); this module never talks to a store, so
// every limit is unit-testable without mocking a database.
//
// What this does NOT touch, by construction — it only gates NEW V2 inference:
//   • V1 (the customer-facing estimator) — different call path entirely
//   • analytics, readiness, ground-truth editing — all pure over STORED jobs, zero inference
//   • already-completed results — never recomputed
// So the kill switch and the budget can halt all new spend while the rest stays fully live.

export type ShadowBudgetLimits = {
  /** Master kill switch. When true, NO new V2 inference runs — full stop. */
  killed: boolean
  maxEvalsPerDay: number
  maxEvalsPerBooking: number
  maxEstDailyCostUsd: number
  maxAttempts: number
}

// Conservative defaults — a shadow program that is meant to be watched, not run wide open.
// The worker processes ~1 job per 10-min tick (~144/day ceiling), so 50/day is a real cap
// with headroom, and $2/day bounds a runaway at a couple of dollars rather than a balance.
export const DEFAULT_SHADOW_BUDGET: ShadowBudgetLimits = {
  killed: false,
  maxEvalsPerDay: 50,
  maxEvalsPerBooking: 3,
  maxEstDailyCostUsd: 2,
  maxAttempts: 2,          // one retry — mirrors DEFAULT_SHADOW_MAX_ATTEMPTS
}

export type ShadowSpendState = {
  /** Successful + failed inference calls charged to today (resets at UTC midnight). */
  evalsToday: number
  /** Estimated USD spent today, summed from providerUsage at completion. */
  costTodayUsd: number
  /** Inference attempts already made for THIS booking, across its history. */
  attemptsForBooking: number
}

export type ShadowSpendBlock =
  | 'killed'
  | 'daily_eval_cap'
  | 'daily_cost_cap'
  | 'per_booking_cap'

export type ShadowSpendDecision =
  | { allowed: true }
  | { allowed: false; block: ShadowSpendBlock; detail: string }

/**
 * May this job spend a model call? Checked in cheapest-and-most-absolute order:
 * the kill switch first (an operator said stop), then the caps. Every NO carries a
 * machine-readable `block` (for telemetry) and a human `detail` (for the owner).
 *
 * Enforcement is FAIL-CLOSED on the kill switch: if the flag can't be read, treat it as
 * killed is the caller's choice — here, an explicit `killed: true` is the only stop, so the
 * caller must default the flag safely (see shadowBudgetFromEnv).
 */
export function decideShadowSpend(
  limits: ShadowBudgetLimits,
  state: ShadowSpendState,
): ShadowSpendDecision {
  if (limits.killed) {
    return { allowed: false, block: 'killed', detail: 'V2 shadow inference is halted by the kill switch (SHADOW_V2_KILL_SWITCH).' }
  }
  if (state.attemptsForBooking >= limits.maxEvalsPerBooking) {
    return { allowed: false, block: 'per_booking_cap', detail: `This booking already has ${state.attemptsForBooking} inference attempt(s) (cap ${limits.maxEvalsPerBooking}).` }
  }
  if (state.evalsToday >= limits.maxEvalsPerDay) {
    return { allowed: false, block: 'daily_eval_cap', detail: `Daily evaluation cap reached (${state.evalsToday}/${limits.maxEvalsPerDay}).` }
  }
  if (state.costTodayUsd >= limits.maxEstDailyCostUsd) {
    return { allowed: false, block: 'daily_cost_cap', detail: `Daily estimated AI cost cap reached ($${round2(state.costTodayUsd)}/$${limits.maxEstDailyCostUsd}).` }
  }
  return { allowed: true }
}

const round2 = (n: number) => Math.round(n * 100) / 100

type EnvLike = Record<string, string | undefined>
const num = (raw: string | undefined, dflt: number): number => {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : dflt
}
const bool = (raw: string | undefined): boolean => {
  const v = (raw ?? '').trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'on' || v === 'yes'
}

/**
 * Resolve limits from env. The kill switch defaults OFF (absent env ⇒ not killed) — it is an
 * emergency brake an operator flips, not a default state. Every numeric cap falls back to the
 * conservative default when unset or malformed.
 */
export function shadowBudgetFromEnv(env: EnvLike = process.env): ShadowBudgetLimits {
  return {
    killed: bool(env.SHADOW_V2_KILL_SWITCH),
    maxEvalsPerDay: num(env.SHADOW_MAX_EVALS_PER_DAY, DEFAULT_SHADOW_BUDGET.maxEvalsPerDay),
    maxEvalsPerBooking: num(env.SHADOW_MAX_EVALS_PER_BOOKING, DEFAULT_SHADOW_BUDGET.maxEvalsPerBooking),
    maxEstDailyCostUsd: num(env.SHADOW_MAX_DAILY_COST_USD, DEFAULT_SHADOW_BUDGET.maxEstDailyCostUsd),
    maxAttempts: num(env.VISION_SHADOW_MAX_ATTEMPTS, DEFAULT_SHADOW_BUDGET.maxAttempts),
  }
}

/** The UTC day key a spend is charged to. Passed `now` so it stays clock-free. */
export const shadowDayKey = (now: number): string => new Date(now).toISOString().slice(0, 10)
