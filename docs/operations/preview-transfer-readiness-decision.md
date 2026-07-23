# Preview Transfer Readiness — Coordinator Decision

> ## ⚠️ HISTORICAL (2026-07-22) — the canary question it gates is already answered
>
> This document reasons toward *whether a first Preview canary may be dispatched*. **That canary
> has already run and passed.** The approved Preview canary is **UPD-1007 @ `106846c0`** — not
> "UPD-A", which was a dead, never-registered proposal and **not a second update**. Workflow run
> **`29697932299`** completed **`success`**; Supercharged **PR #3** carried exactly
> `operion-canary.json` and was **closed, never merged**; **Production promotion was
> intentionally not requested and is not pending.**
>
> Two premises below are obsolete:
> - **CB-3 ("Production flag enablement — owner decision, still outstanding") is CLOSED.** The
>   Operion automation flags are **ON** in J KISS Production (audited 2026-07-22, confirmed in a
>   live owner session 2026-07-23). Statements here or elsewhere that all Operion Production
>   flags are OFF are wrong; the **audited runtime state** is authoritative.
> - **No "first canary" needs dispatching.** Read the blocker list as a record of what was
>   unverified on 2026-07-22, not as work outstanding today.
>
> Unchanged and still binding: **`UPD-1004` is terminal/rejected — do not retry it**; **`UPD-B`
> remains unregistered by decision**; **the idempotency binding was not cleared**.
>
> Canonical state: `sprint-1-session-status.md` → *"CANARY IDENTITY CORRECTION + RELEASE STATE"*.

**Decided:** 2026-07-22 · **Coordinator:** lead session · **Base:** `main` `126a101`
**Inputs:** S2's `pr56-transfer-evidence-preview-validation.md` (findings M-1…M-7) · `preview-transfer-validation-runbook.md` (Phase P0)
**Nothing was implemented, no PR opened, no environment touched in reaching this decision.**

---

## 0. A distinction that changes the answer

S2's document is a **completed checklist**, not a **completed validation**.

Steps V-1…V-22 are *recommendations*. **None has been executed.** No result is recorded anywhere against any of them. Verified: no new branch, no new artefact, no Preview job, no `platform:autoev:*` key reported, and Supercharged is untouched.

**So nothing about transfer evidence has yet been validated in a running environment.** Any statement that "Preview validation is complete" would be false. What is complete is the *plan for* validation, plus a genuinely good static review of the merged code.

This is not a criticism of S2's work — the document says so itself. It matters only because the decision below would be different if results existed.

### Three claims from S2 independently re-verified by the coordinator

| Claim | Verified |
|---|---|
| Merged scope is 7 files / +674−6, not the PR body's "6 files / +533−6" | ✅ `git diff --stat c48b6c7..126a101` |
| `manifest-builder.ts` **was** modified, contrary to the PR body | ✅ `BuiltManifest` carries `skippedModules`, populated at `:205` |
| The comment *"Response shape is unchanged — the runner sees exactly what it saw before"* is now **false** | ✅ still present at `manifest/route.ts:93`; `skippedModules` is on the wire |
| Harmless in practice — the runner ignores unknown fields | ✅ `operion-apply.mjs` destructures only `{ manifest, contents, targetBaseCommit }` |
| **M-1: the admin evidence route has zero test coverage** | ✅ **confirmed** — no test file references `getTransferEvidence` or the admin automation route |

---

## 1. Decision — Question 1

> **Is the system ready for the first Preview transfer runbook?**

**Split answer, because "the Preview runbook" currently names two different things.**

### ✅ **APPROVED — Phase P0, the read-only rehearsal** (`preview-transfer-validation-runbook.md`)

Ready to execute once three prerequisites clear (§3). P0 writes nothing anywhere, needs no flag change, and needs no owner session. It closes the real gap: **every gate merged this sprint has only ever run against fixtures — none has run against the two real repositories.**

### ❌ **NOT APPROVED — the transfer-attempt steps in S2's checklist** (V-4, V-5, V-6, V-17, V-18)

Those require a **real transfer**: `OPERION_AUTOMATION_ENABLED` on, a real job created, dispatch, and — for V-18's "beyond what the transfer itself legitimately creates" — **writes to Supercharged**. All four are prohibited by the standing constraints, and dispatch from a Preview deployment is blocked by design (`preflight.ts:34`, gate `production_control_plane`).

**S2's checklist and the P0 runbook assume different scopes.** The checklist is the right document for the *canary* phase; it is not executable under "Preview only, no Production flags, no Supercharged writes." Its read-only steps (V-1, V-2, V-3, V-9, V-11, V-15, V-16, V-20, V-21) are largely reusable now; the ✍️ steps are not.

**Nothing in either document changes the merged state of PR #56.** It is additive, fail-soft, alters no gate verdict, and is inert in Production. This decision governs what runs next, not whether #56 stays.

---

## 2. Decision — Question 2: finding triage

### 🔴 Preview blockers — must close before the corresponding Preview step runs

| # | Finding | Blocks |
|---|---|---|
| **PB-1** | **M-1 — admin evidence route untested, including whether `requirePlatformOwner` gates the *evidence* payload rather than only the job** | Any Preview step that reads evidence back (V-7, V-15, P0 step E7). **Not a blocker for P0's core**, since E7 is optional by design. It is an unverified authorisation control on a new data surface, so it must be closed before anyone relies on that route. |
| **PB-2** | **A6 — no platform-owner Preview session exists**, and none may be created by an agent (no account creation, no password entry) | V-7, V-15, V-16, E7 |
| **PB-3** | **A3/A4 — `PlatformBusiness` (`supercharged`) and `UpdateCompatibility` records in Preview Redis are unverified** | P0 fixture selection; every gate case |

### 🟠 Production-canary blockers — must close before any canary, and are **not** closed by a clean P0

| # | Finding |
|---|---|
| **CB-1** | **M-1 again, at higher severity.** Before a canary, the evidence route is the surface an owner reads during an incident. Unverified owner gating on it is not acceptable. |
| **CB-2** | **M-5 — rollback/evidence semantics undefined.** A rolled-back transfer leaves evidence still reading `built`, with no indication the result was reverted. For a record whose stated purpose is incident review, that actively misleads. |
| **CB-3** | ✅ **CLOSED (2026-07-23).** ~~**Production flag enablement** … **Owner decision, still outstanding.**~~ The three flags (`OPERION_AUTOMATION_ENABLED` + `OPERION_PREVIEW_AUTOMATION_ENABLED` + `OPERION_GITHUB_ACTIONS_ENABLED`) were **already ON** in J KISS Production — audited 2026-07-22, confirmed in a live owner session 2026-07-23. **No Production write was needed and none was made.** `preflight.ts:34` still blocks Preview-deployment dispatch by design; that is unrelated to flag state. |
| **CB-4** | **Authorisation to write to Supercharged** (branch + PR on Preview). Owner decision. |
| **CB-5** | **The apply path has never executed.** `operion-apply.mjs`, the `targetBaseCommit` TOCTOU handshake, the signed callback, and a verified `DeploymentRecord` are all unexercised. P0 explicitly does not touch them. |
| **CB-6** | **M-6 — the route's success path is unreachable end to end in tests.** Shaping and persistence are tested in isolation; their composition on the 200 path is not. A canary would be its first execution. |

### 🟡 Future hardening — real, none blocking

| # | Finding | Note |
|---|---|---|
| **FH-1** | **M-2 — `set` + `pexpire` is non-atomic**; death between them leaves a record with no TTL, i.e. permanent retention of something designed to expire at 90 days. Independently found by the coordinator during PR review. `app/lib/redis.ts` exposes no atomic overwrite-with-TTL (`setNxPx` is set-if-absent), so this needs a small wrapper addition. Bounded and self-correcting on any rewrite. |
| **FH-2** | **M-3 — marker/evidence divergence.** If the business lock is busy, `transferEvidenceAt` is skipped while evidence is already written. Mitigated in practice: the admin route reads evidence **by jobId**, never via the marker — so a reader is not misled today. Worth asserting in a test. |
| **FH-3** | **M-4 — evidence carries no `businessId`.** Attribution requires joining to the job; if the job ages out first, the evidence cannot answer "which target was this?". |
| **FH-4** | **M-7 — truncation caps (250) sit above every real producer** (closure 200, symbols 150), so the truncation branch cannot fire from real inputs. Correct and deliberate; means the accounting is proven only synthetically. |
| **FH-5** | **Stale comment**, `manifest/route.ts:93`. It asserts the runner response is unchanged; it is not. The behaviour is correct and pinned by the closed-set test — **only the comment is wrong.** This survived the coordinator's #56 work order and should be corrected in the next touch of that file. |

---

## 3. Execution owner and sequence — Phase P0 (approved)

**Prerequisites, in order. Nothing runs until all three clear.**

| # | Prerequisite | Owner |
|---|---|---|
| **P-1** | Verify A3/A4: `PlatformBusiness` (`supercharged`) and per-case `UpdateCompatibility` exist in **Preview** Redis. Seed in Preview only if absent — control-plane config, never customer data. | **S3**, reports to coordinator |
| **P-2** | Build the read-only harness per runbook §E1. **Structural safety is mandatory:** wrap the live provider so every write method throws. Opened as a PR; **coordinator merges.** | **S3** implements · **coordinator** reviews + merges |
| **P-3** | Propose the six-case fixture table with expected verdicts. **Coordinator approves in writing before any run.** | **S3** proposes · **coordinator** approves |

**Execution sequence once prerequisites clear:**

| Step | Owner | Action | Gate |
|---|---|---|---|
| **E0** | **S1** | Capture baseline: both `main` SHAs, Supercharged branches / PRs / workflow runs, Production deployment id | published before E3 |
| **E3** | **S3** | Run **C1 only** (the pass case, `106846c0`) | ⛔ **HARD STOP** — coordinator reviews output and the write-call counter before anything else runs |
| **E4** | **S3** | Run C2–C6, one at a time | stop on any unexpected verdict |
| **E5** | **S3** | Evidence shape check on one `built` + one `refused` | — |
| **E6** | **S3** | Read-amplification counts per case | — |
| **E7** | — | **SKIPPED** — blocked by PB-2 | its absence does not invalidate P0 |
| **E8** | **S1** | Re-capture and **diff against the E0 baseline** | any difference = failure |
| **E9** | **Coordinator** | Publish results, verdicts, read counts, and what remains unproven | — |

**Standing limits during P0:** no flag change in any environment · no Production action · no Supercharged write · no job, branch, or dispatch created · no customer data · **S3 does not merge anything** · on anything unexpected, **preserve and report — do not clean up**, because cleanup destroys the evidence.

**S2** is not involved in P0 and continues booking-lane work on `126a101`.

---

## 4. What a clean P0 will and will not authorise

A clean P0 proves the gate chain **decides** correctly against real repository data. It does **not** prove the pipeline **delivers** correctly, and it does **not** authorise the canary — CB-1 through CB-6 remain open regardless of the outcome.

**Decision stands. Nothing executes until P-1, P-2 and P-3 clear.**
