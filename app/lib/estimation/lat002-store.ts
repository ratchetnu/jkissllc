// LAT-002 experiment runs — durable, tenant-scoped, append-only.
//
// A run is EVIDENCE, so it is stored whole: the pairs it was computed from travel
// with the report. A report whose inputs were discarded cannot be re-checked when
// someone later disputes the verdict, and "trust the number" is not evidence.
//
// Keys follow the shadow lane (`shadow:*` → `lat002:*`), so they are tenant-owned
// and scoped by the redis chokepoint, which fails closed with no tenant context.
import { redis } from '../redis'
import { evaluateLat002, type Lat002Pair, type Lat002Report, type Lat002Thresholds } from './lat002'

const KEY_RUN = 'lat002:run:'
const KEY_INDEX = 'lat002:index'

/** Bounded so one run cannot become an unbounded blob in KV. */
export const MAX_RUN_PAIRS = 500
/** Bounded listing — the admin surface shows recent runs, not all of history. */
export const MAX_RUNS_LISTED = 100

export type Lat002Run = {
  runId: string
  /** What the two arms actually were. Free-form because a candidate might be a
   *  different model, prompt version, or image pipeline — the harness does not
   *  care which, only that the arms are labelled honestly. */
  arms: { baseline: string; candidate: string }
  note?: string
  createdAt: number
  createdBy: string
  pairs: Lat002Pair[]
  report: Lat002Report
}

const safeParse = <T,>(raw: unknown): T | null => {
  if (typeof raw !== 'string') return null
  try { return JSON.parse(raw) as T } catch { return null }
}

export const RUN_ID_RE = /^lat002_[a-z0-9]{10,40}$/

export async function getLat002Run(runId: string): Promise<Lat002Run | null> {
  if (!RUN_ID_RE.test(runId)) return null
  return safeParse<Lat002Run>(await redis.get(KEY_RUN + runId))
}

/**
 * Persist a run. The report is RECOMPUTED here from the stored pairs rather than
 * accepted from the caller, so a stored report can never disagree with the
 * evidence stored beside it.
 */
export async function saveLat002Run(input: {
  runId: string
  arms: { baseline: string; candidate: string }
  note?: string
  createdAt: number
  createdBy: string
  pairs: Lat002Pair[]
  thresholds?: Partial<Lat002Thresholds>
}): Promise<Lat002Run> {
  const pairs = input.pairs.slice(0, MAX_RUN_PAIRS)
  const run: Lat002Run = {
    runId: input.runId,
    arms: input.arms,
    note: input.note,
    createdAt: input.createdAt,
    createdBy: input.createdBy,
    pairs,
    report: evaluateLat002(pairs, input.thresholds),
  }
  await redis.set(KEY_RUN + run.runId, JSON.stringify(run))
  await redis.zadd(KEY_INDEX, run.createdAt, run.runId)
  return run
}

/** Recent runs, newest first. Returns summaries — never every pair of every run. */
export async function listLat002Runs(limit = 20): Promise<Array<Omit<Lat002Run, 'pairs'>>> {
  const ids = await redis.zrevrange(KEY_INDEX, 0, Math.max(0, Math.min(limit, MAX_RUNS_LISTED) - 1))
  const out: Array<Omit<Lat002Run, 'pairs'>> = []
  for (const id of ids) {
    const run = safeParse<Lat002Run>(await redis.get(KEY_RUN + id))
    if (!run) continue
    const { pairs: _pairs, ...summary } = run
    out.push(summary)
  }
  return out
}
