# Execution Order — post-#58 (2026-07-23)

**Coordinator sequencing. No merges executed here — plan only, per instruction.**
**Base:** `main` `4d936fb` (PR #58 merged 2026-07-22T23:17Z).

Every merge to `main` triggers a J KISS **Production deploy** via Vercel Git integration — true for all steps below. That does not make them unsafe, but it is why each step re-checks `origin/main` and waits for Ready.

---

## 🔴 Prerequisite finding that reshapes Step 5

PR #58 carried commit `41493ae`, *"reflect audited Production flag state (enabled, approval-gated)"*. It asserts — as a **2026-07-22 owner audit**, doc-only — that the Operion automation flags are **ENABLED in J KISS Production**:

- `OPERION_AUTOMATION_ENABLED` resolves **ON**, plus `OPERION_PREVIEW_AUTOMATION_ENABLED` and `OPERION_GITHUB_ACTIONS_ENABLED`
- **7 owner-initiated Preview automation jobs already exist** (4 failed pre-Preview, 2 cancelled at review, 1 reached a verified Preview); 0 `approved_production`, 0 promotions
- Side-effecting actions (transfer, canary, promotion) remain **approval-gated**, so no automated Production transfer has executed

**This contradicts the premise carried all session** ("all Operion flags OFF; the canary needs a Production flag change" — canary blocker CB-3). If the audit is correct, **CB-3 is already satisfied** and the flag-enablement step the canary was waiting on has effectively happened.

**It is not independently verified.** `vercel env pull` redacts `OPERION_*` (known), so the doc says the Release Center *resolved runtime* is the source of truth — which needs an owner login I don't have. **Step 5 must confirm this against the live runtime before treating CB-3 as closed. Do not carry the doc's claim forward as fact.**

Nothing in Steps 1–4 depends on the flag state.

---

## The order

### Step 1 — Merge PR #57 (nav: Team & Access)
- **State:** MERGEABLE/CLEAN. Base behind `main` (merge-base `262ae5e`, pre-#58). Disjoint from #58's docs, so it will merge clean; **update-branch or confirm CLEAN after re-check** first.
- **Nature:** presentation + routing only — 3 files, no page/API/permission/flag change. Inert to everything Operion.
- **Gate:** re-check `origin/main`; full suite already 1937/1937 on branch; merge; wait for Production Ready; confirm nav renders and no flag/env changed.
- **Owner:** coordinator merges.

### Step 2 — Merge PR #59 (rehearsal harness)
- **State:** checks green (verify + Vercel pass). GitHub mergeability UNKNOWN (not recomputed); base behind `main` (merge-base `126a101`). **Re-check / update-branch before merge.**
- **Nature — verified isolated tooling:** 6 files, all under `tools/operion-rehearsal/` plus `scripts/operion-rehearsal.test.ts`. **No runtime file, no flag, no env, no Production behaviour.** Matches the approval criteria exactly (isolated tooling, no runtime changes, no Production impact).
- **This is the P0 harness** from the readiness decision (`preview-transfer-readiness-decision.md`, prerequisite P-2). Merging it does **not** run a rehearsal — it only lands the read-only harness. Execution stays gated behind P-1/P-3.
- **Gate:** re-check `origin/main`; full suite green including the new test; confirm zero runtime files in the diff; merge; wait for Ready.
- **Owner:** coordinator merges.

### Step 3 — Open the failure-reason PR(s)
- **Source:** commit `87ac392` on `fix/operion-surface-transfer-reason` (unpushed, in the primary worktree).
- **⚠️ NOT tooling.** Touches `.github/workflows/operion-update.yml`, `app/admin/operations/release/page.tsx`, `app/api/admin/release/businesses/[id]/update/route.ts`, and `scripts/operion-apply.mjs` (the CI runner) + a test. **Runtime + CI change — full review, not a tooling wave-through.**
- **Action:** push the branch, open the PR against current `main`. If the CI-runner change (`operion-apply.mjs` / workflow) and the Release Center UI change are separable, **prefer two PRs** — the runner touches the transfer path and deserves isolated review; the UI is presentation. Decide at review time.
- **Owner:** Session 3 pushes + opens (implementation); coordinator does not author.
- **No merge in this step.**

### Step 4 — Review the failure-reason PR(s)
- Independent coordinator review. Focus points:
  - `operion-apply.mjs` changes run in the **target repo's CI** — confirm no new failure mode on the apply path, and that error surfacing never leaks secrets or file contents (same discipline as the transfer-evidence review).
  - Workflow YAML change — confirm it does not alter dispatch triggers (must stay `workflow_dispatch`).
  - Release Center page + API — confirm read-only, owner-gated, and that the hydrated failure reason carries no internal/secret text.
  - Behavioural tests, not source-text assertions.
  - Full suite + tsc + ESLint + build + AI regression on a merge preview against current `main`.
- **Merge decision after review** — separate coordinator confirmation, not automatic.

### Step 5 — Final canary readiness check (assessment only — no execution)
- **Hard prerequisite:** independently confirm the resolved Production flag state via the live runtime (Release Center / owner), settling the finding above. Until then CB-3 is *claimed*, not closed.
- Re-evaluate the canary blockers from `preview-transfer-readiness-decision.md`:
  - **CB-1** admin evidence route owner-gating (M-1) — still untested?
  - **CB-2** rollback/evidence semantics (M-5) — still undefined?
  - **CB-3** Production flag enablement — **reconcile with the audit finding.**
  - **CB-4** authorisation to write to Supercharged.
  - **CB-5** apply path never executed — does the P0 rehearsal (once run) plus Step 3's runner change move this?
  - **CB-6** route success path unreachable in tests.
- **Output:** a readiness verdict listing which canary blockers are closed, which remain, and what the owner must still decide. **No flag change, no transfer, no Production config change** — assessment only, matching the standing constraints.

---

## Standing constraints (unchanged)
Do not enable flags · do not run a transfer · do not modify Production configuration. Steps 1–2 merge inert changes; Step 3 opens (does not merge); Step 4 reviews; Step 5 assesses. Each merge re-checks `origin/main` first and waits for Production Ready.

**Stop point: sequencing published. Awaiting go-ahead to begin Step 1.**
