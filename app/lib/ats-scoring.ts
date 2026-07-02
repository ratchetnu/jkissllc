// ── Applicant Readiness Score (0–100) — deterministic scoring engine ──────────
// Pure functions, no I/O. Turns a submitted application into a score, a band, a
// rubric on the scenario answers, strengths / weaknesses / risk factors, and a
// set of suggested interview questions targeted at the applicant's gaps.
//
// Everything here is rule-based so it works with zero external dependencies (no
// AI credits required). An optional AI pass can enrich this later; the numbers
// stand on their own.

import {
  ASSESSMENT, EXPERIENCE_LEVELS, RUBRIC_DIMENSIONS, SCENARIOS, bandFor, requiredDocKinds,
} from './ats-config'
import type { DocKind, ExperienceLevel, Position, RubricDimension, ScoreBand } from './ats-config'

export type SkillRating = { level: ExperienceLevel; confidence: number }
export type ScenarioResponse = { key: string; answer: string }

export type ScoreInput = {
  position: Position
  skills: Record<string, Record<string, SkillRating>> // categoryKey -> questionKey -> rating
  scenarios: ScenarioResponse[]
  documents: { kind: DocKind }[]
  eligibility: {
    age21plus?: boolean
    reliableTransport?: boolean
    canOperateBoxTruck?: boolean
    canLiftHeavy?: boolean
    smartphone?: boolean
  }
  availability?: { start?: string; days?: string[]; notes?: string }
  experienceSummary?: string
}

export type ScoreComponent = { key: string; label: string; points: number; max: number }
export type ScenarioRubric = Record<RubricDimension, number> // 0..1 averages
export type ScoreResult = {
  score: number
  band: ScoreBand
  components: ScoreComponent[]
  strengths: string[]
  weaknesses: string[]
  riskFactors: string[]
  suggestedQuestions: string[]
  scenarioRubric: ScenarioRubric
  documentsComplete: boolean
  missingDocs: DocKind[]
}

// ── Component weights (sum to 100 per position) ───────────────────────────────
const WEIGHTS: Record<Position, Record<string, number>> = {
  driver: { documents: 15, furniture: 12, appliance: 18, moving: 12, junk: 5, driving: 13, availability: 5, scenarios: 12, communication: 4, professionalism: 4 },
  helper: { documents: 15, furniture: 16, appliance: 18, moving: 16, junk: 8, availability: 6, scenarios: 14, communication: 4, professionalism: 3 },
}

const LEVEL_WEIGHT: Record<ExperienceLevel, number> = Object.fromEntries(
  EXPERIENCE_LEVELS.map(l => [l.value, l.weight]),
) as Record<ExperienceLevel, number>

const CATEGORY_TITLE: Record<string, string> = Object.fromEntries(ASSESSMENT.map(c => [c.key, c.title]))

// ── Helpers ───────────────────────────────────────────────────────────────────
function clamp01(n: number): number { return Math.max(0, Math.min(1, n)) }

function ratingOf(skills: ScoreInput['skills'], cat: string, q: string): SkillRating {
  const r = skills?.[cat]?.[q]
  if (!r) return { level: 'none', confidence: 1 }
  const level = (EXPERIENCE_LEVELS.some(l => l.value === r.level) ? r.level : 'none') as ExperienceLevel
  const confidence = Math.max(1, Math.min(10, Number(r.confidence) || 1))
  return { level, confidence }
}

function questionScore(r: SkillRating): number {
  // experience level drives the score; confidence nudges it ±40%.
  return clamp01(LEVEL_WEIGHT[r.level] * (0.6 + 0.4 * (r.confidence / 10)))
}

// 0..1 for a whole assessment category (average of its questions).
function categoryScore(input: ScoreInput, catKey: string): number {
  const cat = ASSESSMENT.find(c => c.key === catKey)
  if (!cat || !cat.positions.includes(input.position)) return 0
  const scores = cat.questions.map(q => questionScore(ratingOf(input.skills, catKey, q.key)))
  if (!scores.length) return 0
  return scores.reduce((a, b) => a + b, 0) / scores.length
}

function words(s?: string): number { return (s || '').trim().split(/\s+/).filter(Boolean).length }

// ── Scenario rubric (keyword + effort heuristic, deterministic) ───────────────
const RUBRIC_KEYWORDS: Record<RubricDimension, string[]> = {
  safety: ['safe', 'safety', 'team lift', 'two people', 'ppe', 'secure', 'strap', 'buddy', 'proper', 'back', 'injur', 'careful', 'protect', 'stop work', 'stop the', 'hazard', 'lift with', 'brace'],
  customerService: ['customer', 'communicat', 'apolog', 'explain', 'update', 'call', 'let them know', 'polite', 'patient', 'reassur', 'satisf', 'listen', 'calm them', 'keep them informed'],
  problemSolving: ['measure', 'remove the door', 'take the door', 'alternative', 'option', 'disassemb', 'reroute', 'plan', 'assess', 'solution', 'tool', 'angle', 'another way', 'second truck', 'come back', 'reschedule'],
  honesty: ['honest', 'tell the', 'inform', 'report', 'admit', 'document', 'notify', 'disclose', 'truth', 'let the office', 'let the manager', 'take a photo', 'own it', 'accept responsibility'],
  professionalism: ['professional', 'respect', 'calm', 'policy', 'procedure', 'scope', 'authoriz', 'approv', 'on time', 'uniform', 'dispatch', 'manager', 'office', 'follow up'],
}

function scoreOneScenario(answer: string): ScenarioRubric {
  const text = (answer || '').toLowerCase()
  const w = words(answer)
  // effort base: longer, thought-out answers earn a higher floor.
  const base = w >= 30 ? 0.42 : w >= 15 ? 0.28 : w >= 6 ? 0.12 : 0
  const out = {} as ScenarioRubric
  for (const dim of RUBRIC_DIMENSIONS) {
    const hits = RUBRIC_KEYWORDS[dim].reduce((n, kw) => (text.includes(kw) ? n + 1 : n), 0)
    out[dim] = clamp01(base + hits * 0.16)
  }
  return out
}

function scenarioRubric(input: ScoreInput): { rubric: ScenarioRubric; answeredCount: number; avgWords: number } {
  const answered = input.scenarios.filter(s => words(s.answer) >= 3)
  const empty = { safety: 0, customerService: 0, problemSolving: 0, honesty: 0, professionalism: 0 } as ScenarioRubric
  if (!answered.length) return { rubric: empty, answeredCount: 0, avgWords: 0 }
  const sums = { ...empty }
  for (const s of answered) {
    const r = scoreOneScenario(s.answer)
    for (const dim of RUBRIC_DIMENSIONS) sums[dim] += r[dim]
  }
  for (const dim of RUBRIC_DIMENSIONS) sums[dim] = sums[dim] / answered.length
  const avgWords = answered.reduce((a, s) => a + words(s.answer), 0) / answered.length
  return { rubric: sums, answeredCount: answered.length, avgWords }
}

// ── Free-text quality (communication & professionalism) ───────────────────────
function freeTextBlob(input: ScoreInput): string {
  return [input.experienceSummary, ...input.scenarios.map(s => s.answer)].filter(Boolean).join(' ')
}

function communicationScore(input: ScoreInput): number {
  const blob = freeTextBlob(input)
  const w = words(blob)
  const lengthScore = clamp01(w / 120)
  const hasPunct = /[.!?]/.test(blob) ? 1 : 0.5
  const hasCase = /[a-z]/.test(blob) && /[A-Z]/.test(blob) ? 1 : 0.6
  return clamp01(0.7 * lengthScore + 0.15 * hasPunct + 0.15 * hasCase)
}

function professionalismScore(input: ScoreInput): number {
  const blob = freeTextBlob(input)
  const w = words(blob)
  if (!w) return 0
  const lengthScore = clamp01(w / 100)
  const letters = blob.replace(/[^a-zA-Z]/g, '')
  const upper = blob.replace(/[^A-Z]/g, '').length
  const allCapsPenalty = letters.length > 20 && upper / letters.length > 0.6 ? 0.4 : 0 // shouting
  const courteous = /(thank|please|apolog|respect|professional|understand|safe)/i.test(blob) ? 0.15 : 0
  return clamp01(0.7 * lengthScore + 0.15 + courteous - allCapsPenalty)
}

function availabilityScore(input: ScoreInput): number {
  const a = input.availability
  if (!a) return 0
  let s = 0
  if (a.start && a.start.trim()) s += 0.3
  s += clamp01((a.days?.length || 0) / 5) * 0.6
  if (a.notes && /(weekend|flexible|any|open|asap|immediately)/i.test(a.notes)) s += 0.15
  return clamp01(s)
}

// ── Main entry ────────────────────────────────────────────────────────────────
export function scoreApplicant(input: ScoreInput): ScoreResult {
  const w = WEIGHTS[input.position]
  const isDriver = input.position === 'driver'

  // documents
  const required = requiredDocKinds(input.position)
  const present = new Set(input.documents.map(d => d.kind))
  const missingDocs = required.filter(k => !present.has(k))
  const docsFrac = required.length ? (required.length - missingDocs.length) / required.length : 1
  const documentsComplete = missingDocs.length === 0

  // category scores
  const cat = {
    furniture: categoryScore(input, 'furniture'),
    appliance: categoryScore(input, 'appliance'),
    moving: categoryScore(input, 'moving'),
    junk: categoryScore(input, 'junk'),
    driving: isDriver ? categoryScore(input, 'driving') : 0,
  }

  const scn = scenarioRubric(input)
  const scenarioAvg = RUBRIC_DIMENSIONS.reduce((a, d) => a + scn.rubric[d], 0) / RUBRIC_DIMENSIONS.length
  const comm = communicationScore(input)
  const prof = professionalismScore(input)
  const avail = availabilityScore(input)

  const components: ScoreComponent[] = [
    { key: 'documents', label: 'Required documents', points: docsFrac * w.documents, max: w.documents },
    { key: 'furniture', label: 'Furniture delivery experience', points: cat.furniture * w.furniture, max: w.furniture },
    { key: 'appliance', label: 'Appliance installation experience', points: cat.appliance * w.appliance, max: w.appliance },
    { key: 'moving', label: 'Moving experience', points: cat.moving * w.moving, max: w.moving },
    { key: 'junk', label: 'Junk removal experience', points: cat.junk * w.junk, max: w.junk },
    ...(isDriver ? [{ key: 'driving', label: 'Driving experience', points: cat.driving * w.driving, max: w.driving }] : []),
    { key: 'availability', label: 'Availability', points: avail * w.availability, max: w.availability },
    { key: 'scenarios', label: 'Scenario responses', points: scenarioAvg * w.scenarios, max: w.scenarios },
    { key: 'communication', label: 'Communication quality', points: comm * w.communication, max: w.communication },
    { key: 'professionalism', label: 'Professionalism', points: prof * w.professionalism, max: w.professionalism },
  ]

  const raw = components.reduce((a, c) => a + c.points, 0)
  const score = Math.round(clamp01(raw / 100) * 100)
  const band = bandFor(score)

  return {
    score,
    band,
    components: components.map(c => ({ ...c, points: Math.round(c.points * 10) / 10 })),
    scenarioRubric: scn.rubric,
    documentsComplete,
    missingDocs,
    ...analyze(input, cat, scn, { documentsComplete, missingDocs, isDriver }),
  }
}

// ── Strengths / weaknesses / risk factors / interview questions ───────────────
function analyze(
  input: ScoreInput,
  cat: Record<string, number>,
  scn: { rubric: ScenarioRubric; answeredCount: number; avgWords: number },
  meta: { documentsComplete: boolean; missingDocs: DocKind[]; isDriver: boolean },
): { strengths: string[]; weaknesses: string[]; riskFactors: string[]; suggestedQuestions: string[] } {
  const strengths: string[] = []
  const weaknesses: string[] = []
  const riskFactors: string[] = []
  const suggestedQuestions: string[] = []
  const lvl = (c: string, q: string) => ratingOf(input.skills, c, q).level

  // strengths — strong categories + standout skills
  for (const key of ['appliance', 'furniture', 'moving', 'junk', ...(meta.isDriver ? ['driving'] : [])]) {
    if (cat[key] >= 0.7) strengths.push(`Strong ${CATEGORY_TITLE[key].toLowerCase()} experience`)
  }
  if (lvl('appliance', 'washer') === '3plus' || lvl('appliance', 'washer') === '1to3yr') strengths.push('Experienced with washer installations')
  if (meta.isDriver && (lvl('driving', 'box_truck_26') === '3plus' || lvl('driving', 'box_truck_26') === '1to3yr')) strengths.push("Experienced 26' box-truck driver")
  if (meta.documentsComplete) strengths.push('All required documents uploaded')
  if (scn.answeredCount >= SCENARIOS.length && scn.avgWords >= 25) strengths.push('Thorough, thoughtful scenario answers')

  // weaknesses — thin categories + adjacency gaps (drives interview questions)
  for (const key of ['appliance', 'furniture', 'moving', 'junk', ...(meta.isDriver ? ['driving'] : [])]) {
    if (cat[key] > 0 && cat[key] < 0.35) weaknesses.push(`Limited ${CATEGORY_TITLE[key].toLowerCase()} experience`)
    if (cat[key] === 0) weaknesses.push(`No ${CATEGORY_TITLE[key].toLowerCase()} experience`)
  }
  // appliance adjacency: has appliance experience but a specific install is missing
  if (cat.appliance >= 0.3) {
    if (lvl('appliance', 'washer') === 'none') {
      weaknesses.push('Appliance experience, but no washer-installation experience')
      suggestedQuestions.push('Walk me through how you install a washing machine from start to finish.')
    }
    if (lvl('appliance', 'dishwasher') === 'none') {
      suggestedQuestions.push("Describe how you'd install a dishwasher and check it for leaks.")
    }
    if (lvl('appliance', 'refrigerator') === 'none') {
      suggestedQuestions.push('How do you safely move and set up a refrigerator, including the water line?')
    }
  }
  // driving gaps
  if (meta.isDriver) {
    if (lvl('driving', 'box_truck_26') === 'none') suggestedQuestions.push("Tell me about your experience driving a 26' box truck and backing into tight spots.")
    if (lvl('driving', 'dot_knowledge') === 'none' || lvl('driving', 'daily_inspections') === 'none') suggestedQuestions.push('Walk me through a DOT pre-trip / daily vehicle inspection.')
    if (lvl('driving', 'liftgate') === 'none') suggestedQuestions.push('Have you operated a liftgate? Describe how you load a heavy appliance with one.')
  }
  // moving adjacency
  if (cat.furniture >= 0.3 && lvl('moving', 'stair_carries') === 'none') {
    weaknesses.push('Furniture experience, but no stair-carry experience')
    suggestedQuestions.push('How do you safely carry heavy furniture up several flights of stairs?')
  }
  if (cat.junk < 0.3) suggestedQuestions.push("Have you done cleanouts or debris hauling? Tell me about the heaviest job you've handled.")

  // scenario-driven interview questions
  if (scn.rubric.safety < 0.4) suggestedQuestions.push('Give me an example of a time you stopped a job because something was unsafe.')
  if (scn.rubric.customerService < 0.4) suggestedQuestions.push('Tell me about a time you turned an upset customer around.')

  // risk factors — eligibility, docs, effort
  if (meta.isDriver && input.eligibility.age21plus === false) riskFactors.push('Under 21 — below driver policy')
  if (input.eligibility.reliableTransport === false) riskFactors.push('No reliable transportation')
  if (meta.isDriver && input.eligibility.canOperateBoxTruck === false) riskFactors.push("Cannot yet safely operate a 26' box truck")
  if (input.eligibility.canLiftHeavy === false) riskFactors.push('Unsure about the lifting requirement')
  if (input.eligibility.smartphone === false) riskFactors.push('No smartphone with data')
  if (meta.missingDocs.length) riskFactors.push(`Missing required documents (${meta.missingDocs.length})`)
  if (scn.answeredCount < Math.ceil(SCENARIOS.length / 2)) riskFactors.push('Left most scenario questions blank')
  else if (scn.avgWords < 8) riskFactors.push('Very short, low-effort scenario answers')
  if (availabilityScore(input) < 0.2) riskFactors.push('Little or no availability provided')

  // de-dupe + cap the interview list
  const dq = Array.from(new Set(suggestedQuestions)).slice(0, 6)
  return { strengths, weaknesses, riskFactors, suggestedQuestions: dq }
}
