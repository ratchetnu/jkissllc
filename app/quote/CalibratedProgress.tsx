'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, Loader2, X } from 'lucide-react'
import {
  createTimedDriver, analyzingFraction, STAGE_KEYS,
  type ProgressState, type BackendOutcome, type StageView,
} from '../lib/ai/progress-stages'
import type { ProgressMetricPayload, ProgressOutcome } from '../lib/ai/progress-metrics'

const RED = '#E0002A'

// ─────────────────────────────────────────────────────────────────────────────
// Calibrated six-stage progress (Option A). A thin React shell over the pure state
// machine in lib/ai/progress-stages: it OWNS no progress logic, it only renders the
// ProgressState a ProgressDriver emits and captures instrumentation timings.
//
// Because the UI consumes the driver via its interface, replacing the TIMED driver
// with a future STREAM driver (Option B, real server-sent stage events) is a
// one-line swap here — this component does not change.
//
// Timings captured (→ /api/quote/progress-metric):
//   • per-stage dwell (attributed on each active-stage transition)
//   • customer-visible wait (mount → terminal, or → abandonment)
//   • perceived vs actual completion gap (terminal render − API-settled)
//   • abandonment (unmount / tab-hide before the terminal)
// ─────────────────────────────────────────────────────────────────────────────

type Props = {
  analyzeP50Ms: number
  settle: BackendOutcome | null                 // the real API outcome (null while in flight)
  onDone: (outcome: BackendOutcome) => void      // fired after the terminal is shown → parent swaps view
  onMetrics: (p: ProgressMetricPayload) => void   // durable beacon (parent posts it)
}

const outcomeKind = (o: BackendOutcome): ProgressOutcome =>
  o.kind === 'success' ? 'success' : o.kind === 'review' ? 'review' : 'error'

// Post-terminal hold so the customer registers the outcome before the view swaps.
const HOLD_MS = { success: 650, review: 950, error: 950 } as const

export default function CalibratedProgress({ analyzeP50Ms, settle, onDone, onMetrics }: Props) {
  const reducedMotion = useRef(false)
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try { reducedMotion.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { /* default false */ }
  }

  const [state, setState] = useState<ProgressState | null>(null)
  const [frac, setFrac] = useState(0)

  const driverRef = useRef<ReturnType<typeof createTimedDriver> | null>(null)
  const startAtRef = useRef(0)
  const respondedAtRef = useRef<number | null>(null)
  const stageMsRef = useRef<Record<string, number>>({})
  const lastActiveRef = useRef<{ index: number; at: number }>({ index: -2, at: 0 })
  const finalizedRef = useRef(false)
  const reportedRef = useRef(false)

  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

  // Attribute elapsed time to the stage that WAS active when the active stage changes.
  function accrueTransition(nextIndex: number) {
    const t = nowMs()
    const prev = lastActiveRef.current
    if (prev.index >= 0 && prev.index < STAGE_KEYS.length) {
      const key = STAGE_KEYS[prev.index]
      stageMsRef.current[key] = (stageMsRef.current[key] ?? 0) + (t - prev.at)
    }
    lastActiveRef.current = { index: nextIndex, at: t }
  }

  // ── Driver lifecycle (mount once) ──────────────────────────────────────────
  useEffect(() => {
    startAtRef.current = nowMs()
    lastActiveRef.current = { index: -2, at: startAtRef.current }
    const driver = createTimedDriver({ analyzeP50Ms, reducedMotion: reducedMotion.current })
    driverRef.current = driver

    driver.start((s) => {
      if (s.activeIndex !== lastActiveRef.current.index) accrueTransition(s.activeIndex)
      setState(s)
      if (!reducedMotion.current && s.phase === 'running') {
        setFrac(analyzingFraction(nowMs() - startAtRef.current, analyzeP50Ms))
      }
      if (s.settled && !finalizedRef.current) finalize(s)
    })

    return () => {
      driver.dispose()
      // Abandoned: left before the terminal. Report once.
      if (!finalizedRef.current && !reportedRef.current) {
        reportedRef.current = true
        onMetrics({ outcome: 'abandoned', waitMs: Math.round(nowMs() - startAtRef.current), stageMs: snapshotStageMs() })
      }
    }
    // analyzeP50Ms/settle intentionally excluded — captured at mount; settle handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Real API outcome → drive the terminal ──────────────────────────────────
  useEffect(() => {
    if (settle && respondedAtRef.current == null) {
      respondedAtRef.current = nowMs()
      driverRef.current?.settle(settle)
    }
  }, [settle])

  // ── Tab hidden / navigating away before the terminal → beacon abandonment ───
  useEffect(() => {
    const onHide = () => {
      if (finalizedRef.current || reportedRef.current) return
      reportedRef.current = true
      onMetrics({ outcome: 'abandoned', waitMs: Math.round(nowMs() - startAtRef.current), stageMs: snapshotStageMs() })
    }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function snapshotStageMs(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(stageMsRef.current)) out[k] = Math.round(v)
    return out
  }

  function finalize(s: ProgressState) {
    finalizedRef.current = true
    // Close out the final active stage's dwell.
    accrueTransition(-1)
    const outcome: BackendOutcome = settle ?? (s.phase === 'success'
      ? { kind: 'success', decision: 'estimate_range' }
      : s.phase === 'review' ? { kind: 'review' } : { kind: 'error' })
    const terminalAt = nowMs()
    const respondedAt = respondedAtRef.current ?? terminalAt

    if (!reportedRef.current) {
      reportedRef.current = true
      const payload: ProgressMetricPayload = {
        outcome: outcomeKind(outcome),
        waitMs: Math.round(terminalAt - startAtRef.current),
        stageMs: snapshotStageMs(),
      }
      if (outcome.kind === 'success') payload.perceivedGapMs = Math.max(0, Math.round(terminalAt - respondedAt))
      onMetrics(payload)
    }

    const hold = HOLD_MS[outcome.kind === 'success' ? 'success' : outcome.kind === 'review' ? 'review' : 'error']
    window.setTimeout(() => onDone(outcome), hold)
  }

  if (!state) return null

  return (
    <div className="py-6 text-center wiz-reveal">
      <span
        aria-hidden
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 60, height: 60,
          borderRadius: 999, marginBottom: 16,
          background: state.phase === 'error' ? 'rgba(248,113,113,.12)' : 'rgba(224,0,42,.12)',
          color: state.phase === 'error' ? '#f87171' : RED,
        }}
      >
        {state.settled
          ? (state.phase === 'success' ? <Check size={28} /> : state.phase === 'error' ? <X size={28} /> : <Check size={28} />)
          : (reducedMotion.current ? <Check size={22} /> : <Loader2 size={28} className="animate-spin" />)}
      </span>

      <h2 className="text-2xl font-black text-white" style={{ letterSpacing: '-0.02em', fontFamily: 'var(--font-display)' }}>
        {state.phase === 'success' ? 'Your estimate is ready' : 'Analyzing your photos'}
      </h2>

      {/* Live region: the single status line the customer (and screen readers) track. */}
      <p role="status" aria-live="polite" aria-atomic="true" className="text-sm mt-2 mb-5" style={{ color: 'var(--muted)', lineHeight: 1.5 }}>
        {state.message}
      </p>

      <div className="grid gap-2 max-w-sm mx-auto text-left">
        {state.stages.map((st, i) => (
          <StageRow key={st.key} stage={st} isAiStage={STAGE_KEYS[i] === 'ai-analyzing'}
            frac={frac} reducedMotion={reducedMotion.current} />
        ))}
      </div>
    </div>
  )
}

function StageRow({ stage, isAiStage, frac, reducedMotion }: {
  stage: StageView; isAiStage: boolean; frac: number; reducedMotion: boolean
}) {
  const done = stage.status === 'complete'
  const active = stage.status === 'active'
  const failed = stage.status === 'failed'
  const color = done ? '#4ade80' : failed ? '#f87171' : active ? RED : 'rgba(255,255,255,.3)'

  return (
    <div className="flex items-center gap-2.5 px-3 py-2 rounded-xl"
      style={{ border: '1px solid var(--line)', background: active ? 'rgba(224,0,42,.05)' : 'rgba(255,255,255,.02)' }}>
      <span aria-hidden style={{ flexShrink: 0, display: 'inline-flex', width: 16, justifyContent: 'center', color }}>
        {done ? <Check size={15} />
          : failed ? <X size={15} />
          : active
            ? (reducedMotion ? <span style={{ fontWeight: 900 }}>›</span> : <Loader2 size={14} className="animate-spin" />)
            : <span style={{ width: 6, height: 6, borderRadius: 999, background: color, display: 'inline-block' }} />}
      </span>
      <span className="text-sm" style={{ color: done ? '#e5e7eb' : active ? '#fff' : 'var(--muted)', flex: 1 }}>
        {stage.label}
      </span>
      {/* AI-Analyzing sub-progress: eased, asymptotic — never reaches 100% while
          the request is in flight, so nothing looks complete early. Hidden under
          reduced motion (no continuous animation). */}
      {isAiStage && active && !reducedMotion && (
        <span aria-hidden style={{ width: 54, height: 4, borderRadius: 999, background: 'rgba(255,255,255,.10)', overflow: 'hidden', flexShrink: 0 }}>
          <span style={{ display: 'block', height: '100%', width: `${Math.round(frac * 100)}%`, background: RED, transition: 'width .2s linear' }} />
        </span>
      )}
    </div>
  )
}
