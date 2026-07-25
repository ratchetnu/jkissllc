// ── Book Now AI pipeline trace — request-scoped stage timing ──────────────────
//
// OPERION AI OBSERVABILITY. A single durable AI job flows through several stages —
// it waits in the QUEUE, its photos are PREPROCESSED, the PROVIDER (Vercel AI
// Gateway) is called, the AI read is assembled, deterministic PRICING runs, the
// booking is written to the DATABASE, and the owner is NOTIFIED. Each has its own
// latency; a slow job could be slow in any of them. This module times every stage
// of one job run and hands the finished trace to the metrics store so the dashboard
// can answer "where is the time going?" for future performance tuning.
//
// Design (mirrors app/lib/platform/tenancy/context.ts):
//  • A request-scoped `Trace` flows through the async call tree via Node
//    `AsyncLocalStorage` — so instrumentation points (deep inside photo-estimate,
//    junk-analysis, saveBooking) record onto the active trace WITHOUT threading a
//    trace object through every signature.
//  • node:async_hooks is loaded via the RUNTIME accessor `process.getBuiltinModule`
//    (invisible to the bundler) — NOT a static import — because the data layer that
//    imports this (bookings.ts → saveBooking) is transitively pulled into some
//    'use client' bundles; a static Node-builtin import would break the client build.
//    On the client the store is absent and every helper no-ops (correct — pipeline
//    timing only ever happens server-side).
//  • FAIL-SOFT + INERT BY DEFAULT: gated on AI_PIPELINE_OBSERVABILITY_ENABLED. When
//    the flag is off `runWithTrace` establishes NO trace, so `timeStage`/`markStage`
//    fall straight through to the wrapped work — byte-identical behavior, zero writes.
//    A trace/flush error can never surface into the business path.

import type { AsyncLocalStorage as ALSType } from 'node:async_hooks' // type-only → erased
import { isEnabled } from '../platform/flags'
import { currentTenantId } from '../platform/tenancy/context'
import { recordTrace, type PipelineTraceStore } from './pipeline-metrics'

// The recordable stages of the durable AI job, in pipeline order. `total` is derived
// at flush (end-to-end wall time), never recorded directly.
export const PIPELINE_STAGES = [
  'queue',             // enqueued → this attempt started (time spent waiting)
  'image_preprocess',  // photo validation / prep before the provider call
  'provider',          // the AI Gateway round-trip latency (from runAiTask)
  'ai',                // full AI analysis stage: vision + normalization (wall time)
  'pricing',           // deterministic pricing: settings/calibration + decision + critic
  'database',          // cumulative Redis write time (saveBooking) during the job
  'notification',      // owner notification send
] as const
export type PipelineStage = (typeof PIPELINE_STAGES)[number]

// Sub-stages are COMPONENTS of a broader stage (both are recorded inside the `ai`
// stage's wall time), so they must be EXCLUDED from any non-overlapping "where does
// the time go" total — otherwise their time is counted twice. They still get their
// own latency distribution on the dashboard as a drill-down. Everything else is a
// roughly non-overlapping top-level phase.
// The owner-notification step runs at the cron level, AFTER the durable job trace has
// already flushed, so it gets its own tiny single-stage trace. The read layer excludes
// these from end-to-end / throughput / slowest (they aren't job runs) but still folds
// their `notification` stage into the per-stage latency aggregation.
export const NOTIFY_FEATURE = 'book-now-ai-notify'

export const PIPELINE_SUBSTAGES: readonly PipelineStage[] = ['image_preprocess', 'provider']
export function isSubStage(stage: PipelineStage): boolean {
  return PIPELINE_SUBSTAGES.includes(stage)
}

// One stage may run more than once in a job (e.g. several saveBooking writes). We keep
// the accumulated total, an occurrence count, and the worst single occurrence.
//
// Failure annotation (OPTIONAL + additive): when a stage records a fast-fail — the
// step could not execute, e.g. the provider was unavailable — the recorder marks it
// `status: 'failed'` with a coarse `failureReason` and the `retryable` flag, so a
// trace stays structurally complete even when a stage didn't run. Older trace records
// simply lack these fields (undefined) → backward-compatible with the read layer.
export type StageStat = {
  totalMs: number
  count: number
  maxMs: number
  status?: 'failed'
  failureReason?: string
  retryable?: boolean
}

// Optional failure metadata a recorder may attach to a stage occurrence.
export type StageFailure = { status?: 'failed'; failureReason?: string; retryable?: boolean }

export type TraceSeed = {
  requestId: string        // correlates to the analysis id (e.g. `srv-<token>-<attempt>`)
  feature: string          // e.g. 'book-now-ai'
  bookingId?: string
  jobId?: string           // durable job / idempotency key
  attempt?: number
  queuedAt?: number        // when the work was enqueued (for the queue-wait stage)
}

// The finished, storable trace. Flat `durationMs` + per-stage map keep the read-side
// aggregation trivial (percentiles over `durationMs` and over each stage's `totalMs`).
export type PipelineTraceRecord = {
  id: string
  at: number               // startedAt (epoch ms) — also the zset score
  tenantId: string
  feature: string
  bookingId?: string
  jobId?: string
  attempt?: number
  status?: string          // terminal AiJobStatus (completed | manual_review | failed | …)
  outcome?: string         // finer-grained reason (e.g. 'deadline', 'no_items')
  startedAt: number
  completedAt: number
  durationMs: number       // end-to-end (completedAt − startedAt)
  queuedAt?: number
  stages: Partial<Record<PipelineStage, StageStat>>
}

// ── The live, in-flight trace ────────────────────────────────────────────────
// Pure + dependency-free so it is trivially unit-testable without ALS, the flag, or
// Redis. `now` is injectable so tests drive time deterministically.
export class Trace {
  readonly id: string
  readonly feature: string
  readonly tenantId: string
  readonly startedAt: number
  bookingId?: string
  jobId?: string
  attempt?: number
  queuedAt?: number
  status?: string
  outcome?: string
  private readonly now: () => number
  private readonly stages = new Map<PipelineStage, StageStat>()

  constructor(seed: TraceSeed, tenantId: string, now: () => number) {
    this.id = seed.requestId
    this.feature = seed.feature
    this.tenantId = tenantId
    this.now = now
    this.startedAt = now()
    this.bookingId = seed.bookingId
    this.jobId = seed.jobId
    this.attempt = seed.attempt
    this.queuedAt = seed.queuedAt
  }

  clock(): number { return this.now() }

  /** Accumulate a stage measurement. Negative/NaN durations are clamped to 0. An
   *  optional `fail` annotation marks the stage as a failed occurrence (status /
   *  reason / retryable) — recording only, it never affects control flow. */
  add(stage: PipelineStage, ms: number, fail?: StageFailure): void {
    const d = Number.isFinite(ms) && ms > 0 ? ms : 0
    const s = this.stages.get(stage) ?? { totalMs: 0, count: 0, maxMs: 0 }
    s.totalMs += d
    s.count += 1
    if (d > s.maxMs) s.maxMs = d
    if (fail) {
      if (fail.status) s.status = fail.status
      if (fail.failureReason) s.failureReason = fail.failureReason
      if (typeof fail.retryable === 'boolean') s.retryable = fail.retryable
    }
    this.stages.set(stage, s)
  }

  /** Time an async unit of work and record its wall clock under `stage`. Never
   *  swallows the wrapped work's error — only the timing is a side effect. */
  async time<T>(stage: PipelineStage, fn: () => Promise<T>): Promise<T> {
    const t0 = this.now()
    try {
      return await fn()
    } finally {
      this.add(stage, this.now() - t0)
    }
  }

  setStatus(status?: string, outcome?: string): void {
    if (status !== undefined) this.status = status
    if (outcome !== undefined) this.outcome = outcome
  }

  toRecord(): PipelineTraceRecord {
    const completedAt = this.now()
    const stages: Partial<Record<PipelineStage, StageStat>> = {}
    for (const [k, v] of this.stages) stages[k] = { ...v }
    return {
      id: this.id, at: this.startedAt, tenantId: this.tenantId, feature: this.feature,
      bookingId: this.bookingId, jobId: this.jobId, attempt: this.attempt,
      status: this.status, outcome: this.outcome,
      startedAt: this.startedAt, completedAt,
      durationMs: Math.max(0, completedAt - this.startedAt),
      queuedAt: this.queuedAt, stages,
    }
  }
}

// ── AsyncLocalStorage plumbing (server-only, lazy runtime accessor) ───────────
let resolved = false
let alsInstance: ALSType<Trace> | null = null
function als(): ALSType<Trace> | null {
  if (resolved) return alsInstance
  resolved = true
  const getBuiltin = (globalThis as { process?: { getBuiltinModule?: (m: string) => unknown } }).process?.getBuiltinModule
  if (typeof window === 'undefined' && typeof getBuiltin === 'function') {
    try {
      const mod = getBuiltin('node:async_hooks') as { AsyncLocalStorage: new () => ALSType<Trace> }
      alsInstance = new mod.AsyncLocalStorage()
    } catch { /* runtime without async_hooks — helpers no-op */ }
  }
  return alsInstance
}

export type RunTraceOpts = {
  now?: () => number
  store?: PipelineTraceStore
  env?: Record<string, string | undefined>
}

/**
 * Run `fn` with a pipeline trace active for its entire async lifetime, then flush
 * the finished trace to the metrics store. INERT when the flag is off (no trace, no
 * write, wrapped work runs unchanged) and NESTING-SAFE (an already-active trace is
 * reused — the outermost caller owns creation + the single flush). The flush is
 * fail-soft: a store error is swallowed so telemetry never breaks the job.
 */
export async function runWithTrace<T>(seed: TraceSeed, fn: () => Promise<T>, opts: RunTraceOpts = {}): Promise<T> {
  const store = als()
  if (!store) return fn()                       // no async_hooks (client / unusual runtime)
  if (store.getStore()) return fn()             // nested — the outer scope owns this trace
  if (!isEnabled('AI_PIPELINE_OBSERVABILITY_ENABLED', opts.env ?? process.env)) return fn()
  const tenantId = (() => { try { return currentTenantId() ?? 'default' } catch { return 'default' } })()
  const trace = new Trace(seed, tenantId, opts.now ?? Date.now)
  return store.run(trace, async () => {
    try {
      return await fn()
    } finally {
      try { await recordTrace(trace.toRecord(), opts.store) } catch { /* fail-soft */ }
    }
  })
}

/** The active trace, or undefined outside a `runWithTrace` scope (or flag off). */
export function activeTrace(): Trace | undefined {
  return als()?.getStore()
}

/** Time an async unit of work under `stage` when a trace is active; otherwise run it
 *  directly (a single branch of overhead when observability is off). */
export function timeStage<T>(stage: PipelineStage, fn: () => Promise<T>): Promise<T> {
  const t = activeTrace()
  return t ? t.time(stage, fn) : fn()
}

/** Record an externally-measured duration (e.g. provider latency already known from
 *  the runAiTask result) onto the active trace. No-op when none is active. */
export function markStage(stage: PipelineStage, ms: number | undefined): void {
  if (ms == null) return
  activeTrace()?.add(stage, ms)
}

/** Record a stage that FAILED to execute (a fast-fail path — e.g. the provider was
 *  unavailable) so the trace stays structurally complete: the stage is emitted with
 *  its duration plus status='failed', a coarse failure reason, and the retryable flag.
 *  Purely observational — records only, never affects retry behaviour or flow. Emits
 *  even when the duration is 0/unknown (an instant fail is still a real occurrence).
 *  No-op when no trace is active. */
export function markStageFailure(stage: PipelineStage, ms: number | undefined, failureReason?: string, retryable?: boolean): void {
  activeTrace()?.add(stage, ms ?? 0, { status: 'failed', failureReason, retryable })
}

/** Stamp the terminal status/outcome onto the active trace. No-op when none active. */
export function markTraceOutcome(status?: string, outcome?: string): void {
  activeTrace()?.setStatus(status, outcome)
}
