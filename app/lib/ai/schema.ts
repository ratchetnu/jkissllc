// Dependency-free structured-response validation (LLMOps Phase 1). LLM output is
// untrusted: the AI service parses the model's JSON and validates it against a
// declared schema before any consumer sees it. An invalid response is REJECTED
// (never passed through), which is what keeps the Operations AI read-only/draft-only
// and immune to malformed or hallucinated payloads.
//
// A minimal validator (no new dependency): field types, optionality, string length
// caps, and an "at least one of" rule. Unknown keys are dropped from the result.

export type FieldSpec = { type: 'string' | 'number' | 'boolean'; optional?: boolean; maxLen?: number }
export type ObjectSchema = { fields: Record<string, FieldSpec>; atLeastOneOf?: string[] }

export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string }

// Pull the first {...} block even if the model wrapped it in prose/fences.
function extractJson(text: string): unknown | undefined {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return undefined
  try { return JSON.parse(m[0]) } catch { return undefined }
}

export function validateJson(text: string, schema: ObjectSchema): ValidationResult {
  const raw = extractJson(text)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'response was not a JSON object' }
  }
  const obj = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}

  for (const [key, spec] of Object.entries(schema.fields)) {
    const v = obj[key]
    if (v === undefined || v === null) {
      if (spec.optional) continue
      return { ok: false, error: `missing required field: ${key}` }
    }
    if (spec.type === 'string') {
      if (typeof v !== 'string') return { ok: false, error: `field ${key} must be a string` }
      out[key] = spec.maxLen ? v.slice(0, spec.maxLen) : v
    } else if (spec.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, error: `field ${key} must be a number` }
      out[key] = v
    } else if (spec.type === 'boolean') {
      if (typeof v !== 'boolean') return { ok: false, error: `field ${key} must be a boolean` }
      out[key] = v
    }
  }

  if (schema.atLeastOneOf && schema.atLeastOneOf.length) {
    const present = schema.atLeastOneOf.some(k => {
      const v = out[k]
      return v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '')
    })
    if (!present) return { ok: false, error: `at least one of [${schema.atLeastOneOf.join(', ')}] is required` }
  }

  return { ok: true, value: out }
}

// ── Task schemas ─────────────────────────────────────────────────────────────
// The command palette answers with EITHER a target id to navigate to OR a short
// answer — exactly one is enough, both are optional individually.
export const COMMAND_SCHEMA: ObjectSchema = {
  fields: {
    targetId: { type: 'string', optional: true, maxLen: 200 },
    answer: { type: 'string', optional: true, maxLen: 600 },
  },
  atLeastOneOf: ['targetId', 'answer'],
}

// The public photo-estimate returns a load size + price range + one-line summary.
// All four are required; the "can't haul this" case still returns numbers (0/0) with
// an explanatory summary. Validating here (AUDIT-F1) means a malformed model response
// is recorded as invalid_response — not silently logged as success.
export const ESTIMATE_SCHEMA: ObjectSchema = {
  fields: {
    loadSize: { type: 'string', maxLen: 60 },
    low: { type: 'number' },
    high: { type: 'number' },
    summary: { type: 'string', maxLen: 200 },
  },
}
