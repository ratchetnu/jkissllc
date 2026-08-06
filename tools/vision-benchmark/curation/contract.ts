// ─────────────────────────────────────────────────────────────────────────────
// The structured analysis contract.
//
// Every role returns JSON matching one of these shapes or the call FAILS. There
// is no lenient parse and no freeform reasoning field: a model that argues its
// way to a conclusion gives a reviewer prose to re-litigate instead of data to
// check, and stored reasoning is exactly what the verifier must never see.
//
// Parsing is strict on purpose. A schema failure is a hard error, not a nudge —
// silently coercing a malformed response is how a benchmark fills with values
// nobody produced.
// ─────────────────────────────────────────────────────────────────────────────

import { JUNK_CATEGORIES, MOVING_CATEGORIES } from '../queries'
import type { DisagreementCode } from './types'
import type { ClassifierResult, LabelProposal, VerifierResult } from './consensus'

export const SCHEMA_VERSION = 2

/**
 * The ONLY categories a labeler may emit, taken from the manifest itself so the
 * two can never drift. Removing the category hint (RC2 fix 4) freed the model to
 * invent ten different free-text categories across thirteen images — `mixed_junk`,
 * `garage_clutter`, `mixed household items` — which made the labels
 * uncategorisable for any coverage metric. Inference is still the model's job;
 * the vocabulary is not.
 */
export const ALLOWED_CATEGORIES: Record<'junk_removal' | 'moving', string[]> = {
  junk_removal: JUNK_CATEGORIES.map(c => c.category),
  moving: MOVING_CATEGORIES.map(c => c.category),
}

/** One measured item. Volume is DERIVED from these, never asserted alongside them. */
export type ItemMeasurement = {
  item: string
  quantity: number
  lengthFt: number
  widthFt: number
  heightFt: number
  cubicFeet: number
}

/** Sum of quantity x l x w x h across the breakdown. */
export function derivedCubicFeet(items: ItemMeasurement[]): number {
  return items.reduce((s, i) => s + i.quantity * i.lengthFt * i.widthFt * i.heightFt, 0)
}

export type Range = { min: number; max: number }

/** Evidence discipline: what was seen, what was not, what stayed ambiguous. */
export type Evidence = {
  visibleEvidence: string[]
  missingInformation: string[]
  ambiguityFlags: string[]
}

export type LabelResponse = LabelProposal & { evidence: Evidence; itemBreakdown: ItemMeasurement[] }

// ── strict parsing ──────────────────────────────────────────────────────────

export class SchemaError extends Error {
  constructor(public readonly problems: string[]) {
    super(`schema failure: ${problems.join('; ')}`)
    this.name = 'SchemaError'
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

const num = (v: unknown, path: string, problems: string[]): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) { problems.push(`${path} is not a finite number`); return NaN }
  return v
}

const strArr = (v: unknown, path: string, problems: string[]): string[] => {
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) { problems.push(`${path} is not a string[]`); return [] }
  return v as string[]
}

const range = (v: unknown, path: string, problems: string[]): Range => {
  if (!isObj(v)) { problems.push(`${path} is not a range object`); return { min: NaN, max: NaN } }
  return { min: num(v.min, `${path}.min`, problems), max: num(v.max, `${path}.max`, problems) }
}

/** Extract the first JSON object from a response. Never repairs it. */
export function extractJson(raw: string): Record<string, unknown> {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) {
    // Include a bounded prefix: a bare "no JSON" is unactionable, and the raw
    // text is the only thing that says whether the model refused, returned
    // prose, or was truncated.
    const prefix = raw.slice(0, 160).replace(/\s+/g, ' ').trim()
    throw new SchemaError([`no JSON object in response (raw: "${prefix || '<empty>'}", len=${raw.length})`])
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1))
    if (!isObj(parsed)) throw new SchemaError(['top level is not an object'])
    return parsed
  } catch (e) {
    if (e instanceof SchemaError) throw e
    throw new SchemaError(['response is not valid JSON'])
  }
}

const LANES = ['junk_removal', 'moving', 'neither', 'ambiguous']

export function parseClassifier(raw: string): ClassifierResult {
  const o = extractJson(raw)
  const problems: string[] = []
  const lane = String(o.lane ?? '')
  if (!LANES.includes(lane)) problems.push(`lane "${lane}" not in ${LANES.join('|')}`)
  if (typeof o.operational !== 'boolean') problems.push('operational is not a boolean')
  if (typeof o.privacyRisk !== 'boolean') problems.push('privacyRisk is not a boolean')
  if (typeof o.licenseRisk !== 'boolean') problems.push('licenseRisk is not a boolean')
  const confidence = num(o.confidence, 'confidence', problems)
  if (confidence < 0 || confidence > 1) problems.push('confidence outside 0..1')
  if (problems.length) throw new SchemaError(problems)
  return {
    operational: o.operational as boolean,
    lane: lane as ClassifierResult['lane'],
    category: typeof o.category === 'string' ? o.category : null,
    privacyRisk: o.privacyRisk as boolean,
    licenseRisk: o.licenseRisk as boolean,
    confidence,
  }
}

export function parseLabel(raw: string): LabelResponse {
  const o = extractJson(raw)
  const problems: string[] = []
  const lane = String(o.lane ?? '')
  if (lane !== 'junk_removal' && lane !== 'moving') problems.push(`lane "${lane}" must be junk_removal or moving`)
  if (typeof o.category !== 'string' || !o.category) problems.push('category missing')
  else if (lane === 'junk_removal' || lane === 'moving') {
    const allowed = ALLOWED_CATEGORIES[lane]
    if (!allowed.includes(o.category)) {
      problems.push(`category "${o.category}" is not in the ${lane} manifest enum`)
    }
  }

  // Structural derivation. Prompting alone did not stop volume anchoring — one
  // range was returned for five different scenes — so the breakdown is REQUIRED
  // and the volume must follow from it arithmetically.
  const rawItems = Array.isArray(o.itemBreakdown) ? o.itemBreakdown : null
  if (!rawItems || rawItems.length === 0) problems.push('itemBreakdown is required and must be non-empty')
  const itemBreakdown: ItemMeasurement[] = (rawItems ?? []).map((raw, n) => {
    const it = isObj(raw) ? raw : {}
    const m: ItemMeasurement = {
      item: typeof it.item === 'string' ? it.item : '',
      quantity: num(it.quantity, `itemBreakdown[${n}].quantity`, problems),
      lengthFt: num(it.lengthFt, `itemBreakdown[${n}].lengthFt`, problems),
      widthFt: num(it.widthFt, `itemBreakdown[${n}].widthFt`, problems),
      heightFt: num(it.heightFt, `itemBreakdown[${n}].heightFt`, problems),
      cubicFeet: num(it.cubicFeet, `itemBreakdown[${n}].cubicFeet`, problems),
    }
    if (!m.item) problems.push(`itemBreakdown[${n}].item is missing`)
    for (const k of ['quantity', 'lengthFt', 'widthFt', 'heightFt'] as const) {
      if (m[k] <= 0) problems.push(`itemBreakdown[${n}].${k} must be > 0`)
    }
    return m
  })
  if (typeof o.difficulty !== 'string') problems.push('difficulty missing')
  const ev = isObj(o.evidence) ? o.evidence : null
  if (!ev) problems.push('evidence block missing')
  const conf = isObj(o.fieldConfidence) ? o.fieldConfidence : null
  if (!conf) problems.push('fieldConfidence missing')

  const label: LabelResponse = {
    lane: lane as LabelResponse['lane'],
    category: String(o.category ?? ''),
    visibleItems: strArr(o.visibleItems, 'visibleItems', problems),
    quantityRange: range(o.quantityRange, 'quantityRange', problems),
    volumeCubicFeet: range(o.volumeCubicFeet, 'volumeCubicFeet', problems),
    truckSpacePercent: range(o.truckSpacePercent, 'truckSpacePercent', problems),
    handlingFlags: strArr(o.handlingFlags, 'handlingFlags', problems),
    hazardousIndicators: strArr(o.hazardousIndicators, 'hazardousIndicators', problems),
    crewRange: range(o.crewRange, 'crewRange', problems),
    laborHoursRange: range(o.laborHoursRange, 'laborHoursRange', problems),
    difficulty: String(o.difficulty ?? ''),
    ambiguityNotes: typeof o.ambiguityNotes === 'string' ? o.ambiguityNotes : '',
    fieldConfidence: Object.fromEntries(
      Object.entries(conf ?? {}).filter(([, v]) => typeof v === 'number'),
    ) as Record<string, number>,
    evidence: {
      visibleEvidence: strArr(ev?.visibleEvidence, 'evidence.visibleEvidence', problems),
      missingInformation: strArr(ev?.missingInformation, 'evidence.missingInformation', problems),
      ambiguityFlags: strArr(ev?.ambiguityFlags, 'evidence.ambiguityFlags', problems),
    },
    itemBreakdown,
  }
  // A model that reasons in prose has ignored the contract.
  if ('reasoning' in o || 'explanation' in o || 'chainOfThought' in o) {
    problems.push('response contains freeform reasoning — the contract forbids it')
  }
  if (problems.length) throw new SchemaError(problems)
  return label
}

const CODES: DisagreementCode[] = [
  'wrong_lane', 'wrong_category', 'non_operational_scene', 'item_not_visible',
  'quantity_overstated', 'quantity_understated', 'volume_implausible',
  'truck_space_inconsistent', 'handling_flag_unsupported', 'access_not_visible',
  'privacy_risk', 'license_risk', 'insufficient_context', 'confidence_too_high',
]

export function parseVerifier(raw: string): VerifierResult {
  const o = extractJson(raw)
  const problems: string[] = []
  const verdict = String(o.verdict ?? '')
  if (!['approve', 'reject', 'revise', 'uncertain'].includes(verdict)) {
    problems.push(`verdict "${verdict}" not recognised`)
  }
  const codes = strArr(o.disagreements, 'disagreements', problems)
  const unknown = codes.filter(c => !CODES.includes(c as DisagreementCode))
  if (unknown.length) problems.push(`unknown disagreement codes: ${unknown.join(', ')}`)
  const confidence = num(o.confidence, 'confidence', problems)
  if (confidence < 0 || confidence > 1) problems.push('confidence outside 0..1')
  if (problems.length) throw new SchemaError(problems)
  return {
    verdict: verdict as VerifierResult['verdict'],
    disagreements: codes as DisagreementCode[],
    confidence,
  }
}

// ── prompts (versioned) ─────────────────────────────────────────────────────

const NO_PRICING = 'Never estimate, mention or imply a customer price, quote or dollar amount.'

/**
 * The business rule BOTH the labeler and the verifier must share.
 *
 * The 13-image diagnostic proved the labeler's arithmetic was exact on 13/13
 * while the verifier raised truck_space_inconsistent on 10/13 — because only
 * the labeler prompt carried the constant. A shared rule is not duplication;
 * it is the thing that makes the two roles comparable.
 */
const TRUCK_RULE =
  'BUSINESS RULE — truck capacity: the J KISS box truck holds approximately 1,000 cubic feet of ' +
  'usable cargo space. Truck-space percentage = estimatedVolumeCubicFeet / 1000 * 100. ' +
  'So 100 cu ft = 10%, 500 cu ft = 50%, 900 cu ft = 90%. ' +
  'A volume and a percentage that satisfy this relationship are CONSISTENT — never report them as inconsistent.'
const EVIDENCE_RULE =
  'Describe only what is VISIBLE. Never infer objects behind or outside the frame. ' +
  'Where evidence is weak use a wider range rather than a confident point value, ' +
  'and record what you could not determine in evidence.missingInformation.'

export const PROMPTS = {
  'curation.classifier.v1':
    'You screen candidate photographs for a junk-removal and moving benchmark dataset. ' +
    'Decide whether this image shows a REAL, operationally useful job scene. ' +
    'Reject stock product photography, showrooms, repair teardowns, recycling facilities, ' +
    'scrapyards, third-party dumpsters, demolition-only scenes, renderings and unrelated street scenes. ' +
    'Flag privacyRisk if identifiable people, readable documents, addresses or licence plates are visible. ' +
    `${NO_PRICING} Reply with JSON only: ` +
    '{"operational":boolean,"lane":"junk_removal|moving|neither|ambiguous","category":string|null,' +
    '"privacyRisk":boolean,"licenseRisk":boolean,"confidence":0..1}',

  'curation.labeler.v1':
    'You produce structured ground truth for a junk-removal and moving benchmark. ' +
    `${EVIDENCE_RULE} ${NO_PRICING} ${TRUCK_RULE} ` +
    // Anchoring guard: the diagnostic found ONE volume range ({80,120}) returned
    // for five visually different scenes. Estimating from dimensions forces the
    // number to come from the image rather than from the category name.
    'Volumes are CUBIC FEET and must be DERIVED, never chosen from a familiar range. For each ' +
    'estimate: identify the visible items, estimate how many, estimate each one\'s approximate ' +
    'length x width x height in feet, and sum them. Record the dimensional reasoning in ' +
    'evidence.visibleEvidence. If you cannot judge dimensions, WIDEN the range to express that ' +
    'uncertainty and say so in evidence.missingInformation — never fall back to a typical value ' +
    'for the category. Two different scenes should not produce identical ranges. ' +
    'Infer the category yourself from the image. You MUST choose one value from the allowed list ' +
    'supplied in the user message — never invent a category. Every volume MUST be derived from an ' +
    'itemBreakdown: for each distinct item give item, quantity, lengthFt, widthFt, heightFt and ' +
    'cubicFeet (= quantity x length x width x height). volumeCubicFeet must bracket the sum. ' +
    'Reply with JSON only: ' +
    '{"lane":"junk_removal|moving","category":string,"visibleItems":string[],' +
    '"quantityRange":{"min":number,"max":number},"volumeCubicFeet":{"min":number,"max":number},' +
    '"truckSpacePercent":{"min":number,"max":number},"handlingFlags":string[],' +
    '"hazardousIndicators":string[],"crewRange":{"min":number,"max":number},' +
    '"laborHoursRange":{"min":number,"max":number},"difficulty":string,"ambiguityNotes":string,' +
    '"fieldConfidence":{[field:string]:0..1},' +
    '"itemBreakdown":[{"item":string,"quantity":number,"lengthFt":number,"widthFt":number,' +
    '"heightFt":number,"cubicFeet":number}],' +
    '"evidence":{"visibleEvidence":string[],"missingInformation":string[],"ambiguityFlags":string[]}}',

  // The verifier receives the image and the PROPOSED LABEL ONLY. It never sees
  // how the labeler arrived at anything, so agreement cannot be manufactured by
  // a persuasive argument.
  'curation.verifier.v1':
    'You independently check a proposed structured label against the image. ' +
    'You did NOT write the label and you have no access to the labeller\'s reasoning. ' +
    `Judge the image yourself first, then compare. ${TRUCK_RULE} ` +
    'Raise truck_space_inconsistent ONLY when the percentage does not follow from the stated ' +
    'volume by that rule — never merely because you would have estimated a different volume. ' +
    'If you disagree about the volume itself, use volume_implausible. ' +
    `Report disagreement with CODES ONLY, never prose. ${NO_PRICING} Reply with JSON only: ` +
    '{"verdict":"approve|reject|revise|uncertain","disagreements":string[],"confidence":0..1}. ' +
    `Valid codes: ${CODES.join(', ')}.`,

  'curation.adjudicator.v1':
    'Two independent reviewers disagree about a proposed label for this image. ' +
    'You see the image and both structured positions, but neither reviewer\'s reasoning. ' +
    `${TRUCK_RULE} Decide which position the image supports, or that neither does. ${NO_PRICING} ` +
    'Reply with JSON only: {"verdict":"approve|reject|revise|uncertain","disagreements":string[],"confidence":0..1}',
} as const

export type PromptVersion = keyof typeof PROMPTS
