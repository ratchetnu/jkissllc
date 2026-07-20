import { listTraces, getTrace } from './pipeline-metrics'
import { PIPELINE_STAGES, NOTIFY_FEATURE, isSubStage, type PipelineStage, type PipelineTraceRecord } from './pipeline-trace'

// ── Read-side aggregation over pipeline traces (OPERION AI observability) ─────
// Pure aggregators the latency dashboard reads: per-stage percentiles (where the
// time goes), end-to-end latency distribution, throughput, and the slowest recent
// runs to drill into. Percentiles use nearest-rank so a tiny sample never invents a
// smoother distribution than the evidence supports. Every rate carries its count.

function round(n: number): number { return Math.round(n) }

/** Nearest-rank percentile (p in [0,100]) over a numeric sample. Returns 0 for empty. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  return sorted[idx]
}

function mean(values: number[]): number {
  if (!values.length) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

export type StageAggregate = {
  stage: PipelineStage
  count: number          // traces that recorded this stage
  occurrences: number    // total occurrences (a stage can run >1× per trace, e.g. db writes)
  totalMs: number        // summed time across all traces (fleet-wide time in this stage)
  avgMs: number          // mean per-trace time in this stage
  p50: number
  p95: number
  p99: number
  maxMs: number
  isSubStage: boolean     // true for components of a broader stage (provider, image_preprocess)
  shareOfTotalPct: number // % of the non-overlapping top-level stage time (0 for sub-stages)
}

export type LatencyDistribution = {
  count: number
  avgMs: number
  p50: number
  p95: number
  p99: number
  maxMs: number
}

export type SlowTrace = {
  id: string
  bookingId?: string
  attempt?: number
  status?: string
  outcome?: string
  at: number
  durationMs: number
  stages: Partial<Record<PipelineStage, number>> // per-trace total ms per stage
}

export type PipelineAggregate = {
  traces: number
  window: { from: number; to: number; spanMs: number } | null
  overall: LatencyDistribution           // end-to-end job duration
  stages: StageAggregate[]               // one row per stage, pipeline order
  throughputPerMin: number               // traces / minute over the observed window
  statusBreakdown: { status: string; count: number }[]
  slowest: SlowTrace[]                    // top runs by end-to-end duration
}

/** Per-trace time in a stage (sum of that stage's occurrences within the trace). */
function traceStageMs(rec: PipelineTraceRecord, stage: PipelineStage): number | undefined {
  const s = rec.stages?.[stage]
  return s ? s.totalMs : undefined
}

export function aggregatePipeline(records: PipelineTraceRecord[], slowestN = 10): PipelineAggregate {
  // Job runs vs. the separate notify-only traces. Per-STAGE aggregation folds in every
  // record (so the `notification` stage samples come from the notify traces); the
  // end-to-end / throughput / slowest / status views count JOB runs only.
  const jobTraces = records.filter(r => r.feature !== NOTIFY_FEATURE)
  const traces = jobTraces.length

  if (!records.length) {
    return {
      traces: 0, window: null,
      overall: { count: 0, avgMs: 0, p50: 0, p95: 0, p99: 0, maxMs: 0 },
      stages: PIPELINE_STAGES.map(stage => ({ stage, count: 0, occurrences: 0, totalMs: 0, avgMs: 0, p50: 0, p95: 0, p99: 0, maxMs: 0, isSubStage: isSubStage(stage), shareOfTotalPct: 0 })),
      throughputPerMin: 0, statusBreakdown: [], slowest: [],
    }
  }

  const durations = jobTraces.map(r => r.durationMs)
  const from = jobTraces.length ? Math.min(...jobTraces.map(r => r.at)) : Math.min(...records.map(r => r.at))
  const to = jobTraces.length ? Math.max(...jobTraces.map(r => r.completedAt)) : Math.max(...records.map(r => r.completedAt))
  const spanMs = Math.max(0, to - from)

  // Per-stage: gather the per-trace time, plus fleet-wide totals/occurrences. The
  // "share of total" denominator counts only NON-overlapping top-level stages, so the
  // nested sub-stages (provider/preprocess, already inside `ai`) don't double-count.
  const grandTotal = PIPELINE_STAGES.filter(s => !isSubStage(s)).reduce((sum, stage) => {
    return sum + records.reduce((s, r) => s + (r.stages?.[stage]?.totalMs ?? 0), 0)
  }, 0)

  const stages: StageAggregate[] = PIPELINE_STAGES.map(stage => {
    const perTrace: number[] = []
    let totalMs = 0, occurrences = 0, maxMs = 0
    for (const r of records) {
      const ms = traceStageMs(r, stage)
      if (ms === undefined) continue
      perTrace.push(ms)
      totalMs += ms
      occurrences += r.stages?.[stage]?.count ?? 1
      const om = r.stages?.[stage]?.maxMs ?? ms
      if (om > maxMs) maxMs = om
    }
    return {
      stage,
      count: perTrace.length,
      occurrences,
      totalMs: round(totalMs),
      avgMs: round(mean(perTrace)),
      p50: round(percentile(perTrace, 50)),
      p95: round(percentile(perTrace, 95)),
      p99: round(percentile(perTrace, 99)),
      maxMs: round(maxMs),
      isSubStage: isSubStage(stage),
      shareOfTotalPct: !isSubStage(stage) && grandTotal > 0 ? Math.round((totalMs / grandTotal) * 1000) / 10 : 0,
    }
  })

  const statusMap = new Map<string, number>()
  for (const r of jobTraces) {
    const k = r.status ?? 'unknown'
    statusMap.set(k, (statusMap.get(k) ?? 0) + 1)
  }
  const statusBreakdown = [...statusMap.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count)

  const slowest: SlowTrace[] = [...jobTraces]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, slowestN)
    .map(r => ({
      id: r.id, bookingId: r.bookingId, attempt: r.attempt, status: r.status, outcome: r.outcome,
      at: r.at, durationMs: r.durationMs,
      stages: Object.fromEntries(
        PIPELINE_STAGES.map(s => [s, r.stages?.[s]?.totalMs]).filter(([, v]) => v !== undefined),
      ) as Partial<Record<PipelineStage, number>>,
    }))

  return {
    traces, window: { from, to, spanMs },
    overall: {
      count: traces,
      avgMs: round(mean(durations)),
      p50: round(percentile(durations, 50)),
      p95: round(percentile(durations, 95)),
      p99: round(percentile(durations, 99)),
      maxMs: durations.length ? round(Math.max(...durations)) : 0,
    },
    stages,
    throughputPerMin: spanMs > 0 ? Math.round((traces / (spanMs / 60_000)) * 10) / 10 : 0,
    statusBreakdown,
    slowest,
  }
}

// ── Async helpers (tenant-scoped via listTraces) ─────────────────────────────

export async function getPipelineAggregate(limit = 2000, slowestN = 10): Promise<PipelineAggregate> {
  return aggregatePipeline(await listTraces(limit), slowestN)
}

/** Every trace for one booking, newest first (bounded scan of the retention window). */
export async function getTracesForBooking(bookingId: string, limit = 2000): Promise<PipelineTraceRecord[]> {
  if (!bookingId) return []
  return (await listTraces(limit)).filter(r => r.bookingId === bookingId).sort((a, b) => b.at - a.at)
}

/** One trace by id (thin passthrough so the dashboard has a single import site). */
export async function getTraceById(id: string): Promise<PipelineTraceRecord | null> {
  return getTrace(id)
}
