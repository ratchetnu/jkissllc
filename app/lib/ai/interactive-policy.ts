// ─────────────────────────────────────────────────────────────────────────────
// Interactive analysis policy — the explicit LATENCY BUDGET for the customer-
// facing photo estimate (POST /api/quote/analyze).
//
// THE PROBLEM THIS SOLVES. The interactive route runs inside a Vercel function
// ceiling (`maxDuration`). Before this module the route had no budget at all: the
// primary vision call used the 30s platform default and the AI service retried it
// once on a transient failure (a timeout classifies as transient), so two attempts
// alone could consume 60s — exactly the route ceiling. The critic then wanted a
// full second vision pass on top. When the budget was blown the PLATFORM killed the
// function, the browser saw a dead request, and the customer landed on "We'll
// review your photos" with no estimate and no recorded reason.
//
// THE RULE. An interactive analysis must ALWAYS return a structured outcome to the
// customer BEFORE the platform can terminate the request. We reserve a response
// margin, spend what is left on the model, and degrade deliberately if the budget
// runs out. A budget overrun is now a first-class, recorded outcome — never a 504.
//
// ASYMMETRY WITH THE DURABLE WORKER (deliberate). This policy applies ONLY to the
// interactive path. The durable server-side worker (lib/book-now-ai.ts) keeps its
// existing, much longer policy — 300s function, 150s per-job deadline, up to 5
// attempts with exponential backoff — because nobody is waiting on it. Interactive
// = fast + single-shot + always-answers. Durable = patient + persistent + thorough.
//
// PURE + DETERMINISTIC — no I/O, no clock of its own (callers pass `now`), never
// throws. Every number is env-overridable so the budget can be tuned per
// environment without a code change.
// ─────────────────────────────────────────────────────────────────────────────

export type AnalysisMode = 'interactive' | 'durable'

/** The reason an interactive analysis stopped short of a full read. */
export type InteractiveDegradeReason =
  | 'primary_timeout'      // the primary vision call exhausted its slice
  | 'budget_exhausted'     // no usable time remained before the response margin

/** A resolved per-call plan for one stage of the interactive analysis. */
export type StageBudget = {
  /** Milliseconds this stage may spend. 0 ⇒ the stage must be skipped. */
  timeoutMs: number
  /** Model-call attempts for this stage. Interactive is always single-shot. */
  attempts: number
  /**
   * Output-token ceiling for this stage. `undefined` ⇒ NO OVERRIDE: the analyzer's
   * own photo-count-scaled budget applies (the durable behaviour). Never 0.
   *
   * ── WHY THIS FIELD EXISTS ────────────────────────────────────────────────────
   * junk-analysis derives its wall-clock allowance FROM its output-token budget and
   * says so plainly: the two "are coupled in reality and were independent in code,
   * which is a bug waiting to happen and duly happened". That coupling holds inside
   * `analysisTimeoutMs`. It did NOT hold across this boundary: the interactive
   * caller pinned its own `timeoutMs` and left `maxOutputTokens` at the durable,
   * photo-count-scaled value — re-opening the exact drift the coupling forbids, from
   * the outside.
   *
   * The arithmetic was unsatisfiable at EVERY photo count, not just large ones. At
   * the measured ~107 output tok/s the durable budget needs 24s of generation for a
   * single photo and 64s for eight, against a 32s slice — so an interactive analysis
   * that actually used its output allowance could never finish, and every one timed
   * out. Pinning the slice without pinning the ask is what made the failure total.
   *
   * ── WHY `undefined` AND NOT `0` ──────────────────────────────────────────────
   * This field briefly used 0 for "no override" while `outputTokensForSlice`
   * returned 0 for "cannot afford a response". Those are OPPOSITE instructions
   * sharing one value, and the analyzer resolves a falsy override to its full
   * photo-count-scaled budget — so a slice too thin to afford anything asked for
   * the largest budget available, which is precisely the request this policy
   * exists to prevent. `undefined` now means no-override and nothing else;
   * "cannot afford" is carried by `skipProvider`.
   */
  maxOutputTokens?: number
  /**
   * True ⇒ do NOT call the provider at all for this stage.
   *
   * A doomed call is strictly worse than no call: it spends money, holds the
   * customer, and returns either nothing or a truncated JSON that discards the
   * whole read. The caller must produce its structured unpriced fallback instead.
   */
  skipProvider: boolean
}

export type InteractiveBudgetConfig = {
  /** The route's Vercel function ceiling, in ms — the hard wall we must beat. */
  routeCeilingMs: number
  /** Reserved for pricing, persistence and serializing the response. */
  responseMarginMs: number
  /** Upper bound on the primary vision call. */
  primaryMaxMs: number
  /** Upper bound on the second-opinion critic. */
  criticMaxMs: number
  /** Below this the critic is not worth starting — skip it rather than time out. */
  criticMinMs: number
  /**
   * Observed output-token generation rate, tokens/sec. Sizing comes from the same
   * measurement junk-analysis cites: a 6-photo job generating 1600 tokens completed
   * in 25.5s, implying ~10s fixed overhead and ~107 tok/s.
   */
  outputTokensPerSec: number
  /** Fixed non-generation cost of a call (image fetch + input processing), ms. */
  fixedOverheadMs: number
  /**
   * Never ask for fewer than this many output tokens. Below roughly this the model
   * cannot express even a small, honest read, and a truncated JSON is worse than a
   * clean fallback — it discards the whole analysis (the JK-B-1022 failure).
   */
  minOutputTokens: number
}

// Defaults chosen against the SHIPPED route ceiling of 60s:
//   primary 32s + critic 15s + margin 6s = 53s worst case, 7s under the wall.
// The route ceiling is declared here as data so a change to the route's
// `maxDuration` and a change to the budget can never silently disagree — the
// route asserts them equal at module load (see quote/analyze/route.ts).
export const INTERACTIVE_ROUTE_CEILING_MS = 60_000
export const DEFAULT_INTERACTIVE_BUDGET: InteractiveBudgetConfig = {
  routeCeilingMs: INTERACTIVE_ROUTE_CEILING_MS,
  responseMarginMs: 6_000,
  primaryMaxMs: 32_000,
  criticMaxMs: 15_000,
  criticMinMs: 8_000,
  outputTokensPerSec: 107,
  fixedOverheadMs: 10_000,
  minOutputTokens: 1_200,
}

type EnvLike = Record<string, string | undefined>

function envMs(env: EnvLike, key: string, fallback: number): number {
  const raw = Number(env[key])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

/** Resolve the budget from the environment, falling back to the shipped defaults. */
export function resolveInteractiveBudget(env: EnvLike = process.env): InteractiveBudgetConfig {
  const d = DEFAULT_INTERACTIVE_BUDGET
  return {
    routeCeilingMs: envMs(env, 'QUOTE_ANALYZE_CEILING_MS', d.routeCeilingMs),
    responseMarginMs: envMs(env, 'QUOTE_ANALYZE_RESPONSE_MARGIN_MS', d.responseMarginMs),
    primaryMaxMs: envMs(env, 'QUOTE_ANALYZE_PRIMARY_MAX_MS', d.primaryMaxMs),
    criticMaxMs: envMs(env, 'QUOTE_ANALYZE_CRITIC_MAX_MS', d.criticMaxMs),
    criticMinMs: envMs(env, 'QUOTE_ANALYZE_CRITIC_MIN_MS', d.criticMinMs),
    outputTokensPerSec: envMs(env, 'QUOTE_ANALYZE_OUTPUT_TOKENS_PER_SEC', d.outputTokensPerSec),
    fixedOverheadMs: envMs(env, 'QUOTE_ANALYZE_FIXED_OVERHEAD_MS', d.fixedOverheadMs),
    minOutputTokens: envMs(env, 'QUOTE_ANALYZE_MIN_OUTPUT_TOKENS', d.minOutputTokens),
  }
}

/**
 * The output-token ceiling that actually FITS a given slice of wall clock.
 *
 * This is the inverse of junk-analysis's `analysisTimeoutMs`: that function turns a
 * token budget into the time it needs, this one turns available time back into the
 * tokens it can pay for. Keeping both makes the coupling total — whichever end is
 * pinned, the other is derived, so the two can no longer drift apart.
 *
 * `cap` is the analyzer's own photo-count-scaled budget. We never RAISE it (a small
 * job should not be handed a large job's allowance); we only lower it to what the
 * clock can afford.
 *
 * Returns **null** — not 0 — when even the floor cannot fit. 0 was ambiguous in the
 * worst possible direction: the analyzer reads a falsy override as "use the full
 * photo-count-scaled budget", so "cannot afford anything" resolved to "ask for the
 * most we ever ask for". null cannot be misread as a quantity.
 */
export function outputTokensForSlice(
  sliceMs: number,
  cap: number,
  cfg: InteractiveBudgetConfig = resolveInteractiveBudget(),
): number | null {
  const generationMs = sliceMs - cfg.fixedOverheadMs
  if (generationMs <= 0) return null
  const affordable = Math.floor((generationMs / 1000) * cfg.outputTokensPerSec)
  if (affordable < cfg.minOutputTokens) return null
  return Math.min(cap, affordable)
}

/**
 * A live latency budget for ONE interactive analysis.
 *
 * Construct it at the top of the request with the request's start time, then ask
 * it for each stage's slice as the work proceeds. It never returns a slice that
 * would run past the response margin, so the caller always keeps enough time to
 * build and send a real answer.
 */
export type InteractiveBudget = {
  readonly mode: AnalysisMode
  readonly config: InteractiveBudgetConfig
  /** Absolute ms timestamp after which NO new model work may start. */
  readonly deadlineAt: number
  /** Time left before the deadline at `now`, never negative. */
  remainingMs(now: number): number
  /**
   * The primary vision call's slice at `now`. `cap` is the analyzer's own
   * photo-count-scaled token budget; the returned `maxOutputTokens` is that value
   * reduced to whatever the slice can actually pay for.
   */
  primary(now: number, cap?: number): StageBudget
  /** The critic's slice at `now` — timeoutMs 0 ⇒ skip (not enough budget left). */
  critic(now: number): StageBudget
}

/**
 * Build the interactive budget. `startedAt` is when the request began — every
 * slice is measured against it, so slow non-model work (KV reads, image dedupe)
 * correctly shrinks what the model is allowed to spend.
 */
export function interactiveBudget(startedAt: number, config?: Partial<InteractiveBudgetConfig>): InteractiveBudget {
  const cfg: InteractiveBudgetConfig = { ...resolveInteractiveBudget(), ...(config ?? {}) }
  const deadlineAt = startedAt + Math.max(0, cfg.routeCeilingMs - cfg.responseMarginMs)
  const remainingMs = (now: number) => Math.max(0, deadlineAt - now)
  return {
    mode: 'interactive',
    config: cfg,
    deadlineAt,
    remainingMs,
    primary(now: number, cap?: number): StageBudget {
      // The primary read is the whole point of the request: give it everything
      // available up to its cap.
      const timeoutMs = Math.min(cfg.primaryMaxMs, remainingMs(now))

      // No analyzer cap supplied — the moving lane, which carries its own constant
      // output budget and never consulted this field. It keeps today's behaviour
      // exactly: no override, and the only reason to skip is having no time at all.
      if (cap == null) {
        return { timeoutMs, attempts: 1, maxOutputTokens: undefined, skipProvider: timeoutMs <= 0 }
      }

      // Ask the model for only as much as this slice can pay for. Asking for the
      // durable budget inside an interactive slice is what made every one of these
      // calls time out; see the StageBudget.maxOutputTokens note.
      const affordable = outputTokensForSlice(timeoutMs, cap, cfg)

      // Cannot afford even the minimum honest response. Say SKIP explicitly rather
      // than passing a falsy ceiling the analyzer would resolve back to its full
      // budget — that resolution is what let an exhausted slice launch the largest
      // request in the system.
      if (affordable == null) {
        return { timeoutMs, attempts: 1, maxOutputTokens: undefined, skipProvider: true }
      }
      return { timeoutMs, attempts: 1, maxOutputTokens: affordable, skipProvider: false }
    },
    critic(now: number): StageBudget {
      // The critic is a verification luxury. It runs only if a MEANINGFUL slice
      // survives the primary call — a critic that times out is pure latency for no
      // verdict. Below criticMinMs we skip it deliberately and record the skip.
      const left = Math.min(cfg.criticMaxMs, remainingMs(now))
      const timeoutMs = left >= cfg.criticMinMs ? left : 0
      // The critic keeps the analyzer's own allowance (undefined = no override): it
      // returns a small verdict object, not a full read, so it was never the stage
      // at risk of outrunning its slice.
      return { timeoutMs, attempts: 1, maxOutputTokens: undefined, skipProvider: timeoutMs <= 0 }
    },
  }
}

/**
 * The durable worker's policy, expressed in the same shape so `buildPhotoEstimate`
 * has ONE budget type to thread. The per-call TIMEOUT stays unbounded here (0 ⇒ "no
 * override"), so the analyzer's own photo-count-scaled allowance applies.
 *
 * ATTEMPTS are pinned to 1, and deliberately so. The comment this replaces said the
 * worker "owns its own attempt/backoff ladder on the booking" — which is exactly right,
 * and exactly why a second attempt INSIDE the call is redundant here. The booking
 * already retries up to MAX_ATTEMPTS with a 1m/5m/15m/1h backoff, so a transient failure
 * is picked up by the next cron tick regardless.
 *
 * What the inner retry does add is deadline consumption. Once the analysis allowance
 * became photo-count-scaled (up to ~102s for an 8-photo set), two inner attempts came to
 * ~204s against the worker's 150s per-job deadline — so a large job that hit one
 * transient blip could never finish, and the retry that was supposed to rescue it was
 * what guaranteed it failed. One honest attempt plus the outer ladder is strictly better:
 * it fits the deadline, and the resilience is unchanged because it was never coming from
 * here.
 *
 * Worst case now: 8 photos ⇒ ~102s primary + ~30s critic = ~132s, inside 150s.
 */
export function durableBudget(): InteractiveBudget {
  const cfg = resolveInteractiveBudget()
  return {
    mode: 'durable',
    config: cfg,
    deadlineAt: Number.POSITIVE_INFINITY,
    remainingMs: () => Number.POSITIVE_INFINITY,
    // timeoutMs 0 with mode 'durable' is read by callers as "no override" — the
    // analyzer's own scaled allowance applies. attempts 1 is an explicit pin, not a
    // default: the retry lives on the booking, not inside the call.
    // maxOutputTokens 0 = no override, so the durable worker keeps the analyzer's
    // full photo-count-scaled budget. Its 150s deadline can afford it; the 32s
    // interactive slice never could, which is the whole point of the split.
    primary: () => ({ timeoutMs: 0, attempts: 1, maxOutputTokens: undefined, skipProvider: false }),
    critic: () => ({ timeoutMs: 0, attempts: 1, maxOutputTokens: undefined, skipProvider: false }),
  }
}

/** True when a stage budget says "do not start this stage at all". */
export function isSkipped(b: StageBudget, mode: AnalysisMode): boolean {
  return mode === 'interactive' && b.timeoutMs <= 0
}
