// ─────────────────────────────────────────────────────────────────────────────
// Calibrated customer progress — the PURE state machine (Option A).
//
// The Book Now quote flow makes a single synchronous POST to /api/quote/analyze
// that is dominated by ONE slow step (the vision model call). This module turns
// that opaque wait into a truthful six-stage progress display WITHOUT changing any
// backend behaviour. It is deliberately framework-free and side-effect-free so the
// whole thing is unit-testable and can be driven by either:
//   • a TIMED driver (Option A, today) — advances the sub-progress from measured
//     p50 telemetry, and reveals the trailing stages only when the real API settles;
//   • a STREAM driver (Option B, later) — advances stages on real server events.
// Both feed the SAME ProgressState through the SAME ProgressDriver interface, so
// swapping the timing source never touches the UI (see createTimedDriver + the
// `ProgressDriver` contract at the bottom).
//
// Honesty invariants baked into the state machine (never rendered otherwise):
//   1. The two pre-stages ("Photos Uploaded", "Preparing Images") are genuinely
//      finished before this screen loads → they start complete.
//   2. While the request is in flight the active stage is ALWAYS "AI Analyzing
//      Contents" — the true state — and the trailing stages stay pending. The
//      sub-fraction is capped below 1 so nothing ever LOOKS complete early.
//   3. The terminal state is driven ONLY by the real API outcome:
//        success       → all six complete;
//        manual review → stop at "AI Analyzing Contents"; volume/quote/finalize
//                        are NEVER shown complete (no quote was generated);
//        error         → mark "AI Analyzing Contents" failed; nothing beyond it.
// ─────────────────────────────────────────────────────────────────────────────

export type StageKey =
  | 'photos-uploaded'
  | 'preparing-images'
  | 'ai-analyzing'
  | 'calculating-volume'
  | 'generating-quote'
  | 'finalizing-estimate'

export type StageStatus = 'pending' | 'active' | 'complete' | 'failed'
export type ProgressPhase = 'running' | 'success' | 'review' | 'error'

export type StageView = { key: StageKey; label: string; status: StageStatus }

export type ProgressState = {
  stages: StageView[]
  activeIndex: number        // index of the active stage, or -1 when settled
  phase: ProgressPhase
  message: string
  overrun: boolean           // exceeded the expected window → "still analyzing" copy
  settled: boolean           // a terminal (success/review/error) has been applied
}

// The real backend result the animation must never contradict. Mapped from the
// /api/quote/analyze response: decision instant_quote|estimate_range → success,
// manual_review → review, any non-ok / missing estimate → error.
export type BackendOutcome =
  | { kind: 'success'; decision: 'instant_quote' | 'estimate_range' }
  | { kind: 'review' }
  | { kind: 'error' }

// Ordered stage definitions. `pre` stages are already done when the screen loads.
export const STAGE_DEFS: { key: StageKey; label: string; pre: boolean }[] = [
  { key: 'photos-uploaded', label: 'Photos Uploaded', pre: true },
  { key: 'preparing-images', label: 'Preparing Images', pre: true },
  { key: 'ai-analyzing', label: 'AI Analyzing Contents', pre: false },
  { key: 'calculating-volume', label: 'Calculating Volume', pre: false },
  { key: 'generating-quote', label: 'Generating Quote', pre: false },
  { key: 'finalizing-estimate', label: 'Finalizing Estimate', pre: false },
]

export const STAGE_KEYS: StageKey[] = STAGE_DEFS.map((s) => s.key)

// Safe default pace when telemetry is thin or the flag is off. Lives here (the
// pure, client-safe module) so the client bundle never pulls in the telemetry/
// Redis graph just to know the fallback.
export const DEFAULT_ANALYZE_P50_MS = 5000
export const ANALYZING_INDEX = STAGE_DEFS.findIndex((s) => s.key === 'ai-analyzing') // 2
export const LAST_INDEX = STAGE_DEFS.length - 1                                       // 5

// Copy. Kept here (not the component) so tests assert the honest wording.
export const MSG = {
  running: 'Analyzing your photos…',
  overrun: 'Still analyzing your photos…',
  success: 'Your estimate is ready.',
  review: 'We’ll review your photos and confirm your quote.',
  error: 'We couldn’t finish automatically — we’ll take it from here.',
} as const

// Beyond p50 × this factor we switch to the reassuring "still analyzing" copy and
// let the sub-bar crawl instead of freezing.
export const OVERRUN_FACTOR = 1.5

// The active-stage sub-progress fraction while running. Eased and ASYMPTOTIC: it
// approaches — but by design never reaches — 1 while the request is in flight, so
// the stage can never look complete before the real response arrives.
export function analyzingFraction(elapsedMs: number, analyzeP50Ms: number): number {
  const p50 = Math.max(1, analyzeP50Ms)
  const t = Math.max(0, elapsedMs) / p50
  const eased = 1 - Math.exp(-1.6 * t) // ~0.80 at t=1, →1 asymptotically
  return Math.min(0.97, eased)          // hard cap: never visually complete while running
}

export function isOverrun(elapsedMs: number, analyzeP50Ms: number): boolean {
  return elapsedMs > Math.max(1, analyzeP50Ms) * OVERRUN_FACTOR
}

function view(status: (i: number) => StageStatus): StageView[] {
  return STAGE_DEFS.map((s, i) => ({ key: s.key, label: s.label, status: status(i) }))
}

/** The running state: pre-stages complete, AI Analyzing active, the rest pending. */
export function runningState(elapsedMs: number, analyzeP50Ms: number): ProgressState {
  const overrun = isOverrun(elapsedMs, analyzeP50Ms)
  return {
    stages: view((i) => (i < ANALYZING_INDEX ? 'complete' : i === ANALYZING_INDEX ? 'active' : 'pending')),
    activeIndex: ANALYZING_INDEX,
    phase: 'running',
    message: overrun ? MSG.overrun : MSG.running,
    overrun,
    settled: false,
  }
}

/** A reveal frame during the success cascade: stages ≤ throughIndex complete, the
 *  next one active, the rest pending. Used to walk 3→4→5 once the API confirms a
 *  quote genuinely was produced. */
export function revealState(throughIndex: number): ProgressState {
  const through = Math.min(LAST_INDEX, Math.max(ANALYZING_INDEX, throughIndex))
  const complete = through >= LAST_INDEX
  return {
    stages: view((i) => (i <= through ? 'complete' : i === through + 1 ? 'active' : 'pending')),
    activeIndex: complete ? -1 : through + 1,
    phase: complete ? 'success' : 'running',
    message: complete ? MSG.success : MSG.running,
    overrun: false,
    settled: complete,
  }
}

/** The truthful terminal state for a real backend outcome. */
export function settledState(outcome: BackendOutcome): ProgressState {
  if (outcome.kind === 'success') {
    return {
      stages: view(() => 'complete'),
      activeIndex: -1, phase: 'success', message: MSG.success, overrun: false, settled: true,
    }
  }
  if (outcome.kind === 'review') {
    // The model analysed the photos but produced no firm quote → stop at AI
    // Analyzing. Volume / quote / finalize did NOT happen, so never mark them done.
    return {
      stages: view((i) => (i <= ANALYZING_INDEX ? 'complete' : 'pending')),
      activeIndex: -1, phase: 'review', message: MSG.review, overrun: false, settled: true,
    }
  }
  // error: analysis did not succeed → the AI stage failed; nothing beyond it ran.
  return {
    stages: view((i) => (i < ANALYZING_INDEX ? 'complete' : i === ANALYZING_INDEX ? 'failed' : 'pending')),
    activeIndex: -1, phase: 'error', message: MSG.error, overrun: false, settled: true,
  }
}

/** The ordered frames to render when the API settles. For success this cascades
 *  the trailing stages (a truthful reveal of work that just completed); for
 *  review/error it is a single truthful terminal. Reduced-motion callers use only
 *  the final frame. */
export function settleFrames(outcome: BackendOutcome): ProgressState[] {
  if (outcome.kind !== 'success') return [settledState(outcome)]
  const frames: ProgressState[] = []
  for (let i = ANALYZING_INDEX; i <= LAST_INDEX; i++) frames.push(revealState(i))
  return frames // ends at revealState(LAST_INDEX) === settled success
}

export const initialState = (analyzeP50Ms: number): ProgressState => runningState(0, analyzeP50Ms)

// ── Driver contract (the seam that lets Option B replace Option A) ─────────────
// The UI subscribes to a driver and reacts to ProgressState only. A driver decides
// WHEN states change; it never renders. Option A = createTimedDriver (below).
// Option B (server-sent progress events) implements the same three methods and the
// component does not change.
export interface ProgressDriver {
  /** Begin emitting states. Emits the initial running state synchronously. */
  start(onState: (s: ProgressState) => void): void
  /** Apply the real backend outcome (drives the terminal / cascade). Idempotent. */
  settle(outcome: BackendOutcome): void
  /** Stop timers / listeners. Safe to call multiple times. */
  dispose(): void
}

export type TimedDriverOptions = {
  analyzeP50Ms: number
  reducedMotion?: boolean
  tickMs?: number          // running sub-progress cadence (default 120ms)
  cascadeStepMs?: number   // per-stage reveal on success (default 180ms)
  now?: () => number       // injectable clock for tests
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (h: unknown) => void
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (h: unknown) => void
}

/**
 * Option A driver: a wall-clock timer. While running it re-emits runningState so
 * the component can ease the AI-Analyzing sub-bar and flip to overrun copy. On
 * settle it plays settleFrames — cascading the trailing stages on success, or a
 * single truthful terminal on review/error. Reduced motion skips the cascade.
 *
 * Pure of React; the host schedules via the injected timer functions (defaulting
 * to the globals) so it is fully testable with fake timers.
 */
export function createTimedDriver(opts: TimedDriverOptions): ProgressDriver {
  const now = opts.now ?? (() => Date.now())
  const tickMs = opts.tickMs ?? 120
  const cascadeStepMs = opts.cascadeStepMs ?? 180
  const setI = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms))
  const clearI = opts.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>))
  const setT = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  const clearT = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))

  let emit: (s: ProgressState) => void = () => {}
  let startedAt = 0
  let tick: unknown = null
  const timers: unknown[] = []
  let done = false

  const stopTick = () => { if (tick != null) { clearI(tick); tick = null } }
  const clearTimers = () => { for (const t of timers) clearT(t); timers.length = 0 }

  return {
    start(onState) {
      emit = onState
      startedAt = now()
      emit(runningState(0, opts.analyzeP50Ms))
      tick = setI(() => {
        if (done) return
        emit(runningState(now() - startedAt, opts.analyzeP50Ms))
      }, tickMs)
    },
    settle(outcome) {
      if (done) return
      done = true
      stopTick()
      const frames = settleFrames(outcome)
      if (opts.reducedMotion || frames.length === 1) {
        emit(frames[frames.length - 1]) // straight to the truthful terminal
        return
      }
      // Cascade: emit each reveal frame on a short stagger.
      frames.forEach((frame, i) => {
        const h = setT(() => emit(frame), i * cascadeStepMs)
        timers.push(h)
      })
    },
    dispose() {
      done = true
      stopTick()
      clearTimers()
    },
  }
}
