// ── V2 Shadow — independent worker (enqueue • process • run-due) ──────────────
//
// This is the ONLY place the heavy V2 vision call runs, and it runs OUTSIDE the
// authoritative worker — on its own cron, its own queue, its own budget. It never
// mutates the booking's authoritative estimate/status/price and never sends comms.
// Every external dependency is injectable so the whole thing is hermetically testable.

import type { Booking } from '../bookings'
import { getBookingByToken } from '../bookings'
import { isEnabled, type FeatureFlag } from '../platform/flags'
import { analyzePhotosV2, promptVersionNumber } from '../ai/analysis-v2'
import { decideShadowSpend, shadowBudgetFromEnv, type ShadowBudgetLimits, type ShadowSpendState } from './shadow-budget'
import { chargeShadowSpend, recordShadowSpendEvent, readShadowSpend, shadowKillEngaged } from './shadow-store'
import { estimateFromV2 } from './v2-bridge'
import { clarificationsForV2 } from './clarify-v2'
import { buildV2Comparison } from './shadow-comparison'
import {
  getShadowJob, saveShadowJob, listShadowJobs, withShadowLock,
  isExcluded as storeIsExcluded, isSelected as storeIsSelected,
} from './shadow-store'
import {
  evaluateShadowEligibility, isShadowDue, shadowRetryDecision, classifyShadowFailure,
  shadowIdempotencyKey, shadowJobId, shadowDeadlineMs, shadowLeaseMs, shadowMaxAttempts, shadowBackoffMs,
  SHADOW_FUNCTION_BUDGET_MS, V2_ESTIMATOR_VERSION, type ShadowFlags,
} from './shadow-policy'
import { V2_SHADOW_JOB_VERSION, SHADOW_TRANSIENT, MAX_SHADOW_PRIOR_RUNS, type V2ShadowJob, type V2ShadowCreatedBy, type V2ShadowFailure, type ShadowRunSnapshot } from './shadow-types'

type EnvLike = Record<string, string | undefined>

// ── Injectable dependencies (default to the real store/AI/clock) ─────────────
export type ShadowDeps = {
  now?: () => number
  env?: EnvLike
  getBooking?: (id: string) => Promise<Booking | null>
  getJob?: (id: string) => Promise<V2ShadowJob | null>
  saveJob?: (job: V2ShadowJob) => Promise<void>
  listJobs?: (limit: number) => Promise<V2ShadowJob[]>
  analyze?: typeof analyzePhotosV2
  estimate?: typeof estimateFromV2
  clarify?: typeof clarificationsForV2
  isExcluded?: (id: string) => Promise<boolean>
  isSelected?: (id: string) => Promise<boolean>
  lock?: <T>(id: string, fn: () => Promise<T>, onBusy: () => T, token: string) => Promise<T>
  // AI credit protection (injectable so budget/kill-switch tests need no Redis).
  readSpend?: (now: number) => Promise<ShadowSpendState>
  chargeSpend?: (now: number, costUsd: number, wasRetry: boolean) => Promise<void>
  recordSpendEvent?: (now: number, kind: 'preventedRetries' | 'budgetBlocked') => Promise<void>
  budget?: ShadowBudgetLimits
}

function resolve(deps: ShadowDeps = {}) {
  const now = deps.now ?? (() => Date.now())
  return {
    now,
    env: deps.env ?? process.env,
    getBooking: deps.getBooking ?? getBookingByToken,
    getJob: deps.getJob ?? getShadowJob,
    saveJob: deps.saveJob ?? saveShadowJob,
    listJobs: deps.listJobs ?? listShadowJobs,
    analyze: deps.analyze ?? analyzePhotosV2,
    estimate: deps.estimate ?? estimateFromV2,
    clarify: deps.clarify ?? clarificationsForV2,
    isExcluded: deps.isExcluded ?? storeIsExcluded,
    isSelected: deps.isSelected ?? storeIsSelected,
    lock: deps.lock ?? (<T>(id: string, fn: () => Promise<T>, onBusy: () => T, token: string) =>
      withShadowLock(id, fn, { onBusy, token, ttlMs: shadowLeaseMs(deps.env ?? process.env) })),
    chargeSpend: deps.chargeSpend ?? chargeShadowSpend,
    recordSpendEvent: deps.recordSpendEvent ?? recordShadowSpendEvent,
    budget: deps.budget ?? shadowBudgetFromEnv(deps.env ?? process.env),
    // Reads today's counters + this booking's prior attempts into the pure gate's state shape.
    readSpend: deps.readSpend,
  }
}

function flag(env: EnvLike, f: FeatureFlag): boolean { return isEnabled(f, env) }
function shadowFlags(env: EnvLike): ShadowFlags {
  return {
    queueEnabled: flag(env, 'VISION_SHADOW_QUEUE_ENABLED'),
    autoEnqueue: flag(env, 'VISION_SHADOW_AUTO_ENQUEUE'),
    selectedOnly: flag(env, 'VISION_SHADOW_SELECTED_ONLY'),
  }
}

function photoVersion(b: Pick<Booking, 'invoicePhotos'>): number { return b.invoicePhotos?.length ?? 0 }
function authoritativeTerminal(b: Booking): boolean {
  return b.aiJob?.status === 'completed' || b.aiJob?.status === 'manual_review'
}
function authoritativeBaseline(b: Booking): { recommendedUsd?: number; decision?: string } {
  const est = b.aiEstimate as { pricing?: { recommendedUsd?: number }; decision?: string } | undefined
  return { recommendedUsd: est?.pricing?.recommendedUsd, decision: est?.decision }
}

/** Snapshot a job's current completed run into its history list (newest last, bounded). Only a
 *  run that actually completed is worth remembering; a never-run queued job adds nothing. */
function appendPriorRun(prior: V2ShadowJob | null): ShadowRunSnapshot[] | undefined {
  if (!prior) return undefined
  const history = prior.priorRuns ?? []
  const ran = prior.status === 'completed' || prior.status === 'manual_review' || prior.status === 'failed'
  if (!ran) return history.length ? history : undefined
  const snap: ShadowRunSnapshot = {
    at: prior.completedAt ?? prior.updatedAt,
    model: prior.model,
    promptVersion: prior.promptVersion,
    status: prior.status,
    outcome: prior.comparison?.outcome,
    shadowRecommendedUsd: prior.comparison?.shadowRecommendedUsd,
    quoteDeltaUsd: prior.comparison?.quoteDeltaUsd,
    estimatedCostUsd: prior.estimatedCostUsd,
    latencyMs: prior.latencyMs,
    attempts: prior.attempts,
  }
  return [...history, snap].slice(-MAX_SHADOW_PRIOR_RUNS)
}

// ── Enqueue (Phase 5) — called AFTER authoritative terminal, or by owner ─────
export type EnqueueResult = { enqueued: boolean; reason: string; job?: V2ShadowJob }

/**
 * Consider a booking for shadow analysis and, if eligible, enqueue a job in the
 * INDEPENDENT store. Fail-soft by construction (callers wrap it); it performs no AI
 * work and never touches authoritative fields. `manualEnqueue` bypasses auto/selected
 * gating (owner action); `force` re-runs even if a completed job exists.
 */
export async function enqueueShadowJobForBooking(
  b: Booking,
  opts: { createdBy: V2ShadowCreatedBy; manualEnqueue?: boolean; force?: boolean; deps?: ShadowDeps } = { createdBy: 'auto' },
): Promise<EnqueueResult> {
  const d = resolve(opts.deps)
  const now = d.now()
  const pv = photoVersion(b)
  const idem = shadowIdempotencyKey(b.token, V2_ESTIMATOR_VERSION, pv)
  // On a forced rerun we still READ the existing job (to carry ground truth + history
  // forward); `force` only bypasses the "already done" eligibility block, it never discards
  // what the prior run learned.
  const prior = await d.getJob(b.token)
  const existing = opts.force ? null : prior

  const elig = evaluateShadowEligibility(
    {
      bookingId: b.token,
      idempotencyKey: idem,
      photoCount: pv,
      isTest: b.isTest,
      cancelled: !!b.archived,
      authoritativeTerminal: authoritativeTerminal(b),
      excluded: await d.isExcluded(b.token),
      selected: await d.isSelected(b.token),
      existingJob: existing ? { status: existing.status, idempotencyKey: existing.idempotencyKey } : null,
      manualEnqueue: opts.manualEnqueue,
    },
    shadowFlags(d.env),
  )
  if (!elig.eligible) return { enqueued: false, reason: elig.reason }

  const job: V2ShadowJob = {
    jobVersion: V2_SHADOW_JOB_VERSION,
    bookingId: b.token,
    bookingNumber: b.bookingNumber,
    shadowJobId: shadowJobId(b.token, pv, V2_ESTIMATOR_VERSION),
    status: 'queued',
    idempotencyKey: idem,
    estimatorVersion: V2_ESTIMATOR_VERSION,
    imageCount: pv,
    attempts: 0,
    createdBy: opts.createdBy,
    // preserve any prior owner ground truth across a re-run
    groundTruth: (existing ?? prior)?.groundTruth,
    // carry the full prior-run history, and append the run we are about to overwrite
    priorRuns: opts.force ? appendPriorRun(prior) : prior?.priorRuns,
    queuedAt: now,
    nextRetryAt: now,
    updatedAt: now,
  }
  await d.saveJob(job)
  return { enqueued: true, reason: 'queued', job }
}

/** Fail-soft wrapper for the post-terminal auto path — never throws into the caller. */
export async function maybeEnqueueShadowJob(b: Booking, deps?: ShadowDeps): Promise<void> {
  try {
    if (!isEnabled('VISION_SHADOW_QUEUE_ENABLED', (deps?.env ?? process.env))) return
    await enqueueShadowJobForBooking(b, { createdBy: 'auto', deps })
  } catch (e) {
    // The authoritative estimate is already saved; a shadow enqueue error is inert.
    try { console.error('[vision-shadow] enqueue (non-fatal)', e) } catch { /* noop */ }
  }
}

// ── Process one job (Phases 6/7) ─────────────────────────────────────────────
const DEADLINE = Symbol('shadow-deadline')

function applyFailure(job: V2ShadowJob, failure: V2ShadowFailure, summary: string, now: number, maxAttempts: number): void {
  const decision = shadowRetryDecision(job.attempts, failure, maxAttempts)
  job.failureCategory = failure
  job.failureSummary = summary.slice(0, 240)
  job.updatedAt = now
  if (decision.terminal) {
    job.status = decision.status
    job.completedAt = now
  } else {
    job.status = 'retrying'
    job.nextRetryAt = now + decision.delayMs
  }
}

export async function processShadowJob(bookingId: string, deps?: ShadowDeps): Promise<{ ok: boolean; status: string; reason?: string }> {
  const d = resolve(deps)
  const token = `${bookingId}:${d.now()}`
  return d.lock(
    bookingId,
    () => processShadowInner(bookingId, deps),
    () => ({ ok: false, status: 'processing', reason: 'locked' }),
    token,
  )
}

/** Bridge the Redis day-spend counters into the pure gate's state. attemptsForBooking comes
 *  from the job itself (the counters are day-scoped; per-booking is job-scoped). */
async function spendStateFromStore(now: number, attemptsForBooking: number): Promise<ShadowSpendState> {
  const s = await readShadowSpend(now)
  return { evalsToday: s.evals, costTodayUsd: s.costUsd, attemptsForBooking }
}

async function processShadowInner(bookingId: string, deps?: ShadowDeps): Promise<{ ok: boolean; status: string; reason?: string }> {
  const d = resolve(deps)
  const env = d.env
  const now = d.now()
  const maxAttempts = shadowMaxAttempts(env)

  const job = await d.getJob(bookingId)
  if (!job) return { ok: false, status: 'failed', reason: 'no_job' }
  if (!isShadowDue(job, now, shadowLeaseMs(env))) return { ok: false, status: job.status, reason: 'not_due' }

  // ── AI credit-protection gate ────────────────────────────────────────────
  // Runs BEFORE any state mutation or model call. A blocked job is parked as `retrying` (it
  // re-checks next tick when a new day's budget frees up or the kill switch lifts) — never
  // marked failed, because the model did nothing wrong. This gate spends ZERO credits: the
  // whole point is to stop spend cheaply, before analyzePhotosV2 is ever reached.
  // Effective budget = env defaults, with the runtime kill override folded in so an owner can
  // halt inference without a redeploy. A test-injected budget is used verbatim (no store read).
  const budget: ShadowBudgetLimits = d.budget
    ? d.budget
    : { ...shadowBudgetFromEnv(env), killed: await shadowKillEngaged(shadowBudgetFromEnv(env).killed) }
  const spend: ShadowSpendState = d.readSpend
    ? await d.readSpend(now)
    : await spendStateFromStore(now, job.attempts)
  // attemptsForBooking is always the job's own count — the day counters can't know it, and a
  // test's readSpend stub shouldn't have to. This is what enforces the per-booking cap.
  const decision = decideShadowSpend(budget, { ...spend, attemptsForBooking: job.attempts })
  if (!decision.allowed) {
    try { await d.recordSpendEvent(now, 'budgetBlocked') } catch { /* counter is best-effort */ }
    job.status = 'retrying'
    job.nextRetryAt = now + shadowBackoffMs(job.attempts)
    job.failureSummary = decision.detail.slice(0, 240)
    job.updatedAt = now
    await d.saveJob(job)
    return { ok: false, status: 'retrying', reason: `budget_${decision.block}` }
  }

  // Enter processing (durable) BEFORE the slow call so a crash is recoverable.
  job.status = 'processing'
  job.startedAt = now
  job.heartbeatAt = now
  job.attempts += 1
  job.timeoutCategory = undefined
  job.failureCategory = undefined
  job.updatedAt = now
  await d.saveJob(job)

  const b = await d.getBooking(bookingId)
  if (!b) { applyFailure(job, 'internal_error', 'booking not found', d.now(), maxAttempts); await d.saveJob(job); return { ok: false, status: job.status, reason: 'no_booking' } }
  const photoUrls = (b.invoicePhotos ?? []).map((p) => p.url)
  if (photoUrls.length === 0) { applyFailure(job, 'no_usable_images', 'no photos on booking', d.now(), maxAttempts); await d.saveJob(job); return { ok: false, status: job.status, reason: 'no_photos' } }

  // Run the heavy V2 vision analysis under a graceful deadline (well below maxDuration).
  const deadlineMs = shadowDeadlineMs(env)
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let v2: Awaited<ReturnType<typeof analyzePhotosV2>>
  try {
    const analysisP = d.analyze({
      bookingId: b.token,
      photoUrls,
      serviceLabel: b.serviceType,
      customerNotes: b.description,
      nowIso: new Date(d.now()).toISOString(),
    })
    analysisP.catch(() => {})
    v2 = await Promise.race([
      analysisP,
      new Promise<never>((_, reject) => { deadlineTimer = setTimeout(() => reject(DEADLINE), deadlineMs) }),
    ])
  } catch (e) {
    if (e === DEADLINE) {
      job.timeoutCategory = 'deadline'
      applyFailure(job, 'deadline', 'V2 analysis exceeded its shadow deadline', d.now(), maxAttempts)
      await d.saveJob(job)
      return { ok: false, status: job.status, reason: 'deadline' }
    }
    applyFailure(job, 'internal_error', e instanceof Error ? e.message : 'analysis threw', d.now(), maxAttempts)
    await d.saveJob(job)
    return { ok: false, status: job.status, reason: 'exception' }
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer)
  }

  if (!v2.ok) {
    const failure = classifyShadowFailure(v2.outcome, v2.errorClass)
    const permanent = !SHADOW_TRANSIENT.includes(failure)
    applyFailure(job, failure, `V2 did not return a usable read (${v2.outcome})`, d.now(), maxAttempts)
    // A PERMANENT failure (billing/auth/schema/unsupported/no-images) is a call we deliberately
    // will NOT repeat — record it so the dashboard shows credits protected, not just spent. A
    // transient failure that merely exhausted its attempts is not a "prevented" retry.
    if (permanent) {
      try { await d.recordSpendEvent(d.now(), 'preventedRetries') } catch { /* best-effort */ }
    }
    await d.saveJob(job)
    return { ok: false, status: job.status, reason: v2.outcome }
  }

  // The inference SUCCEEDED — that is the part that cost credits. Charge it NOW, before the
  // deterministic downstream (bridge/compare), so a later throw can never lose the cost record.
  const wasRetry = job.attempts > 1
  try { await d.chargeSpend(d.now(), v2.estCostUsd ?? 0, wasRetry) } catch { /* counter is best-effort */ }
  // Stamp the paid-for telemetry immediately, so it survives even a downstream failure.
  job.promptVersion = promptVersionNumber(v2.promptVersion) ?? job.promptVersion
  job.estimatedCostUsd = v2.estCostUsd
  job.providerUsage = v2.usage
  job.model = v2.model
  job.traceId = v2.callId
  job.latencyMs = v2.latencyMs

  // Deterministic tail: bridge → clarify → compare. These are PURE functions of the stored
  // analysis, so if one throws it will throw again — retrying the AI call cannot help and would
  // only re-spend. Priority #3: a downstream failure routes to manual_review (owner-priced),
  // NEVER back to applyFailure/retry. The model call is made exactly once.
  try {
    const estimate = d.estimate(v2.analysis, { bookingId: b.token, serviceType: b.serviceType })
    const questions = d.clarify(v2.analysis)
    const comparison = buildV2Comparison(estimate, authoritativeBaseline(b), job.groundTruth)
    const endNow = d.now()
    job.status = estimate.manualReviewRequired ? 'manual_review' : 'completed'
    job.result = { estimate, questions, ok: true, model: v2.model, analysisVersion: estimate.v2?.analysisVersion, promptVersion: job.promptVersion }
    job.comparison = comparison
    job.completedAt = endNow
    job.failureCategory = undefined
    job.failureSummary = undefined
    job.updatedAt = endNow
    await d.saveJob(job)
    return { ok: true, status: job.status }
  } catch (e) {
    const endNow = d.now()
    job.status = 'manual_review'
    job.completedAt = endNow
    job.failureSummary = `V2 inference completed and was charged; deterministic processing failed and needs owner review: ${e instanceof Error ? e.message : 'error'}`.slice(0, 240)
    job.updatedAt = endNow
    await d.saveJob(job)
    return { ok: false, status: job.status, reason: 'downstream_error' }
  }
}

// ── Cron entry point ─────────────────────────────────────────────────────────
/** Process due shadow jobs, bounded by count AND a wall-clock budget. Gated by the
 *  worker flag — off ⇒ a pure no-op (no scan, no AI). */
// ── Owner run-status snapshot (PURE reads only — ZERO AI) ────────────────────
/**
 * Everything the owner UI needs to render a booking's shadow status and gate its actions:
 * eligibility (via the same evaluateShadowEligibility the enqueue path uses), the stored job,
 * and the live budget/spend snapshot. Makes NO model call — it only reads state.
 */
export async function shadowStatusForBooking(b: Booking, deps?: ShadowDeps): Promise<{
  bookingId: string
  selected: boolean
  excluded: boolean
  eligible: boolean
  eligibilityReason: string
  job: V2ShadowJob | null
  imageCount: number
  budget: ShadowBudgetLimits
  spend: ShadowSpendState
}> {
  const d = resolve(deps)
  const now = d.now()
  const pv = photoVersion(b)
  const [job, selected, excluded] = await Promise.all([d.getJob(b.token), d.isSelected(b.token), d.isExcluded(b.token)])
  const elig = evaluateShadowEligibility(
    {
      bookingId: b.token,
      idempotencyKey: shadowIdempotencyKey(b.token, V2_ESTIMATOR_VERSION, pv),
      photoCount: pv,
      isTest: b.isTest,
      cancelled: !!b.archived,
      authoritativeTerminal: authoritativeTerminal(b),
      excluded,
      selected,
      existingJob: job ? { status: job.status, idempotencyKey: job.idempotencyKey } : null,
      // manualEnqueue: report eligibility as the owner's "run" path would see it, so the UI's
      // gating matches what actually happens when they click Run.
      manualEnqueue: true,
    },
    shadowFlags(d.env),
  )
  const budget: ShadowBudgetLimits = d.budget
    ? d.budget
    : { ...shadowBudgetFromEnv(d.env), killed: await shadowKillEngaged(shadowBudgetFromEnv(d.env).killed) }
  const spend: ShadowSpendState = d.readSpend
    ? await d.readSpend(now)
    : { ...(await readShadowSpend(now).then((r) => ({ evalsToday: r.evals, costTodayUsd: r.costUsd }))), attemptsForBooking: job?.attempts ?? 0 }
  return { bookingId: b.token, selected, excluded, eligible: elig.eligible, eligibilityReason: elig.reason, job, imageCount: pv, budget, spend }
}

export async function runDueShadowJobs(limit = 1, deps?: ShadowDeps): Promise<{ processed: number; results: { bookingId: string; status: string }[] }> {
  const d = resolve(deps)
  if (!isEnabled('VISION_SHADOW_WORKER_ENABLED', d.env)) return { processed: 0, results: [] }
  const jobs = await d.listJobs(500)
  const lease = shadowLeaseMs(d.env)
  const deadlineMs = shadowDeadlineMs(d.env)
  const due = jobs.filter((j) => isShadowDue(j, d.now(), lease)).slice(0, Math.max(1, limit))
  const results: { bookingId: string; status: string }[] = []
  const runStart = d.now()
  for (const j of due) {
    if (d.now() - runStart + deadlineMs > SHADOW_FUNCTION_BUDGET_MS) break
    const r = await processShadowJob(j.bookingId, deps)
    results.push({ bookingId: j.bookingId, status: r.status })
  }
  return { processed: results.length, results }
}
