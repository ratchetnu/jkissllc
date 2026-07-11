import { aiModel } from '../ai'

// Per-feature model routing (LLMOps Phase 2). Each AI feature can run on a different
// model without touching the feature code: the AI service asks modelForFeature() and
// passes the result to the Gateway. Resolution order:
//   1. env override  AI_MODEL_<FEATURE>  (e.g. AI_MODEL_OPS_COMMAND=anthropic/claude-haiku-4-5)
//   2. the ROUTES table below
//   3. the platform default (AI_MODEL / aiModel())
// This is where cost/latency policy lives — cheap models for high-volume, low-stakes
// features; stronger models for analysis. Empty by default (everything on the default).

const ROUTES: Record<string, string> = {
  // Examples — enable deliberately:
  // 'ops.command': 'anthropic/claude-haiku-4-5',      // high-volume palette → cheap+fast
  // 'ops.photoEstimate': 'anthropic/claude-sonnet-4-6',
}

function envKey(feature: string): string {
  return 'AI_MODEL_' + feature.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
}

export function modelForFeature(feature: string): string {
  const env = process.env[envKey(feature)]
  if (env && env.trim()) return env.trim()
  return ROUTES[feature] || aiModel()
}
