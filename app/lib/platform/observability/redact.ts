// ── Sensitive-data redaction ─────────────────────────────────────────────────
//
// Structured logs must never carry secrets or raw PII. Redaction runs on every
// log call (logger.ts): it masks values under sensitive KEYS and masks values
// that LOOK like credentials/PII regardless of key. Deterministic and dependency-
// free. Tested by scripts/observability.test.ts.

const SENSITIVE_KEY = /(secret|token|password|passwd|authorization|auth|api[_-]?key|ssn|tin|cookie|session|private[_-]?key|card|cvv)/i

const PATTERNS: { re: RegExp; label: string }[] = [
  { re: /Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/g, label: '[REDACTED:bearer]' },
  { re: /\b[a-f0-9]{32,}\b/gi, label: '[REDACTED:hex]' }, // long hex tokens/uuids-without-dashes
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, label: '[REDACTED:email]' },
  { re: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, label: '[REDACTED:phone]' },
  { re: /\b\d{3}-\d{2}-\d{4}\b/g, label: '[REDACTED:ssn]' },
]

const MASK = '[REDACTED]'

export function redactString(s: string): string {
  let out = s
  for (const { re, label } of PATTERNS) out = out.replace(re, label)
  return out
}

export function redactValue(key: string, value: unknown, seen = new WeakSet<object>()): unknown {
  if (SENSITIVE_KEY.test(key)) return MASK
  if (typeof value === 'string') return redactString(value)
  if (value && typeof value === 'object') {
    if (seen.has(value as object)) return '[Circular]'
    seen.add(value as object)
    if (Array.isArray(value)) return value.map((v) => redactValue('', v, seen))
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactValue(k, v, seen)
    return out
  }
  return value
}

export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  return redactValue('', fields, new WeakSet()) as Record<string, unknown>
}
