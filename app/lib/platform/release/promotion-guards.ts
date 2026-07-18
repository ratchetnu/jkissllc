// ── Operion production-promotion — hard guards (PURE) ────────────────────────
//
// Increment 3B.1. The allowlists + environment/test-only predicates that the
// eligibility evaluator (promotion-eligibility.ts) and every FUTURE promotion
// endpoint must consult. Server-side authoritative — UI state is never the control.
// 3B.1 has NO execution path; `promotionExecutionRefusal` therefore refuses in every
// environment (there is nothing to execute yet), and is the single sanctioned place a
// later increment will relax to `VERCEL_ENV === 'production'` only.

// Repositories that may EVER be a production-promotion target. The disposable sandbox
// is deliberately absent — it is test-only and refused (no override in 3B.1).
export const PROMOTION_REPO_ALLOWLIST = ['ratchetnu/jkissllc', 'ratchetnu/supercharged']

// Vercel projects that may EVER receive a production promotion.
export const PROMOTION_VERCEL_PROJECT_ALLOWLIST = ['jkissllc', 'supercharged']

// Test-only business identifiers / editions — refused by default, no override this increment.
export const TEST_ONLY_BUSINESS_IDS = ['operion-sandbox']
export const TEST_ONLY_EDITIONS = ['sandbox']

const norm = (s: string | undefined | null) => (s ?? '').trim().toLowerCase()

export function isRepoAllowed(repoName: string | undefined): boolean {
  return PROMOTION_REPO_ALLOWLIST.map(norm).includes(norm(repoName))
}

export function isVercelProjectAllowed(project: string | undefined): boolean {
  return PROMOTION_VERCEL_PROJECT_ALLOWLIST.map(norm).includes(norm(project))
}

export function isTestOnlyBusiness(b: { id?: string; role?: string; edition?: string } | null | undefined): boolean {
  if (!b) return false
  return TEST_ONLY_BUSINESS_IDS.map(norm).includes(norm(b.id))
    || TEST_ONLY_EDITIONS.map(norm).includes(norm(b.edition))
    || norm(b.role) === 'sandbox'
}

// Environments from which eligibility may be EVALUATED (owner diagnostic). Production
// and Preview may evaluate; development/test/unknown may not reason about a live promotion.
export function environmentAllowsEvaluation(vercelEnv: string | undefined): boolean {
  const e = norm(vercelEnv)
  return e === 'production' || e === 'preview'
}

export type PromotionExecutionRefusal = { allowed: false; code: 'EXECUTION_DISABLED_3B1'; message: string }

/**
 * The execution gate for production promotion. In Increment 3B.1 there is NO execution
 * pipeline, so this ALWAYS refuses — a hard backstop guaranteeing no route or action can
 * trigger a GitHub merge or Vercel production deploy yet. Later increments replace this
 * with `VERCEL_ENV === 'production' && OPERION_PRODUCTION_PROMOTION_ENABLED`.
 */
export function promotionExecutionRefusal(): PromotionExecutionRefusal {
  return { allowed: false, code: 'EXECUTION_DISABLED_3B1', message: 'production promotion execution is not implemented in Increment 3B.1' }
}
