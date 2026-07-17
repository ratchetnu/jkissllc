// ─────────────────────────────────────────────────────────────────────────────
// Provider cost tables — the ONE centralized, versioned, configurable source of
// truth for estimated AI spend (LLMOps telemetry foundation).
//
// Before this module, per-1M-token rates lived in a single flat const in
// telemetry.ts (Claude-only; any other routed model silently billed at the Sonnet
// default). Cost is now a VERSIONED table: each published price sheet is a distinct
// entry, the active one is selectable, and rates are extendable via env WITHOUT a
// deploy. Every estimate can report which table version priced it and whether it
// fell back to the default rate — so the dashboard can flag guessed costs.
//
// These are documented list-price ESTIMATES for visibility only. The Vercel AI
// Gateway's provider-reported cost (costSource='actual') is always authoritative
// when present; this table is the fallback estimate when it isn't.
// ─────────────────────────────────────────────────────────────────────────────

export type ModelRate = { in: number; out: number }   // USD per 1,000,000 tokens

export type CostTable = {
  version: string          // stable id, e.g. '2026-07'
  effectiveFrom: string    // ISO date the sheet took effect (documentation)
  currency: 'USD'
  unit: 'per_1m_tokens'
  rates: Record<string, ModelRate>   // MUST include a 'default' fallback rate
}

// Published price sheets, newest LAST. Add a new entry (never mutate an old one) when
// provider list prices change, so historical estimates remain reproducible and the
// dashboard can attribute a cost to the sheet that produced it.
export const COST_TABLES: readonly CostTable[] = [
  {
    version: '2026-07',
    effectiveFrom: '2026-07-01',
    currency: 'USD',
    unit: 'per_1m_tokens',
    rates: {
      // Anthropic (the platform default family).
      'anthropic/claude-sonnet-4-6': { in: 3, out: 15 },
      'anthropic/claude-haiku-4-5': { in: 1, out: 5 },
      'anthropic/claude-opus-4-8': { in: 15, out: 75 },
      // Common alternate Gateway models — so a routing switch bills at the right rate
      // instead of silently falling back to the Sonnet default.
      'openai/gpt-4o': { in: 2.5, out: 10 },
      'openai/gpt-4o-mini': { in: 0.15, out: 0.6 },
      'openai/gpt-4.1-mini': { in: 0.4, out: 1.6 },
      'google/gemini-2.5-flash': { in: 0.3, out: 2.5 },
      // Fallback rate for any model without a published entry (Sonnet-class).
      default: { in: 3, out: 15 },
    },
  },
]

// The active price sheet. Selectable via AI_COST_TABLE_VERSION (defaults to the
// newest published sheet). An unknown version falls back to the newest — fail-soft.
export function activeCostTable(): CostTable {
  const want = (process.env.AI_COST_TABLE_VERSION ?? '').trim()
  const newest = COST_TABLES[COST_TABLES.length - 1]
  if (!want) return newest
  return COST_TABLES.find(t => t.version === want) ?? newest
}

// Optional env override layered on top of the active sheet's rates, e.g.
//   AI_COST_RATES_JSON={"openai/gpt-4o":{"in":2.5,"out":10}}
// Lets ops correct a rate or add a model between deploys. Malformed JSON is ignored.
function envRateOverrides(): Record<string, ModelRate> {
  const raw = process.env.AI_COST_RATES_JSON
  if (!raw || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, ModelRate> = {}
    for (const [model, v] of Object.entries(parsed)) {
      if (v && typeof v === 'object') {
        const rin = Number((v as Record<string, unknown>).in)
        const rout = Number((v as Record<string, unknown>).out)
        if (Number.isFinite(rin) && Number.isFinite(rout) && rin >= 0 && rout >= 0) {
          out[model] = { in: rin, out: rout }
        }
      }
    }
    return out
  } catch {
    return {}
  }
}

// The effective rate map (active sheet + env overrides). Recomputed per call — the
// maps are tiny and this keeps env changes live without a restart.
export function activeRates(): Record<string, ModelRate> {
  return { ...activeCostTable().rates, ...envRateOverrides() }
}

// Back-compat: the flat rate map telemetry.ts historically exported. Points at the
// active sheet (+ overrides) so existing importers keep working unchanged.
export const MODEL_RATES: Record<string, ModelRate> = new Proxy({} as Record<string, ModelRate>, {
  get: (_t, prop: string) => activeRates()[prop],
  has: (_t, prop: string) => prop in activeRates(),
  ownKeys: () => Reflect.ownKeys(activeRates()),
  getOwnPropertyDescriptor: (_t, prop: string) => {
    const r = activeRates()[prop]
    return r ? { configurable: true, enumerable: true, value: r } : undefined
  },
})

// True when we have a PUBLISHED rate for this exact model string (so the UI can flag
// costs that fell back to the default rate).
export function isKnownModel(model: string): boolean {
  const rates = activeRates()
  return Object.prototype.hasOwnProperty.call(rates, model) && model !== 'default'
}

export function modelRate(model: string): ModelRate {
  const rates = activeRates()
  return rates[model] ?? rates.default
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000   // 6-dp micro-dollars
}

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const r = modelRate(model)
  const usd = (Math.max(0, inputTokens) / 1_000_000) * r.in + (Math.max(0, outputTokens) / 1_000_000) * r.out
  return round6(usd)
}

export type CostEstimate = {
  usd: number
  tableVersion: string     // which published sheet priced this
  rateFallback: boolean    // true → no published rate for this model (used default)
}

// The estimate PLUS provenance: the sheet version and whether the model's rate was a
// fallback. Telemetry records this so cost dashboards can flag guessed figures.
export function estimateCostDetailed(model: string, inputTokens: number, outputTokens: number): CostEstimate {
  return {
    usd: estimateCostUsd(model, inputTokens, outputTokens),
    tableVersion: activeCostTable().version,
    rateFallback: !isKnownModel(model),
  }
}
