# Operion Increment 3B.1 — Promotion State Model, Eligibility & Guards

Additive, **flag-off, no-execution** foundation for owner-approved Production promotion.
Nothing here merges, deploys, promotes, or mutates a Business. It reuses the existing
release-state resolver, update-run model, automation job model, feature flags, and owner
auth — it does **not** create a second release system.

## State model (release-level, projected from the automation job)
New `ReleaseStatus` values (in `app/lib/platform/release/state.ts`), reached **only** when a
promotion phase is present; otherwise the resolver is byte-identical to Increment 3A:

`awaiting_approval · publishing · verifying_production · published · publish_failed · rolling_back · rolled_back · rollback_failed`

The promotion vocabulary + mapping live in `app/lib/platform/release/promotion-state.ts`:
- `promotionPhaseOf(automationStatus)` maps the internal `awaiting_owner_review → approved_for_production → merging → production_deploying → verifying → completed` / `rollback_*` statuses to a `PromotionPhase` (shared terminals `completed`/`failed` disambiguated by `isPromotionJob`).
- `PROMOTION_PHASE_TO_RELEASE` maps each phase to `{ status, action }`.
- `resolveReleaseState` gains one top-precedence branch: `if (signals.promotion) …`. Absent ⇒ unchanged.

### Transitions (documented + tested; NOT wired to execution)
```
ready_to_publish → awaiting_approval        (the ONLY door into the pipeline)
awaiting_approval → publishing | publish_failed
publishing → verifying_production | publish_failed
verifying_production → published | publish_failed
publish_failed → rolling_back | awaiting_approval(retry)
published → rolling_back
rolling_back → rolled_back | rollback_failed
```
Enforced by `canReleasePromotionTransition(from, to)`. Unknown/legacy states fail safely (no transition, resolver unchanged).

## Eligibility evaluator (pure)
`app/lib/platform/release/promotion-eligibility.ts` — `evaluatePromotionEligibility(input)` returns
`{ eligible, reasons[], warnings[], requirements[], evaluatedAt, candidate }`. No I/O; the caller
assembles the snapshot. Ten categories: **authorization · feature flags · environment · business
safety · preview validation · concurrency/idempotency · repository safety · vercel safety · change
integrity · audit readiness.**

### Refusal codes (machine-readable + human message)
`PROMOTION_DISABLED · OWNER_REQUIRED · INVALID_ENVIRONMENT · BUSINESS_NOT_FOUND · BUSINESS_INACTIVE ·
TEST_ONLY_BUSINESS · PREVIEW_NOT_READY · VERIFICATION_MISSING · VERIFICATION_FAILED · VERIFICATION_EXPIRED ·
CANDIDATE_MISSING · CANDIDATE_CHANGED · VERSION_INVALID · UPGRADE_PATH_INVALID · ACTIVE_RUN_EXISTS ·
DUPLICATE_PROMOTION · PROMOTION_LOCKED · ALREADY_PUBLISHED · REPOSITORY_NOT_ALLOWED · BRANCH_NOT_ALLOWED ·
COMMIT_MISMATCH · PRODUCTION_PROJECT_NOT_ALLOWED · PRODUCTION_DEPLOYMENT_UNKNOWN · ROLLBACK_TARGET_MISSING ·
AUDIT_CONTEXT_MISSING`

## Guards (`promotion-guards.ts`, server-authoritative)
- `PROMOTION_REPO_ALLOWLIST` = `ratchetnu/jkissllc`, `ratchetnu/supercharged` (sandbox deliberately absent).
- `PROMOTION_VERCEL_PROJECT_ALLOWLIST` = `jkissllc`, `supercharged`.
- `isTestOnlyBusiness` refuses `operion-sandbox` / `edition==='sandbox'` / `role==='sandbox'` (no override this increment).
- `environmentAllowsEvaluation` — preview/production may evaluate; dev/test may not.
- **`promotionExecutionRefusal()` ALWAYS refuses** — the hard backstop guaranteeing no route can execute a promotion in 3B.1.

## Feature flags
`OPERION_PRODUCTION_PROMOTION_ENABLED` (already defined; default **false**). `parseBool` resolves
missing/empty/invalid → false. It is server-only (never client-authoritative) and is **not** set true
in Production. Auto-rollback stays behind `OPERION_AUTOMATIC_ROLLBACK_ENABLED` (unchanged, off).

## Data model — deferred (documented)
**No KV/schema change.** `UpdateAutomationJob` already carries every field the evaluator and future
execution need (`pullRequestNumber`, `approvedCommit`, `targetCommit`, `previewDeploymentId`,
`productionDeploymentId`, `rollbackTargetDeploymentId`, `mergeCommit`, `workBranch`, `approvedBy/At`).
The forward-compat types (`PromotionCandidate`, `EligibilitySnapshot`, `PromotionLock`) are declared for
later increments but **no store is created and no record is written** — persistence of the eligibility
snapshot + lock lands with the execution pipeline (3B.3).

## Internal diagnostic (owner-only, evaluate-only)
`GET /api/admin/release/businesses/[id]/promotion-eligibility` — platform-owner gated, read-only.
Assembles the snapshot from internal KV only (business + newest job + latest reconciliation), runs the
pure evaluator, and returns the result plus `promotionExecutionRefusal()`. It **never** calls
GitHub/Vercel, creates a run, acquires a lock, mutates a Business, or exposes secrets. No visible
"Publish" button is added in 3B.1.

## Not in 3B.1
Owner approval UI (3B.2) · merge/deploy execution (3B.3) · production verification + rollback execution
(3B.4) · audit persistence + controlled validation (3B.5).
