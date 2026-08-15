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
  }
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
  /** The primary vision call's slice at `now`. */
  primary(now: number): StageBudget
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
    primary(now: number): StageBudget {
      // The primary read is the whole point of the request: give it everything
      // available up to its cap. If even a second isn't left, 0 ⇒ skip to fallback.
      return { timeoutMs: Math.min(cfg.primaryMaxMs, remainingMs(now)), attempts: 1 }
    },
    critic(now: number): StageBudget {
      // The critic is a verification luxury. It runs only if a MEANINGFUL slice
      // survives the primary call — a critic that times out is pure latency for no
      // verdict. Below criticMinMs we skip it deliberately and record the skip.
      const left = Math.min(cfg.criticMaxMs, remainingMs(now))
      return { timeoutMs: left >= cfg.criticMinMs ? left : 0, attempts: 1 }
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
    primary: () => ({ timeoutMs: 0, attempts: 1 }),
    critic: () => ({ timeoutMs: 0, attempts: 1 }),
  }
}

/** True when a stage budget says "do not start this stage at all". */
export function isSkipped(b: StageBudget, mode: AnalysisMode): boolean {
  return mode === 'interactive' && b.timeoutMs <= 0
}
