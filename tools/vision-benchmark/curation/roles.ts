// ─────────────────────────────────────────────────────────────────────────────
// Confirmed model-role assignment.
//
// PROBE RESULT — 2026-08-05, Preview only, via Vercel AI Gateway:
//   openai/gpt-4o        reachable, image input accepted, structured output
//                        valid, text probe 1320ms, image probe 1833ms, healthy.
//   google/gemini-2.5-flash   reachable, image input accepted, structured output
//                        valid, text 1532ms, image 2089ms, healthy.
//
// The production estimator (anthropic/claude-sonnet-4-6) is the system under
// test. It appears here only so `assertIndependent()` has something to refuse.
// ─────────────────────────────────────────────────────────────────────────────

import { independenceViolations, type Role, type RoleAssignment } from './types'

/** The model under evaluation. Never a judge of its own output. */
export const PRODUCTION_ESTIMATOR = 'anthropic/claude-sonnet-4-6'

export const PROMPT_VERSIONS = {
  classifier: 'curation.classifier.v1',
  labeler: 'curation.labeler.v1',
  verifier: 'curation.verifier.v1',
  adjudicator: 'curation.adjudicator.v1',
} as const

/**
 * Assignment as confirmed by the probe.
 *
 * Verifier note: the verifier is a DIFFERENT FAMILY from the labeler (Google vs
 * OpenAI), which is the strongest independence available here. Two models from
 * one family share training lineage and tend to be wrong in the same direction —
 * agreement between them would look like verification while measuring very
 * little. Do not move the verifier back into the labeler's family.
 */
export const DEFAULT_ROLES: RoleAssignment[] = [
  { role: 'classifier', model: 'openai/gpt-4o-mini', promptVersion: PROMPT_VERSIONS.classifier },
  { role: 'labeler', model: 'openai/gpt-4o', promptVersion: PROMPT_VERSIONS.labeler },
  { role: 'verifier', model: 'google/gemini-2.5-flash', promptVersion: PROMPT_VERSIONS.verifier },
  // Adjudicator runs ONLY on disagreement. A stronger model is justified there
  // precisely because it is rare; running it unconditionally would triple cost.
  { role: 'adjudicator', model: 'openai/gpt-4.1-mini', promptVersion: PROMPT_VERSIONS.adjudicator },
]

/**
 * Retained as the explicit record that DEFAULT_ROLES already is the preferred,
 * cross-family assignment. Kept separate so a future change that weakens
 * independence has to disagree with something rather than merely edit it.
 */
export const PREFERRED_ROLES: RoleAssignment[] = DEFAULT_ROLES

export type IndependenceCheck = { ok: boolean; errors: string[]; warnings: string[] }

/** Split violations into blocking errors and advisory warnings. */
export function checkIndependence(
  roles: RoleAssignment[] = DEFAULT_ROLES, productionModel = PRODUCTION_ESTIMATOR,
): IndependenceCheck {
  const all = independenceViolations(roles, productionModel)
  const warnings = all.filter(v => v.startsWith('WARN'))
  const errors = all.filter(v => !v.startsWith('WARN'))
  return { ok: errors.length === 0, errors, warnings }
}

/**
 * Fail closed. Any role independence error aborts the run before a single
 * candidate is processed — a pipeline that quietly degrades to the production
 * model would produce a benchmark that grades itself.
 */
export function assertIndependent(
  roles: RoleAssignment[] = DEFAULT_ROLES, productionModel = PRODUCTION_ESTIMATOR,
): void {
  const { ok, errors } = checkIndependence(roles, productionModel)
  if (!ok) throw new Error(`role independence violated — refusing to run:\n  ${errors.join('\n  ')}`)
}

/** There is no fallback to the production estimator. Ever. */
export function modelForRole(role: Role, roles: RoleAssignment[] = DEFAULT_ROLES): string {
  const a = roles.find(r => r.role === role)
  if (!a) throw new Error(`no model assigned for role ${role} — there is no production-estimator fallback`)
  return a.model
}
