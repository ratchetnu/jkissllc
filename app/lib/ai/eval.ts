import { scoreResponse } from './quality'
import { getPrompt, hasPrompt } from './prompts'
import { validateJson, COMMAND_SCHEMA, ESTIMATE_SCHEMA, type ObjectSchema } from './schema'
import { AI_FEATURES } from './registry'

// AI Quality Regression / Evaluation harness (LLMOps Phase 3). A DETERMINISTIC,
// model-free evaluation over golden fixtures — canned model responses (good and bad)
// scored by the heuristic quality gate and, for structured features, validated
// against their schema. It is the pre-deploy safety net (item 10) and the engine
// behind the in-app "Run evaluation" button. No network, no credits, no flakiness:
// the same fixtures always produce the same verdict, so a prompt or scorer change
// that regresses a feature fails the build.

export type EvalCase = {
  name: string
  response: string         // a canned model output to score
  minScore: number         // pass threshold for the heuristic score
  expectFlags?: string[]   // flags that MUST be present (for the "bad" fixtures)
  schemaValid?: boolean    // for structured features: must this parse against the schema?
}

export type FeatureFixture = {
  taskId: string
  schema?: ObjectSchema
  renderVars: Record<string, unknown>   // vars to prove build() renders without error
  renderMustInclude: string[]           // tokens that must appear in the rendered prompt/system
  cases: EvalCase[]
}

export const FIXTURES: FeatureFixture[] = [
  {
    taskId: 'ops.command', schema: COMMAND_SCHEMA,
    renderVars: { query: 'go to claims', targetsText: 'claims — Claims', summaryJson: '{"openClaims":2}' },
    renderMustInclude: ['go to claims', 'claims — Claims'],
    cases: [
      { name: 'valid navigate', response: '{"targetId":"claims"}', minScore: 100, schemaValid: true },
      { name: 'valid answer', response: '{"answer":"2 open claims"}', minScore: 100, schemaValid: true },
      { name: 'malformed json', response: 'sure! {oops', minScore: 0, expectFlags: ['not_json'], schemaValid: false },
    ],
  },
  {
    taskId: 'ops.message',
    renderVars: { intentInstruction: 'a friendly reminder', ctxJson: '{"customer":"Sam"}', extra: 'keep it short' },
    renderMustInclude: ['a friendly reminder', 'Sam', 'keep it short'],
    cases: [
      { name: 'good short message', response: 'Hi Sam, just a quick reminder your pickup is tomorrow morning. Reply here with any questions. — J Kiss LLC', minScore: 85 },
      { name: 'leftover placeholder', response: 'Hi [Customer Name], your service is on [DATE]. — J Kiss LLC', minScore: 0, expectFlags: ['has_placeholder'] },
      { name: 'empty', response: '', minScore: 0, expectFlags: ['empty'] },
    ],
  },
  {
    taskId: 'ops.insights',
    renderVars: { summaryJson: '{"revenue":{"month":"$1"}}' },
    renderMustInclude: ['business data', 'revenue'],
    cases: [
      { name: 'good briefing', response: 'Highlights\n- Revenue is pacing ahead of forecast\n- Junk removal is the top earner\n- A/R is $400 outstanding\nActions\n- Text the two unpaid customers today', minScore: 80 },
      { name: 'no bullets', response: 'Everything looks fine this week and you should keep doing what you are doing because the numbers are trending in a positive direction overall.', minScore: 0, expectFlags: ['no_bullets'] },
    ],
  },
  {
    taskId: 'ops.reviewReply',
    renderVars: { author: 'Dana', rating: '5', text: 'Great crew!' },
    renderMustInclude: ['Dana', '5 out of 5', 'Great crew!'],
    cases: [
      { name: 'good reply', response: 'Thank you so much, Dana! We really appreciate you taking the time. It was a pleasure helping you.', minScore: 85 },
      { name: 'placeholder', response: 'Thanks [NAME], we appreciate your [RATING] star review!', minScore: 0, expectFlags: ['has_placeholder'] },
    ],
  },
  {
    taskId: 'ops.photoEstimate', schema: ESTIMATE_SCHEMA,
    renderVars: {},
    renderMustInclude: ['junk-removal', 'loadSize'],
    cases: [
      { name: 'valid estimate', response: '{"loadSize":"About a half truck","low":475,"high":650,"summary":"Looks like a solid half-load."}', minScore: 100, schemaValid: true },
      { name: 'hazmat refusal (valid)', response: '{"loadSize":"A few items","low":0,"high":0,"summary":"We can\'t haul hazardous materials — please contact us."}', minScore: 100, schemaValid: true },
      { name: 'malformed', response: 'about half a truck, maybe $500', minScore: 0, expectFlags: ['not_json'], schemaValid: false },
    ],
  },
  {
    // Observations-only vision read; validated at runtime by normalizeAnalysis (a
    // nested schema), so no flat ObjectSchema here — coverage proves the prompt
    // renders its output contract and a plausible analysis clears the gate.
    taskId: 'ops.junkAnalysis',
    renderVars: {},
    renderMustInclude: ['normalizedItems', 'estimatedTruckLoadFraction'],
    cases: [
      { name: 'plausible analysis', response: '{"normalizedItems":[{"category":"furniture","label":"couch","estimatedQuantity":1}],"estimatedTruckLoadFraction":{"minimum":0.2,"likely":0.3,"maximum":0.4},"confidence":{"overall":0.7}}', minScore: 60 },
    ],
  },
  {
    taskId: 'ops.junkAnalysisReview',
    renderVars: {},
    renderMustInclude: ['quality reviewer', 'adjustedTruckLoadFraction'],
    cases: [
      { name: 'accept verdict', response: '{"agrees":true,"recommend":"accept","adjustedTruckLoadFraction":0.3,"confidence":0.7,"concerns":[]}', minScore: 60 },
    ],
  },
]

export type CaseResult = { name: string; score: number; flags: string[]; pass: boolean; reason?: string }
export type FeatureEval = { taskId: string; renderOk: boolean; cases: CaseResult[]; pass: boolean }
export type EvalReport = { generatedAt: number; pass: boolean; features: FeatureEval[]; totals: { features: number; passed: number; cases: number; casesPassed: number } }

function evalFeature(fx: FeatureFixture): FeatureEval {
  // 1) the prompt must exist and render without throwing, including expected tokens.
  let renderOk = false
  try {
    if (!hasPrompt(fx.taskId)) throw new Error('missing prompt')
    const built = getPrompt(fx.taskId).build(fx.renderVars)
    const hay = `${built.system}\n${built.prompt}`
    renderOk = fx.renderMustInclude.every(tok => hay.includes(tok))
  } catch { renderOk = false }

  // 2) each golden case: heuristic score threshold + required flags + schema validity.
  const cases: CaseResult[] = fx.cases.map(c => {
    const q = scoreResponse(fx.taskId, c.response)
    let pass = q.score >= c.minScore
    let reason: string | undefined
    if (!pass) reason = `score ${q.score} < ${c.minScore}`
    if (c.expectFlags) {
      for (const f of c.expectFlags) if (!q.flags.includes(f)) { pass = false; reason = `missing flag ${f}` }
    }
    if (typeof c.schemaValid === 'boolean' && fx.schema) {
      const v = validateJson(c.response, fx.schema)
      if (v.ok !== c.schemaValid) { pass = false; reason = `schema valid=${v.ok}, expected ${c.schemaValid}` }
    }
    return { name: c.name, score: q.score, flags: q.flags, pass, reason }
  })

  return { taskId: fx.taskId, renderOk, cases, pass: renderOk && cases.every(c => c.pass) }
}

export function runEval(now: number = Date.now()): EvalReport {
  const features = FIXTURES.map(evalFeature)
  const casesTotal = features.reduce((a, f) => a + f.cases.length, 0)
  const casesPassed = features.reduce((a, f) => a + f.cases.filter(c => c.pass).length, 0)
  // Every registered feature must have a fixture — otherwise coverage silently rots.
  const covered = new Set(FIXTURES.map(f => f.taskId))
  const uncovered = AI_FEATURES.filter(f => !covered.has(f.taskId))
  const pass = features.every(f => f.pass) && uncovered.length === 0
  return {
    generatedAt: now,
    pass,
    features,
    totals: { features: features.length, passed: features.filter(f => f.pass).length, cases: casesTotal, casesPassed },
  }
}
