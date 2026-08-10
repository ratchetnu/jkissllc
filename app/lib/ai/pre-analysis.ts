// ─────────────────────────────────────────────────────────────────────────────
// Speculative pre-analysis controller.
//
// WHY. The photo analysis used to start when the customer pressed Continue on the
// Photos step, and the button blocked until the model answered. Every second of
// model time was a second of the customer staring at a spinner — and the customer
// had usually been sitting on that step for a while already, doing nothing.
//
// WHAT. Start the SAME analysis as soon as the photo set has settled, so the model
// call overlaps the customer's own dwell time. By the time they press Continue the
// answer is usually already in hand and the step advances instantly.
//
// WHY IT NEEDS A CONTROLLER AND NOT A useEffect. Speculation is only safe if a
// result can never be attributed to the wrong inputs. Five hazards, all handled here:
//
//   1. UNSETTLED UPLOADS — analyzing while a photo is still uploading would price an
//      INCOMPLETE set. We start only once nothing is in flight.
//   2. RAPID CHANGES — picking four photos one after another must not fire four
//      analyses. A debounce collapses a burst into one run.
//   3. STALE RESULTS — a run started before a photo was removed must never be shown.
//      Every run is keyed by a fingerprint of its exact inputs and is discarded on
//      arrival if that key is no longer current.
//   4. DUPLICATE RUNS — the same fingerprint must never have two analyses in flight
//      (double provider cost for one answer).
//   5. DUPLICATE COMPLETIONS — a runner that settles twice (retry races, double
//      callbacks) must apply exactly once.
//
// The key covers photos AND service AND debris because all three change the model's
// input and the deterministic pricing category — a service switch invalidates a read
// just as surely as a new photo does.
//
// PURE + INJECTABLE — no React, no DOM, no global timers, no clock of its own. The
// browser wires real timers in; the tests wire fake ones and drive it deterministically.
// ─────────────────────────────────────────────────────────────────────────────

import { photoSetFingerprint } from './photo-set'

export type PreAnalysisRequest = {
  /** Only SETTLED photo URLs (uploaded, server-acknowledged). Never in-flight ones. */
  photoUrls: string[]
  /** The selected service — changes the pricing category, so it is part of identity. */
  service: string
  /** Optional debris qualifier — also feeds the pricing category. */
  debris?: string
}

/**
 * Stable identity for one analyzable set of inputs. Order-insensitive on photos
 * (remove-then-readd is the same set), exact on service/debris.
 */
export function preAnalysisKey(req: PreAnalysisRequest): string {
  return [photoSetFingerprint(req.photoUrls), req.service || '-', req.debris || '-'].join('|')
}

/**
 * The work itself. `signal` aborts when the inputs change under a running analysis.
 * `speculative` is true when WE started the run on our own initiative (the customer
 * has not asked for the answer yet) — speculating costs a provider call for a
 * customer who may still abandon, so the caller must be able to record that rate.
 */
export type PreAnalysisRunner<T> = (
  req: PreAnalysisRequest,
  ctx: { key: string; signal: AbortSignal; speculative: boolean },
) => Promise<T>

export type PreAnalysisStats = {
  /** Analyses actually dispatched to the runner. */
  started: number
  /** Cached results served without a new run (the whole point of speculating). */
  reused: number
  /** Results that arrived after their inputs stopped being current. */
  discarded: number
  /** Runs aborted in flight because the inputs changed. */
  aborted: number
  /** Debounced schedules that were superseded before they fired. */
  coalesced: number
  /** Runner settlements ignored because that run had already settled. */
  duplicateSettles: number
}

export type PreAnalysisController<T> = {
  /**
   * Declare the current inputs. Starts a debounced speculative run when the set is
   * settled, non-empty, not already known, and not already running. Safe to call on
   * every render / state change — that is the intended usage.
   */
  schedule(req: PreAnalysisRequest, opts: { settled: boolean }): void
  /**
   * The customer needs the answer NOW (they pressed Continue). Returns the cached
   * result if speculation already produced one, joins an in-flight run for the same
   * inputs, or starts one immediately (no debounce). Null when there is nothing to
   * analyze.
   */
  ensure(req: PreAnalysisRequest): Promise<T | null>
  /** Cached result for a key, if any. */
  result(key: string): T | undefined
  /** The key the controller currently considers authoritative. */
  currentKey(): string
  /** True when an analysis for `key` is in flight. */
  isRunning(key: string): boolean
  stats(): PreAnalysisStats
  /** Abort in-flight work and clear timers (component unmount). */
  dispose(): void
}

export type PreAnalysisOptions<T> = {
  run: PreAnalysisRunner<T>
  /** Collapse a burst of changes into one run. */
  debounceMs?: number
  /** Injectable timers so tests never wait on real time. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** Notified when a result becomes current — the React binding calls setState here. */
  onResult?: (value: T, key: string) => void
  /** Notified when a speculative run starts/stops, for spinner state. */
  onRunningChange?: (running: boolean, key: string) => void
}

const DEFAULT_DEBOUNCE_MS = 600

export function createPreAnalysisController<T>(opts: PreAnalysisOptions<T>): PreAnalysisController<T> {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))

  const results = new Map<string, T>()
  const inFlight = new Map<string, { promise: Promise<T | null>; abort: AbortController }>()
  const stats: PreAnalysisStats = {
    started: 0, reused: 0, discarded: 0, aborted: 0, coalesced: 0, duplicateSettles: 0,
  }

  let key = ''
  let pendingTimer: unknown = null
  let pendingKey = ''
  let disposed = false

  const clearPending = () => {
    if (pendingTimer != null) { clearTimer(pendingTimer); pendingTimer = null; pendingKey = '' }
  }

  // Abort every run that is no longer for the current key. A superseded analysis is
  // wasted provider spend AND a stale-result hazard, so we stop it at the source.
  const abortStale = () => {
    for (const [k, run] of inFlight) {
      if (k !== key) {
        stats.aborted++
        try { run.abort.abort() } catch { /* already gone */ }
        inFlight.delete(k)
      }
    }
  }

  function start(req: PreAnalysisRequest, runKey: string, speculative: boolean): Promise<T | null> {
    const existing = inFlight.get(runKey)
    if (existing) return existing.promise      // one in-flight run per fingerprint

    const abort = new AbortController()
    stats.started++
    opts.onRunningChange?.(true, runKey)

    // `settled` makes the completion path idempotent: a runner that resolves AND
    // rejects, or fires a callback twice, applies exactly once.
    let settled = false
    const finish = (value: T | null): T | null => {
      if (settled) { stats.duplicateSettles++; return value }
      settled = true
      inFlight.delete(runKey)
      opts.onRunningChange?.(false, runKey)
      if (disposed) return value
      // The guard that makes speculation safe: a result is only adopted if its
      // inputs are STILL the current inputs.
      if (runKey !== key) { stats.discarded++; return null }
      if (value != null) {
        results.set(runKey, value)
        opts.onResult?.(value, runKey)
      }
      return value
    }

    const promise = opts.run(req, { key: runKey, signal: abort.signal, speculative })
      .then(v => finish(v))
      .catch(() => finish(null))

    inFlight.set(runKey, { promise, abort })
    return promise
  }

  return {
    schedule(req, { settled }) {
      if (disposed) return
      const nextKey = preAnalysisKey(req)
      if (nextKey !== key) {
        key = nextKey
        abortStale()          // inputs moved on — nothing older can still be adopted
      }
      // An unsettled set is an INCOMPLETE set. Wait; do not analyze a partial upload.
      if (!settled || req.photoUrls.length === 0) { clearPending(); return }
      if (results.has(nextKey) || inFlight.has(nextKey)) { clearPending(); return }

      if (pendingTimer != null) {
        if (pendingKey === nextKey) return    // already queued for these exact inputs
        stats.coalesced++                     // a burst superseded its own earlier tick
        clearPending()
      }
      pendingKey = nextKey
      pendingTimer = setTimer(() => {
        pendingTimer = null
        pendingKey = ''
        // Re-check on fire: the inputs may have moved during the debounce window.
        if (disposed || preAnalysisKey(req) !== key) return
        void start(req, nextKey, true)
      }, debounceMs)
    },

    async ensure(req) {
      if (disposed) return null
      const wantKey = preAnalysisKey(req)
      if (wantKey !== key) { key = wantKey; abortStale() }
      clearPending()                          // the customer is here; no more waiting
      if (req.photoUrls.length === 0) return null

      const cached = results.get(wantKey)
      if (cached !== undefined) { stats.reused++; return cached }   // speculation paid off

      const running = inFlight.get(wantKey)
      if (running) { stats.reused++; return running.promise }       // join, never duplicate

      return start(req, wantKey, false)
    },

    result: (k) => results.get(k),
    currentKey: () => key,
    isRunning: (k) => inFlight.has(k),
    stats: () => ({ ...stats }),
    dispose() {
      disposed = true
      clearPending()
      for (const [, run] of inFlight) { try { run.abort.abort() } catch { /* already gone */ } }
      inFlight.clear()
    },
  }
}
