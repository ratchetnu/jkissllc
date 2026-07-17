import { redis } from './redis'
import type { AiJob, AiJobErrorCode, AiJobStatus, Booking } from './bookings'

// ─────────────────────────────────────────────────────────────────────────────
// AI job RELIABILITY layer (Session 2) — an ADDITIVE recovery overlay on top of
// the durable Book Now AI worker (see book-now-ai.ts / book-now-confirmation.ts).
//
// It closes three gaps the base worker does not cover:
//   1. Provider-outage circuit breaker — a sustained provider outage otherwise
//      makes every in-flight job independently burn all MAX_ATTEMPTS and land in
//      terminal `retry_exhausted`, converting a TRANSIENT outage into a fleet of
//      PERMANENT dead-letters + a retry storm. The breaker detects the outage and
//      PARKS the worker (jobs stay due, attempts untouched) until a cooldown lets
//      a single probe test recovery.
//   2. Stuck-`queued` detection — the base reaper only recovers stale *processing*
//      leases. A `queued`/`retrying` job stranded by a cron gap or starved by the
//      per-tick batch limit has no detector. `isStuckQueued` surfaces it.
//   3. Consolidated recovery health — `summarizeRecovery` gives the operator one
//      fleet-level read (and the stranded-token list its manual sweep drains).
//
// The PURE core (breaker transitions, detectors, summary) is dependency-free
// (type-only import of the job shape) so it unit-tests hermetically with injected
// time. The thin Redis persistence at the bottom is fail-soft and separated.
//
// Everything here is INERT until AI_RECOVERY_BREAKER_ENABLED is set: the base
// worker only consults the breaker behind that flag, so healthy-job behavior is
// byte-for-byte unchanged by default. No pricing / prompt / model / telemetry
// change; no communications. Telemetry integration points are marked with TODO so
// Session 1 can hook them without this module duplicating any telemetry infra.
// ─────────────────────────────────────────────────────────────────────────────

const now = () => Date.now()

function posInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
function truthy(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

// ── Configuration (env-driven; safe production defaults) ─────────────────────
export type EnvLike = Record<string, string | undefined>

/** Master switch. OFF by default ⇒ the breaker is never consulted and the base
 *  worker runs exactly as before. */
export function breakerEnabled(env: EnvLike = process.env): boolean {
  return truthy(env.AI_RECOVERY_BREAKER_ENABLED)
}

export type BreakerConfig = { threshold: number; cooldownMs: number }
export const BREAKER_DEFAULTS: BreakerConfig = { threshold: 5, cooldownMs: 5 * 60_000 }

/** Consecutive outage-class failures that trip the breaker, and how long it stays
 *  open before a single probe is allowed. */
export function breakerConfig(env: EnvLike = process.env): BreakerConfig {
  return {
    threshold: posInt(env.AI_RECOVERY_BREAKER_THRESHOLD, BREAKER_DEFAULTS.threshold),
    cooldownMs: posInt(env.AI_RECOVERY_BREAKER_COOLDOWN_MS, BREAKER_DEFAULTS.cooldownMs),
  }
}

/** How long a `queued`/`retrying` job may sit past its due time before it is
 *  considered stranded (cron gap / batch starvation). Detection only — never
 *  mutates the job. */
export const DEFAULT_STUCK_QUEUED_MS = 15 * 60_000
export function stuckQueuedMs(env: EnvLike = process.env): number {
  return posInt(env.AI_RECOVERY_STUCK_QUEUED_MS, DEFAULT_STUCK_QUEUED_MS)
}

// ── Provider-outage classification ───────────────────────────────────────────
// Only genuine "the provider is down / throttling us" errors feed the breaker. A
// per-photo (`image_access_failed`) or permanent (`invalid_schema`, `unsupported_
// image`, `pricing_validation_failed`) error means the PROVIDER responded — it must
// NOT trip or hold the breaker, and in fact RESETS it (see recordOutcome).
export const OUTAGE_CODES: readonly AiJobErrorCode[] = ['provider_unavailable', 'rate_limited'] as const
export function isOutageClass(code: AiJobErrorCode | undefined): boolean {
  return !!code && OUTAGE_CODES.includes(code)
}

// ── Circuit breaker — a 2-phase state machine ────────────────────────────────
// `closed`  → normal; the worker runs every due job.
// `open`    → outage detected; the worker PARKS. "open past cooldown" is the
//             implicit half-open PROBE window (breakerAllows returns true for one
//             attempt); a probe success closes it, a probe failure re-opens it.
export type BreakerPhase = 'closed' | 'open'
export type BreakerState = {
  phase: BreakerPhase
  failures: number      // consecutive outage-class failures while closed
  openedAt?: number     // when it last opened (drives the cooldown / probe window)
  updatedAt: number
}

export function closedBreaker(at = now()): BreakerState {
  return { phase: 'closed', failures: 0, updatedAt: at }
}

/**
 * May the worker attempt a job right now? Pure.
 *  • closed → yes.
 *  • open   → only once the cooldown has elapsed (a single half-open probe). While
 *    the cooldown is in effect the worker parks entirely, so no job runs and no
 *    attempt is burned — this is what stops the outage retry storm.
 */
export function breakerAllows(state: BreakerState, at = now(), cfg: BreakerConfig = breakerConfig()): boolean {
  if (state.phase === 'closed') return true
  return at - (state.openedAt ?? 0) >= cfg.cooldownMs
}

/** True when the breaker is open but the cooldown has elapsed — the next attempt
 *  is a recovery probe, so the caller should run ONE job and re-check, not drain
 *  the whole batch (limits attempt burn during a flapping outage to one job). */
export function inProbeWindow(state: BreakerState, at = now(), cfg: BreakerConfig = breakerConfig()): boolean {
  return state.phase === 'open' && breakerAllows(state, at, cfg)
}

/**
 * Fold one job outcome into the breaker. Pure + deterministic.
 *  • The provider responded (success, or a non-outage failure) ⇒ reset to closed.
 *  • An outage-class failure ⇒ count it; a half-open probe failure OR reaching the
 *    threshold (re-)opens the breaker and restarts the cooldown.
 */
export function recordOutcome(
  state: BreakerState,
  outage: boolean,
  at = now(),
  cfg: BreakerConfig = breakerConfig(),
): BreakerState {
  if (!outage) return { phase: 'closed', failures: 0, updatedAt: at }
  const wasClosed = state.phase === 'closed'
  const failures = (wasClosed ? state.failures : 0) + 1
  // A probe (state already open) that fails, or hitting the threshold from closed,
  // opens the breaker and restarts the cooldown window.
  if (!wasClosed || failures >= cfg.threshold) {
    return { phase: 'open', failures, openedAt: at, updatedAt: at }
  }
  return { phase: 'closed', failures, updatedAt: at }
}

// ── Stuck-`queued` detection (surface-only, never mutates) ───────────────────
/** True when a `queued`/`retrying` job has been due for longer than the threshold
 *  and still hasn't run — a cron gap or batch-starvation symptom the base reaper
 *  (which only handles stale *processing*) can't see. Missing timestamps ⇒ never
 *  flagged (fail-safe). */
export function isStuckQueued(
  j: Pick<AiJob, 'status' | 'nextRetryAt' | 'updatedAt'> | undefined,
  at = now(),
  thresholdMs = stuckQueuedMs(),
): boolean {
  if (!j || (j.status !== 'queued' && j.status !== 'retrying')) return false
  const dueAt = j.nextRetryAt ?? j.updatedAt ?? 0
  if (!dueAt) return false
  return at - dueAt > thresholdMs
}

/** Local mirror of book-now-ai's `isStaleProcessing` — kept inline so this module
 *  stays dependency-free (type-only import) and can't create a runtime import
 *  cycle with book-now-ai. Same rule: a `processing` job whose entered-processing
 *  stamp is older than the lease was crash-stranded. Missing stamp ⇒ never stale. */
function staleProcessing(
  j: Pick<AiJob, 'status' | 'lastAttemptAt'> | undefined,
  at: number,
  leaseMs: number,
): boolean {
  if (!j || j.status !== 'processing') return false
  const startedAt = j.lastAttemptAt ?? 0
  return startedAt > 0 && at - startedAt > leaseMs
}

// ── Fleet recovery health ────────────────────────────────────────────────────
export type RecoverySummary = {
  scanned: number
  byStatus: Record<AiJobStatus, number>
  staleProcessing: number   // crash-stranded processing leases (base reaper's target)
  stuckQueued: number       // queued/retrying stranded past threshold (this module)
  deadLetter: number        // terminal `failed` jobs awaiting operator attention
  manualReview: number      // terminal manual_review (owner hand-prices)
  stranded: number          // staleProcessing + stuckQueued (what a sweep would drain)
  strandedTokens: string[]  // booking tokens to drain (bounded); short prefixes NOT used — the sweep needs full tokens
}

const EMPTY_BY_STATUS = (): Record<AiJobStatus, number> => ({
  not_started: 0, queued: 0, processing: 0, completed: 0, retrying: 0, failed: 0, manual_review: 0,
})

/**
 * Pure fleet summary over a set of bookings, counting BOTH the initial (`aiJob`)
 * and final (`finalAiJob`) durable jobs. Injected time + lease so it is hermetic.
 * `strandedTokens` (deduped, bounded) is what the operator "recover-stranded"
 * sweep drives through the existing idempotent processors.
 */
export function summarizeRecovery(
  bookings: Booking[],
  opts: { at?: number; leaseMs?: number; stuckMs?: number; maxTokens?: number } = {},
): RecoverySummary {
  const at = opts.at ?? now()
  const leaseMs = opts.leaseMs ?? 5 * 60_000
  const stuckMs = opts.stuckMs ?? stuckQueuedMs()
  const maxTokens = opts.maxTokens ?? 100

  const byStatus = EMPTY_BY_STATUS()
  let staleP = 0, stuckQ = 0, dead = 0, review = 0, scanned = 0
  const strandedSet = new Set<string>()

  for (const b of bookings) {
    if (b.source !== 'online' || b.archived || b.isTest) continue
    for (const j of [b.aiJob, b.finalAiJob]) {
      if (!j) continue
      scanned++
      byStatus[j.status]++
      if (j.status === 'failed') dead++
      if (j.status === 'manual_review') review++
      const isStale = staleProcessing(j, at, leaseMs)
      const isStuck = isStuckQueued(j, at, stuckMs)
      if (isStale) staleP++
      if (isStuck) stuckQ++
      if (isStale || isStuck) strandedSet.add(b.token)
    }
  }
  return {
    scanned,
    byStatus,
    staleProcessing: staleP,
    stuckQueued: stuckQ,
    deadLetter: dead,
    manualReview: review,
    stranded: strandedSet.size,
    strandedTokens: [...strandedSet].slice(0, maxTokens),
  }
}

// ── Thin, fail-soft Redis persistence for the breaker ────────────────────────
// The breaker must survive across cron invocations (each cron tick is a fresh
// function instance), so its small state is persisted per tenant. All I/O is
// fail-soft: a Redis hiccup degrades to a fresh closed breaker (worker runs
// normally) — the breaker can never itself become an availability risk.
const BREAKER_TTL_MS = 2 * 60 * 60_000 // 2h — self-heals if a cron stops writing
function breakerKey(tenantId: string): string {
  return `ai-recovery:breaker:${tenantId}`
}

export async function loadBreaker(tenantId: string): Promise<BreakerState> {
  try {
    const raw = await redis.get(breakerKey(tenantId))
    if (!raw) return closedBreaker()
    const p = JSON.parse(raw) as Partial<BreakerState>
    if (p.phase !== 'open' && p.phase !== 'closed') return closedBreaker()
    return {
      phase: p.phase,
      failures: Number.isFinite(p.failures) ? Number(p.failures) : 0,
      openedAt: typeof p.openedAt === 'number' ? p.openedAt : undefined,
      updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : now(),
    }
  } catch {
    return closedBreaker()
  }
}

export async function saveBreaker(tenantId: string, state: BreakerState): Promise<void> {
  try {
    await redis.set(breakerKey(tenantId), JSON.stringify(state))
    await redis.pexpire(breakerKey(tenantId), BREAKER_TTL_MS)
  } catch { /* fail-soft: breaker state is best-effort */ }
}

/** Operator override — clear the breaker to closed after an outage is resolved. */
export async function resetBreaker(tenantId: string): Promise<BreakerState> {
  const fresh = closedBreaker()
  await saveBreaker(tenantId, fresh)
  return fresh
}
