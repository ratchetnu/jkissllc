import { listAiCalls, getAiCall, type AiCallRecord, type AiCallKind } from './telemetry'

// ─────────────────────────────────────────────────────────────────────────────
// Read-side services over the AI audit log (`ai:log`) for the LATER AI-dashboard
// session. These are NEW, additive read paths — they do not touch or change the
// existing `computeAiAnalytics` aggregator (app/lib/ai/analytics.ts) or any current
// consumer. They exist so the dashboard can answer questions the old aggregator
// couldn't, using the fields this foundation added:
//   • separate SHADOW / FALLBACK spend from the authoritative PRIMARY path
//   • group cost + volume by PROVIDER (a first-class dimension now)
//   • join AI calls back to a BOOKING
// Pure functions take records so they are trivially unit-testable; the async helpers
// fetch from Redis (tenant-scoped by listAiCalls) and delegate to the pure ones.
// ─────────────────────────────────────────────────────────────────────────────

function round6(n: number): number { return Math.round(n * 1_000_000) / 1_000_000 }
function reached(o: AiCallRecord['outcome']): boolean { return o !== 'forbidden' && o !== 'budget_exceeded' }
function kindOf(r: AiCallRecord): AiCallKind { return r.kind ?? 'primary' }

export type UsageAgg = {
  calls: number
  ok: number
  errors: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  imageCount: number       // total images sent (multimodal cost driver)
  estCostUsd: number
  actualCostUsd: number
  costUsd: number          // actual when present, else estimated — the best cost view
}

function emptyAgg(): UsageAgg {
  return { calls: 0, ok: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, imageCount: 0, estCostUsd: 0, actualCostUsd: 0, costUsd: 0 }
}

function accumulate(a: UsageAgg, r: AiCallRecord): void {
  a.calls++
  const didReach = reached(r.outcome)
  if (r.ok) a.ok++
  else if (didReach) a.errors++
  a.inputTokens += r.inputTokens
  a.outputTokens += r.outputTokens
  a.totalTokens += r.totalTokens
  a.imageCount += r.imageCount ?? 0
  a.estCostUsd += r.estCostUsd
  const actual = r.actualCostUsd ?? 0
  a.actualCostUsd += actual
  a.costUsd += r.costSource === 'actual' && r.actualCostUsd != null ? r.actualCostUsd : r.estCostUsd
}

function finalize(a: UsageAgg): UsageAgg {
  return { ...a, estCostUsd: round6(a.estCostUsd), actualCostUsd: round6(a.actualCostUsd), costUsd: round6(a.costUsd) }
}

// ── Cost + usage split by kind (primary vs shadow vs fallback vs mock vs suppressed).
// THE key new read: lets the dashboard net shadow/eval spend out of authoritative cost.
export type KindBreakdown = Record<AiCallKind, UsageAgg> & { total: UsageAgg }

export function kindBreakdown(records: AiCallRecord[]): KindBreakdown {
  const out = {
    primary: emptyAgg(), shadow: emptyAgg(), fallback: emptyAgg(), mock: emptyAgg(), suppressed: emptyAgg(),
    total: emptyAgg(),
  }
  for (const r of records) {
    accumulate(out[kindOf(r)], r)
    accumulate(out.total, r)
  }
  return {
    primary: finalize(out.primary), shadow: finalize(out.shadow), fallback: finalize(out.fallback),
    mock: finalize(out.mock), suppressed: finalize(out.suppressed), total: finalize(out.total),
  }
}

// ── Cost + usage grouped by provider (anthropic / openai / …), sorted by cost.
export type ProviderStat = { provider: string } & UsageAgg
export function providerBreakdown(records: AiCallRecord[]): ProviderStat[] {
  const map = new Map<string, UsageAgg>()
  for (const r of records) {
    const provider = r.provider ?? (r.model?.includes('/') ? r.model.split('/')[0] : 'unknown')
    let a = map.get(provider)
    if (!a) { a = emptyAgg(); map.set(provider, a) }
    accumulate(a, r)
  }
  return [...map.entries()]
    .map(([provider, a]) => ({ provider, ...finalize(a) }))
    .sort((x, y) => y.costUsd - x.costUsd)
}

// ── Share of estimated cost priced with a FALLBACK rate (no published model rate).
// A high share means the cost dashboard is showing guessed figures — a signal to add
// the model to the cost table.
export function rateFallbackShare(records: AiCallRecord[]): { calls: number; fallbackCalls: number; share: number } {
  const priced = records.filter(r => reached(r.outcome) && r.model)
  const fallbackCalls = priced.filter(r => r.rateFallback === true).length
  return { calls: priced.length, fallbackCalls, share: priced.length ? Math.round((fallbackCalls / priced.length) * 1000) / 1000 : 0 }
}

// ── Per-booking join: every AI call that served a given booking, newest first. ──
export function callsForBooking(records: AiCallRecord[], bookingId: string): AiCallRecord[] {
  return records.filter(r => r.bookingId === bookingId).sort((a, b) => b.at - a.at)
}

// ── Async fetch helpers (tenant-scoped via listAiCalls) ──────────────────────

export async function getKindBreakdown(limit = 2000): Promise<KindBreakdown> {
  return kindBreakdown(await listAiCalls(limit))
}

export async function getProviderBreakdown(limit = 2000): Promise<ProviderStat[]> {
  return providerBreakdown(await listAiCalls(limit))
}

// All AI calls attributed to a booking. Bounded scan of the recent audit window
// (the audit log keeps the newest MAX_KEEP records); returns [] if none matched.
export async function getCallsForBooking(bookingId: string, limit = 2000): Promise<AiCallRecord[]> {
  if (!bookingId) return []
  return callsForBooking(await listAiCalls(limit), bookingId)
}

// A single call by id (tenant check is the caller's responsibility, mirroring the
// existing getAiCall contract). Thin passthrough so the dashboard has one import site.
export async function getCallById(id: string): Promise<AiCallRecord | null> {
  return getAiCall(id)
}
