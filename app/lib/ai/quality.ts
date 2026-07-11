// AI Quality Evaluation (LLMOps Phase 3). Deterministic, model-free heuristics that
// score an AI response 0–100 and flag concrete problems (too long, leftover
// placeholders, empty, malformed JSON…). It runs on the hot path (fail-soft,
// read-only, never blocks a response) so every call carries a quality signal the
// Control Center can trend — and it doubles as the assertion layer for offline
// regression (golden responses must clear a threshold).
//
// Scores are intentionally simple + explainable: an operator can read the flags and
// know exactly why a response lost points. This is NOT an LLM-as-judge; it's a cheap,
// stable gate that catches the failure modes these specific prompts actually hit.

export type QualityResult = { score: number; flags: string[] }

// Placeholder/bracket leakage the draft prompts are explicitly told to avoid.
const PLACEHOLDER = /\[[^\]]+\]|\{\{[^}]+\}\}|\bTODO\b|\bXYZ\b|<[a-z_]+>/i
const wordCount = (s: string) => (s.trim().match(/\S+/g) ?? []).length
const sentenceCount = (s: string) => (s.trim().match(/[.!?](\s|$)/g) ?? []).length

function clamp(n: number): number { return Math.max(0, Math.min(100, Math.round(n))) }

// Feature-specific scorers. Each returns deductions + flags from a perfect 100.
type Scorer = (text: string) => QualityResult

const scoreMessage: Scorer = (text) => {
  const flags: string[] = []
  let score = 100
  const t = text.trim()
  if (!t) return { score: 0, flags: ['empty'] }
  const words = wordCount(t)
  if (words > 75) { score -= 30; flags.push('too_long') }        // prompt caps at ~65 words
  else if (words > 65) { score -= 12; flags.push('slightly_long') }
  if (words < 6) { score -= 25; flags.push('too_short') }
  if (PLACEHOLDER.test(t)) { score -= 40; flags.push('has_placeholder') }
  if (!/[.!?]"?\s*$|—/.test(t)) { score -= 8; flags.push('no_terminal_punctuation') }
  return { score: clamp(score), flags }
}

const scoreInsights: Scorer = (text) => {
  const flags: string[] = []
  let score = 100
  const t = text.trim()
  if (!t) return { score: 0, flags: ['empty'] }
  const words = wordCount(t)
  if (!/(^|\n)\s*[-•]/.test(t)) { score -= 20; flags.push('no_bullets') }   // prompt asks for "- " bullets
  if (words > 220) { score -= 20; flags.push('too_long') }
  if (words < 20) { score -= 25; flags.push('too_short') }
  if (PLACEHOLDER.test(t)) { score -= 30; flags.push('has_placeholder') }
  return { score: clamp(score), flags }
}

const scoreReviewReply: Scorer = (text) => {
  const flags: string[] = []
  let score = 100
  const t = text.trim()
  if (!t) return { score: 0, flags: ['empty'] }
  const sentences = sentenceCount(t)
  if (sentences > 5) { score -= 20; flags.push('too_many_sentences') }       // prompt: 2–4 sentences
  if (sentences < 1) { score -= 20; flags.push('too_few_sentences') }
  if (wordCount(t) > 110) { score -= 15; flags.push('too_long') }
  if (PLACEHOLDER.test(t)) { score -= 40; flags.push('has_placeholder') }
  return { score: clamp(score), flags }
}

// Structured features (command, photo estimate) are validated against a schema by the
// service, so their quality is binary-ish: a schema-valid response scores full marks;
// this scorer only sees text and confirms it parsed to an object.
const scoreStructured: Scorer = (text) => {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return { score: 0, flags: ['not_json'] }
  try { JSON.parse(m[0]); return { score: 100, flags: [] } }
  catch { return { score: 0, flags: ['malformed_json'] } }
}

const SCORERS: Record<string, Scorer> = {
  'ops.message': scoreMessage,
  'ops.insights': scoreInsights,
  'ops.reviewReply': scoreReviewReply,
  'ops.command': scoreStructured,
  'ops.photoEstimate': scoreStructured,
}

// Public entry — always returns a result; unknown features get a neutral score so a
// new feature never breaks scoring before its scorer is added.
export function scoreResponse(feature: string, text: string): QualityResult {
  const scorer = SCORERS[feature]
  if (!scorer) return { score: 75, flags: ['unscored_feature'] }
  try { return scorer(text ?? '') } catch { return { score: 75, flags: ['scorer_error'] } }
}
