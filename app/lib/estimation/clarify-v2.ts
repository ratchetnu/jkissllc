// ── V2 customer clarification engine (Phase 11) ───────────────────────────────
//
// At the END of AI analysis, turn what the model COULDN'T resolve into a SMALL set
// of SPECIFIC, price-moving questions for the customer — the ones we actually need
// answered to produce an accurate quote. Owner's intent (verbatim): "how many of
// these are in the photo?", "about how much does this weigh?", "is this a [X or Y]?",
// "I couldn't make out what this is — what is it?". Targeted, not a wall of questions.
//
// Two sources are MERGED and de-duplicated:
//   (a) the model's own `v2.recommendedCustomerQuestions` — already aimed at what it
//       failed to resolve, and
//   (b) DETERMINISTIC questions derived from concrete analysis signals (wide quantity
//       ranges, low confidence, ambiguous material, unidentified items, unknown access,
//       likely-hidden volume, hazardous flags).
// Deterministic questions win on overlap because they carry a targetObjectId + an
// auditable reason. We PRIORITIZE (hazard + quantity first, by price impact) and CAP.
//
// We REUSE the governed follow-up catalog (lib/ai/followup-questions) for wording where
// it already has a matching question (hazardous, hidden items), so clarifications stay
// single-sourced with the rest of intake. Custom wording only where the catalog has no
// equivalent (e.g. a per-object "about how many …" or a single combined access question).
//
// `applyAnswersV2` is a PURE, immutable helper that folds customer answers back into the
// analysis where the mapping is deterministic (a numeric quantity answer tightens an
// object's quantity/min/max; a yes/no access answer resolves the 'unknown' access fields;
// a hazard "yes" routes to manual review). The deterministic estimation engine can then
// re-run over the improved analysis — only the affected calc needs to change, because the
// inputs it reads (unifiedInventory quantities, accessAssessment, disposalAssessment) are
// exactly what these answers update. Unparseable answers are IGNORED — we never fabricate.
//
// Pure + dependency-free (no I/O, no Date.now/random) so selection is deterministic and
// unit-testable. The model NEVER prices; this only shapes the inputs the engine reads.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  JunkPhotoAnalysisV2,
  UnifiedObject,
  WeightClass,
} from '../ai/analysis-schema-v2'
import { QUESTION_CATALOG } from '../ai/followup-questions'

export type ClarificationKind =
  | 'quantity'
  | 'weight'
  | 'material'
  | 'unidentified'
  | 'access'
  | 'hidden'
  | 'hazard'

export type PriceImpact = 'high' | 'medium' | 'low'

export type ClarificationV2 = {
  id: string
  question: string
  reason: string
  kind: ClarificationKind
  targetObjectId?: string
  priceImpact: PriceImpact
}

export type ClarifyV2Options = {
  /** Cap on how many questions we surface. Default 4 — a rough estimate should proceed. */
  max?: number
}

const DEFAULT_MAX = 4

// Pull governed catalog wording so clarifications stay single-sourced with intake.
function catalogPrompt(id: string): string | undefined {
  return QUESTION_CATALOG[id]?.prompt
}

// Human label for an object, grounded in the model's own description/category.
function label(o: UnifiedObject): string {
  const d = (o.description || '').trim()
  if (d) return d
  const c = (o.category || '').trim()
  return c && c !== 'unknown' ? c : 'item'
}

const UNKNOWN_DESC = /\b(unknown|unidentif|unclear|can'?t tell|couldn'?t tell|not sure|unsure|mystery|indistinct)\b/i

function isUnidentified(o: UnifiedObject): boolean {
  return UNKNOWN_DESC.test(o.description || '') || (o.category || '').toLowerCase() === 'unknown'
}

// Bulky/heavy ⇒ quantity swings the quote a lot (truck space + crew + disposal weight).
function isHeavyOrBulky(o: UnifiedObject): boolean {
  if (o.weightClass === 'heavy' || o.weightClass === 'very_heavy') return true
  if ((o.estimatedVolumeCubicFeetHigh ?? 0) >= 20) return true
  return o.specialHandling.some((h) => /lift|2-?person|oversiz|disassembl|heavy/i.test(h))
}

function hasWideQuantityRange(o: UnifiedObject): boolean {
  const spread = o.maxQuantity - o.minQuantity
  if (spread >= 2) return true
  const ratio = o.maxQuantity / Math.max(o.minQuantity, 1)
  return ratio >= 1.5
}

// A dense material where solid-vs-light genuinely changes handling & disposal cost.
function isDenseDisposal(o: UnifiedObject): boolean {
  return o.disposalClass === 'construction' || /concrete|brick|tile|stone|dirt|masonry/i.test(label(o))
}

// Best-effort: link a per-image item (which carries `material`) to a unified object.
function matchUnifiedByName(name: string, unified: UnifiedObject[]): UnifiedObject | undefined {
  const words = name.toLowerCase().split(/\W+/).filter((w) => w.length >= 4)
  if (!words.length) return undefined
  return unified.find((o) => {
    const hay = `${o.description} ${o.category}`.toLowerCase()
    return words.some((w) => hay.includes(w))
  })
}

// The job is worth asking access/logistics questions about (skip on tiny 1-item hauls).
function isNonTrivialJob(v2: JunkPhotoAnalysisV2): boolean {
  const inv = v2.unifiedInventory
  if (inv.length >= 2) return true
  const totalQty = inv.reduce((n, o) => n + (o.quantity || 0), 0)
  if (totalQty >= 3) return true
  if (inv.some(isHeavyOrBulky)) return true
  if (v2.laborAssessment.estimatedCrewSize > 2) return true
  if (v2.accessAssessment.multipleRoomsOrAreas) return true
  return false
}

function volumeLooksWide(v2: JunkPhotoAnalysisV2): boolean {
  const vh = v2.volumeHint
  if (vh.likelyCubicYards && vh.maxCubicYards && vh.maxCubicYards / Math.max(vh.likelyCubicYards, 0.1) >= 1.4) {
    return true
  }
  return v2.unifiedInventory.some((o) => {
    const lo = o.estimatedVolumeCubicFeetLow ?? 0
    const hi = o.estimatedVolumeCubicFeetHigh ?? 0
    return hi > 0 && lo > 0 && hi / lo >= 1.5
  })
}

// ── Kind inference for the model's own recommended questions ──────────────────
function inferKind(q: string): ClarificationKind {
  const t = q.toLowerCase()
  if (/weigh|how heavy|too heavy|lift|pounds|\blbs?\b/.test(t)) return 'weight'
  if (/paint|chemical|fuel|refrigerant|hazard|flammable|batter|propane|solvent/.test(t)) return 'hazard'
  if (/how many|number of|\bquantity\b|\bcount\b|how much (junk|stuff|is there)/.test(t)) return 'quantity'
  if (/solid wood|particleboard|particle board|made of|what material|metal or|plastic or/.test(t)) return 'material'
  if (/stair|elevator|\bpark\b|parking|ground.?floor|long carry|\bcarry\b|driveway|access/.test(t)) return 'access'
  if (/behind|underneath|hidden|more (items|junk|stuff)|inside the pile|under the pile/.test(t)) return 'hidden'
  if (/what is (this|it)|identif|make out|couldn'?t tell|can'?t tell|unclear|what kind of/.test(t)) return 'unidentified'
  return 'unidentified'
}

// Default price impact for a model-sourced question keyed by its inferred kind.
function defaultImpact(kind: ClarificationKind): PriceImpact {
  switch (kind) {
    case 'hazard':
    case 'quantity':
    case 'weight':
      return 'high'
    case 'material':
    case 'unidentified':
    case 'hidden':
      return 'medium'
    case 'access':
      return 'low'
  }
}

// ── Prioritization ranks ──────────────────────────────────────────────────────
const IMPACT_RANK: Record<PriceImpact, number> = { high: 0, medium: 1, low: 2 }
// hazard (safety) and quantity (biggest quote mover) first.
const KIND_RANK: Record<ClarificationKind, number> = {
  hazard: 0,
  quantity: 1,
  unidentified: 2,
  weight: 3,
  material: 4,
  hidden: 5,
  access: 6,
}

/**
 * Generate the targeted customer clarifications for a V2 analysis. Merges the model's
 * own recommended questions with deterministic signal-derived questions, de-duplicates
 * by meaning, prioritizes (hazard + quantity first, by price impact), and caps at
 * `max` (default 4). Returns [] when nothing material is uncertain.
 */
export function clarificationsForV2(
  v2: JunkPhotoAnalysisV2,
  opts?: ClarifyV2Options,
): ClarificationV2[] {
  const max = Math.max(1, Math.round(opts?.max ?? DEFAULT_MAX))
  const det: ClarificationV2[] = []
  const kindsSeen = new Set<string>() // meaning keys already covered deterministically

  const inv = v2.unifiedInventory
  const perImage = v2.perImageObservations

  // 1) HAZARD — safety-critical, always surface when flagged (highest priority).
  const hazardFlagged =
    v2.disposalAssessment.hazardousPossible ||
    v2.disposalAssessment.surchargeItems.some((x) => /hazard|paint|chemical|fuel|refrigerant|battery/i.test(x)) ||
    inv.some((o) => o.disposalClass === 'hazardous') ||
    perImage.some((p) => p.hazardousConcern || p.paintOrChemical)
  if (hazardFlagged) {
    det.push({
      id: 'q_hazard',
      // Reuse catalog wording, extended with refrigerant (surcharge-relevant here).
      question: catalogPrompt('hazardous') ?? 'Do any items contain paint, chemicals, fuel, or refrigerant?',
      reason: 'Possible hazardous/special-disposal material flagged — safety + surcharge; must confirm before quoting.',
      kind: 'hazard',
      priceImpact: 'high',
    })
    kindsSeen.add('hazard')
  }

  // 2) QUANTITY — one per object whose count materially swings the quote.
  for (const o of inv) {
    if (isUnidentified(o)) continue // identity is the blocker, not the count → handled below
    const wide = hasWideQuantityRange(o)
    const lowCount = o.confidence === 'low'
    if (!wide && !lowCount) continue
    const heavy = isHeavyOrBulky(o)
    det.push({
      id: `q_quantity_${o.objectId}`,
      question: `About how many ${label(o)} are there?`,
      reason: wide
        ? `Quantity of "${label(o)}" is a range (${o.minQuantity}–${o.maxQuantity}); exact count drives truck space${heavy ? ' and disposal weight' : ''}.`
        : `Low count confidence on "${label(o)}" — exact count drives truck space${heavy ? ' and disposal weight' : ''}.`,
      kind: 'quantity',
      targetObjectId: o.objectId,
      priceImpact: heavy ? 'high' : 'medium',
    })
    kindsSeen.add('quantity')
  }

  // 3) WEIGHT — heavy/dense objects where weight drives disposal cost and we're unsure.
  for (const o of inv) {
    if (isUnidentified(o)) continue
    const heavyUnsure = (o.weightClass === 'heavy' || o.weightClass === 'very_heavy') && o.confidence !== 'high'
    const dense = isDenseDisposal(o)
    if (!heavyUnsure && !dense) continue
    det.push({
      id: `q_weight_${o.objectId}`,
      question: `Roughly how heavy is the ${label(o)} — can two people lift it, or is it very heavy?`,
      reason: dense
        ? `"${label(o)}" reads as dense/construction material — weight sets disposal cost and crew size.`
        : `Weight of "${label(o)}" (${o.weightClass}) is uncertain — it drives disposal cost and crew size.`,
      kind: 'weight',
      targetObjectId: o.objectId,
      priceImpact: dense || o.weightClass === 'very_heavy' ? 'high' : 'medium',
    })
    kindsSeen.add('weight')
  }

  // 4) MATERIAL — bulky items where solid-wood vs particleboard/plastic changes handling.
  //    per-image items carry `material`; link back to a unified object where possible.
  const materialAskedFor = new Set<string>()
  for (const p of perImage) {
    for (const it of p.items) {
      const ambiguous = (it.material === 'mixed' || it.material === 'unknown') && it.bulky
      if (!ambiguous) continue
      const target = matchUnifiedByName(it.name, inv)
      const key = target?.objectId ?? it.name.toLowerCase()
      if (materialAskedFor.has(key)) continue
      materialAskedFor.add(key)
      const name = target ? label(target) : it.name || 'item'
      det.push({
        id: target ? `q_material_${target.objectId}` : `q_material_${key.replace(/\W+/g, '_')}`,
        question: `Is the ${name} solid wood/metal, or lighter (particleboard/plastic)?`,
        reason: `Material of "${name}" is ambiguous (${it.material}) on a bulky item — solid vs. light changes weight, handling, and disposal.`,
        kind: 'material',
        targetObjectId: target?.objectId,
        priceImpact: 'medium',
      })
      kindsSeen.add('material')
    }
  }

  // 5) UNIDENTIFIED — one combined question for an item the model couldn't make out.
  const unidObj = inv.find(isUnidentified)
  const unidNote = perImage
    .flatMap((p) => p.uncertainObservations)
    .find((o) => UNKNOWN_DESC.test(o) || /what is|make out|identif/i.test(o))
  if (unidObj || unidNote) {
    const hint = unidObj ? label(unidObj) : undefined
    det.push({
      id: 'q_unidentified',
      question:
        hint && hint !== 'item'
          ? `We couldn't clearly identify the ${hint} — what is it? (e.g. appliance, furniture, debris)`
          : "We couldn't clearly identify one item — what is it? (e.g. appliance, furniture, debris)",
      reason: unidNote
        ? `Model uncertainty: "${unidNote.slice(0, 120)}" — identity is needed before it can be sized/priced.`
        : 'An inventory object could not be identified — identity is needed before it can be sized/priced.',
      kind: 'unidentified',
      targetObjectId: unidObj?.objectId,
      priceImpact: 'medium',
    })
    kindsSeen.add('unidentified')
  }

  // 6) HIDDEN — loose/bagged debris where volume behind/under the pile is likely.
  const looseOrBagged = perImage.some((p) => p.looseDebris || p.baggedMaterial)
  if (looseOrBagged && (volumeLooksWide(v2) || v2.laborAssessment.potentialSecondTrip)) {
    det.push({
      id: 'q_hidden',
      question: 'Is there more behind or underneath the visible pile?',
      reason: 'Loose/bagged debris with a wide volume range — hidden material behind or under the pile would change the load size.',
      kind: 'hidden',
      priceImpact: 'medium',
    })
    kindsSeen.add('hidden')
  }

  // 7) ACCESS — ONE combined question when access is unknown on a non-trivial job.
  const acc = v2.accessAssessment
  const accessUnknown =
    acc.stairs === 'unknown' ||
    acc.elevator === 'unknown' ||
    acc.longCarry === 'unknown' ||
    acc.parkingRestricted === 'unknown'
  if (accessUnknown && isNonTrivialJob(v2)) {
    det.push({
      id: 'q_access',
      question: 'Are there stairs, or is everything ground-floor with easy truck access?',
      reason: 'Access (stairs/carry/parking) is unknown on a non-trivial job — it changes crew size and labor time.',
      kind: 'access',
      priceImpact: 'medium',
    })
    kindsSeen.add('access')
  }

  // ── Merge in the model's own recommended questions (dedup by meaning) ────────
  const modelQs: ClarificationV2[] = []
  v2.recommendedCustomerQuestions.forEach((q, i) => {
    const text = (q || '').trim()
    if (!text) return
    const kind = inferKind(text)
    // A deterministic question of the same kind already covers this meaning, and it
    // carries a targetObjectId + auditable reason — so the specific one wins.
    if (kindsSeen.has(kind)) return
    // Avoid an exact-text duplicate too.
    if (det.some((d) => d.question.toLowerCase() === text.toLowerCase())) return
    if (modelQs.some((d) => d.question.toLowerCase() === text.toLowerCase())) return
    modelQs.push({
      id: `q_model_${i + 1}`,
      question: text,
      reason: 'Model flagged this as needed to quote accurately (recommendedCustomerQuestions).',
      kind,
      priceImpact: defaultImpact(kind),
    })
  })

  let all = [...det, ...modelQs]

  // On a confident, tidy analysis, don't pester with low-impact extras (keep hazards).
  if (v2.confidence === 'high') {
    all = all.filter((c) => c.priceImpact !== 'low' || c.kind === 'hazard')
  }

  // Prioritize: price impact first, then kind (hazard + quantity lead), stable otherwise.
  const ordered = all
    .map((c, idx) => ({ c, idx }))
    .sort((a, b) => {
      const pi = IMPACT_RANK[a.c.priceImpact] - IMPACT_RANK[b.c.priceImpact]
      if (pi !== 0) return pi
      const ki = KIND_RANK[a.c.kind] - KIND_RANK[b.c.kind]
      if (ki !== 0) return ki
      return a.idx - b.idx
    })
    .map((x) => x.c)

  return ordered.slice(0, max)
}

// ── Fold customer answers back into the analysis (pure, immutable) ────────────

function parseFirstNumber(s: string): number | undefined {
  const m = s.match(/-?\d+(?:\.\d+)?/)
  if (!m) return undefined
  const n = Number(m[0])
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined
}

// yes/no intent for a free-text answer. Returns undefined when genuinely ambiguous.
function parseYesNo(s: string): boolean | undefined {
  const t = s.trim().toLowerCase()
  if (!t) return undefined
  if (/^(y|yes|yeah|yep|yup|true|correct|affirmative|sure)\b/.test(t) || /\byes\b/.test(t)) return true
  if (/^(n|no|nope|nah|false|negative|none)\b/.test(t) || /\bno\b|\bnot\b|\bnone\b/.test(t)) return false
  return undefined
}

function objectIdFrom(id: string, prefix: string): string | undefined {
  return id.startsWith(prefix) ? id.slice(prefix.length) : undefined
}

/**
 * Fold customer answers (keyed by clarification id) back into the analysis where the
 * mapping is deterministic. Returns a NEW analysis (immutable) so the deterministic
 * estimation engine can re-run over the improved inputs. Unparseable answers are
 * ignored — we never fabricate. Answers we can't deterministically apply (e.g. model
 * free-text questions) are left for a human, not invented into the analysis.
 */
export function applyAnswersV2(
  v2: JunkPhotoAnalysisV2,
  answers: Record<string, string>,
): JunkPhotoAnalysisV2 {
  const next: JunkPhotoAnalysisV2 = structuredClone(v2)
  const findObj = (objectId: string): UnifiedObject | undefined =>
    next.unifiedInventory.find((o) => o.objectId === objectId)

  for (const [id, rawAnswer] of Object.entries(answers)) {
    const answer = typeof rawAnswer === 'string' ? rawAnswer : ''
    if (!answer.trim()) continue

    // QUANTITY: a numeric answer tightens quantity/min/max to the customer's count.
    const qtyId = objectIdFrom(id, 'q_quantity_')
    if (qtyId) {
      const count = parseFirstNumber(answer)
      const obj = findObj(qtyId)
      if (count != null && obj) {
        obj.quantity = count
        obj.minQuantity = count
        obj.maxQuantity = count
        obj.confidence = 'high'
      }
      continue
    }

    // WEIGHT: map "two people can lift" ↔ "very heavy" onto weightClass.
    const wId = objectIdFrom(id, 'q_weight_')
    if (wId) {
      const obj = findObj(wId)
      if (obj) {
        const t = answer.toLowerCase()
        let wc: WeightClass | undefined
        if (/very heavy|too heavy|can'?t lift|cannot lift|need equipment|machine/.test(t)) wc = 'very_heavy'
        else if (/two people|2 people|heavy/.test(t)) wc = 'heavy'
        else if (/one person|1 person|light|easy to lift|can lift/.test(t)) wc = 'medium'
        if (wc) {
          obj.weightClass = wc
          obj.confidence = 'high'
        }
      }
      continue
    }

    // MATERIAL: solid vs. light shifts weightClass (and thus disposal weight).
    const mId = objectIdFrom(id, 'q_material_')
    if (mId) {
      const obj = findObj(mId)
      if (obj) {
        const t = answer.toLowerCase()
        if (/solid|hardwood|real wood|metal|steel|iron|cast/.test(t)) {
          if (obj.weightClass === 'light') obj.weightClass = 'medium'
          else if (obj.weightClass === 'medium') obj.weightClass = 'heavy'
          obj.confidence = 'high'
        } else if (/particle ?board|plastic|laminate|mdf|hollow|light|foam/.test(t)) {
          obj.weightClass = 'light'
          obj.confidence = 'high'
        }
      }
      continue
    }

    // ACCESS: resolve the 'unknown' access fields from a single yes/no answer.
    if (id === 'q_access') {
      const yes = parseYesNo(answer)
      const t = answer.toLowerCase()
      const acc = next.accessAssessment
      const stairsPresent = /stair|upstairs|second floor|2nd floor|upper level/.test(t) || yes === true
      const groundFloorEasy =
        /ground.?floor|first floor|1st floor|easy|no stair|driveway|curb|street level/.test(t) || yes === false
      if (stairsPresent) {
        if (acc.stairs === 'unknown') acc.stairs = true
      } else if (groundFloorEasy) {
        if (acc.stairs === 'unknown') acc.stairs = false
        if (acc.longCarry === 'unknown') acc.longCarry = false
        if (acc.narrowAccess === 'unknown') acc.narrowAccess = false
        if (acc.parkingRestricted === 'unknown') acc.parkingRestricted = false
      }
      continue
    }

    // HAZARD: a "yes" routes the job to manual review (safety) and marks the flag.
    if (id === 'q_hazard') {
      const yes = parseYesNo(answer)
      if (yes === true) {
        next.disposalAssessment.hazardousPossible = true
        next.manualReviewRequired = true
        const reason = 'Customer confirmed hazardous/special-disposal items present.'
        if (!next.manualReviewReasons.includes(reason)) next.manualReviewReasons.push(reason)
      }
      continue
    }

    // HIDDEN / model free-text: not deterministically foldable — leave for a human.
  }

  return next
}
