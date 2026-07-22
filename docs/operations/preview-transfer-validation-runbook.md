# Preview Transfer Validation — Runbook (Phase P0)

**Status:** PLAN ONLY — published for approval. No code, no execution.
**Coordinator:** lead session · **Published:** 2026-07-22 · **Base:** `main` `126a101` (post PR #56)
**Constraints in force:** Preview only · no Production flags · no Production config changes · **no Supercharged writes** · no real customer data · **no canary execution**

---

## 0. Read this first — what these constraints permit

The constraints and the pipeline's own gates interact in a way that decides this entire phase, so it is stated up front rather than discovered mid-run.

**A live transfer cannot happen under these constraints. Three independent blocks:**

| Block | Evidence |
|---|---|
| Dispatch cannot originate from Preview | `preflight.ts:34` — gate `production_control_plane`, reason string: *"workflow dispatch is disabled from Vercel Preview deployments"* |
| The manifest endpoint needs an existing job, and creating one needs the flags on | `manifest/route.ts:20` → 403 when `OPERION_AUTOMATION_ENABLED` is off; `:29-30` → 404 without a real job |
| A transfer's whole purpose is a branch + PR on the target | prohibited by **no Supercharged writes** |

So this phase is **not** a transfer. It is a **read-only rehearsal of the decision chain** — the gates that decide *whether* a transfer may proceed — exercised against **real repository data**, writing nothing anywhere.

That is worth doing on its own terms: every gate merged this sprint (#49 exclusions, #50 drift + rename, #51 closure, #52 required-updates/transfer-ready, #55 symbols, #56 evidence) has been proven by unit tests against fixtures. **None has ever been run against the two real repositories.** Phase P0 closes exactly that gap and nothing more.

---

## 1. Validation objectives

**Prove, against real J KISS and Supercharged repository data, that the gate chain returns the correct verdict — and that a refusal is legible.**

| # | Objective |
|---|---|
| **O1** | Every gate fires on real data, in the documented order: compatibility → refs → `pathsToExclude` → rename refusal → dependency closure → exported symbols → three-way drift |
| **O2** | Each gate can be made to **refuse** by a real commit chosen to violate it, and the refusal message names the cause precisely |
| **O3** | A commit expected to **pass** passes cleanly, with a manifest whose entry list is exactly what was intended |
| **O4** | `transferEvidence` (PR #56) captures a faithful record for **both** outcomes — `built` and `refused` — including `skippedModules` and truncation accounting |
| **O5** | Read volume per run is measured, so §4 #6 (read amplification) has a real number instead of an estimate |
| **O6** | The Supercharged repository is provably **unmodified**: same `main` SHA, no new branch, no new PR, no workflow run |

### Explicit NON-objectives — this phase does not prove them

- ❌ That the CI runner applies a manifest correctly (`operion-apply.mjs` never executes)
- ❌ The `targetBaseCommit` TOCTOU handshake at apply time
- ❌ Preview deployment of a transferred change, or a verified `DeploymentRecord`
- ❌ The signed callback path
- ❌ Anything about Production

Those require the canary, which is **out of scope** and separately gated. **Do not report P0 success as "the transfer pipeline works."** It proves the pipeline *decides* correctly, not that it *delivers* correctly.

---

## 2. Required access and credentials

| # | Requirement | Status | Notes |
|---|---|---|---|
| **A1** | GitHub App installation, **read** access to `ratchetnu/jkissllc` and `ratchetnu/supercharged` | present (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` in Preview) | The harness must use **read methods only** (`readFileContent`, tree/ref reads). See G3. |
| **A2** | J KISS **Preview** environment | present | `BOOKING_ASSIGNMENT_ENABLED`, `BLOB_STORE_ID`, Operion set already configured |
| **A3** | A `PlatformBusiness` record for `supercharged` readable from **Preview** Redis (`OperionPreview`) | ❓ **VERIFY FIRST** | If absent, seed it in **Preview only**. It is control-plane config, not customer data. |
| **A4** | An `UpdateCompatibility` record per rehearsal case | ❓ **VERIFY FIRST** | Needed to exercise `pathsToExclude`. Preview only. |
| **A5** | Vercel SSO browser session | present | Only if any admin surface is read; the harness itself needs none. |
| **A6** | Platform-owner Preview session | ❌ **NOT AVAILABLE** | Blocks the admin read-back in step E7 only. Everything else proceeds without it. **Do not create an account or handle a password to obtain it.** |

**Not required, and must not be used:** `OPERION_CALLBACK_SECRET` (no HTTP manifest call is made) · any Production credential · any Supercharged write token · any customer record.

---

## 3. Exact execution sequence

### E0 — Pre-flight state capture (S1)
Record and publish: J KISS `main` SHA · Supercharged `main` SHA · Supercharged branch list · Supercharged open PR list · Supercharged workflow-run list · Production deployment id. **This is the baseline O6 is proven against.**

### E1 — Build the read-only rehearsal harness (S3)
A script under `scripts/` (or `tools/`) that calls **`buildCommitTransferManifest` directly** — not through the HTTP route, so no job, no HMAC, no flags are involved.

Hard requirements:
- **Read-only provider wrapper.** Wrap the live provider so every non-read method (`createBranch`, `commitFiles`, `openPullRequest`, `dispatchWorkflow`, …) **throws immediately**. This is the primary safety mechanism — the harness must be structurally incapable of writing, not merely instructed not to.
- **Read counter.** Count every provider call, by method, per run → objective O5.
- Emit, per case: verdict · refusal message · manifest entry paths · every evidence array · `skippedModules` · truncation record.
- Writes nothing to Redis. Persists output to a local file only.

### E2 — Fixture selection (S3 proposes → coordinator approves before any run)
One real commit per gate. Proposed, to be confirmed against the repos:

| Case | Commit | Expected verdict |
|---|---|---|
| **C1** pass | `106846c0` (the intended canary, one file) | **built** |
| **C2** closure refusal | UPD-1004's source commit | **refused** — missing module |
| **C3** symbol refusal | `e014ad25` | **refused** — `session.ts` does not export `isPlatformOwner` |
| **C4** exclusion | any commit touching `app/lib/company.ts` or `app/quote/page.tsx` | **refused or excluded** — branding preserved |
| **C5** rename | a commit containing a rename | **refused** — renames rejected |
| **C6** drift | a commit whose target file has diverged | **refused** — three-way drift |

Every expected verdict is **written down and approved before the run.** A gate that produces the right answer for the wrong reason is a failure, not a pass.

### E3 — Dry-run C1 only (S3), coordinator reviews output before proceeding
Smallest case first. Confirm zero write-method calls, and that the read counter is sane.

### E4 — Run C2–C6 (S3)
One case at a time. Capture full output per case.

### E5 — Evidence shape check (S3)
For at least one `built` and one `refused` case, confirm the `TransferEvidence` record: contains no file contents, no content hashes, no secrets · `skippedModules` present with reasons (or provably empty) · truncation accounted if any list exceeds 250 · `targetBaseCommit` pinned.

### E6 — Read-amplification measurement (S3)
Report reads per run, by method, for the largest case → O5.

### E7 — Admin read-back **(OPTIONAL — blocked by A6)**
If and only if a platform-owner Preview session exists, `GET /api/admin/platform/automation/[id]` to confirm evidence renders. **Skip if unavailable. Its absence does not block P0.**

### E8 — Post-run proof of non-mutation (S1)
Re-capture everything from E0 and **diff against the baseline**. Any difference is a failure.

### E9 — Report (coordinator)
Publish results, verdict table, read counts, and the explicit list of what remains unproven.

---

## 4. Success criteria

**All must hold. Partial success is failure.**

| # | Criterion |
|---|---|
| **S1** | C1 returns **built**, with a manifest entry list exactly matching the approved expectation |
| **S2** | C2–C6 each return **refused**, each for the **specific gate they were chosen to trip** — verified by reading the refusal message, not by the boolean alone |
| **S3** | **Zero** provider write-method invocations across every run (harness counter = 0, and the read-only wrapper never threw) |
| **S4** | Supercharged post-state is **byte-identical** to the E0 baseline: same `main` SHA, same branch list, same PR list, **no new workflow run** |
| **S5** | J KISS `main` unchanged; **no Production deployment** triggered by this work |
| **S6** | No flag changed in any environment; no env var added, removed or edited in any scope |
| **S7** | `TransferEvidence` for both outcomes passes the E5 confidentiality and completeness check |
| **S8** | Read counts recorded and reported for every case |
| **S9** | No customer record read or written in any environment |

---

## 5. Failure criteria — stop immediately

**Any one of these halts the phase. Do not continue, do not retry, report to the coordinator.**

| # | Trigger |
|---|---|
| **F1** | **Any** write method reaches a provider — even one that throws. Investigate the call path before anything else. |
| **F2** | Any change to Supercharged: new branch, PR, commit, workflow run, or a moved `main` |
| **F3** | A gate returns the expected verdict for the **wrong reason** (message names a different cause) — a false pass is worse than a refusal |
| **F4** | A gate refuses a case expected to pass, and the cause is not understood |
| **F5** | Evidence contains file contents, content hashes, tokens, or anything not a path/count/status |
| **F6** | Truncation occurs and is **not** recorded in `truncated` |
| **F7** | Any Production deployment, flag change, or env change is observed, whatever the cause |
| **F8** | A job, branch, or dispatch is created anywhere |
| **F9** | Read volume is high enough to risk a rate limit or endpoint timeout — record and stop rather than pushing through |

---

## 6. Rollback plan

**By construction, there should be nothing to roll back — that is the design, not an assumption.** The harness cannot write; no job, branch, dispatch, or PR is created; no flag or env changes; Redis is untouched except for the E0-verified Preview seed records.

| Situation | Action |
|---|---|
| Harness misbehaves mid-run | Kill the process. Nothing partial persists — the harness writes only to a local file. |
| Preview seed records (A3/A4) need removing | Delete those specific Preview keys. **Preview Redis only.** Never touch Production Redis. |
| A Supercharged branch appears (F2) | **Stop everything.** Do not delete it — it is evidence. Report to the coordinator; deletion is an owner decision after root cause is known. |
| A Supercharged PR appears | Same: **stop, preserve, report.** Do not close it. |
| A job record appears in Preview Redis | Preserve it, report it. It proves an unintended orchestration path exists — a finding more valuable than a clean run. |
| J KISS Production deployment observed | `vercel rollback <pre-run production dpl> --yes`, captured at E0. Current: **`dpl_3vTAZXk82vMnWaVgzQyTKQbCkBZV`** |
| Anything unexplained | Stop. Preserve state. Report. **Do not "clean up" before the cause is understood** — cleanup destroys the evidence. |

---

## 7. Ownership split

| Session | Owns | Must not |
|---|---|---|
| **Coordinator** (this session) | Approving fixtures and expected verdicts **before** any run · reviewing E3 output before E4 proceeds · the final report · every merge decision | Write harness code |
| **Session 1** | E0 baseline capture · E8 post-run non-mutation proof · read-only observation of both repos | Touch `app/lib/platform/**`; run the harness |
| **Session 3** | E1 harness (implementation) · E2 fixture proposal · E3–E6 execution · raw output | **Merge anything** · approve its own fixtures · change any gate's logic · write to Supercharged · create a job/branch/dispatch · touch flags, env, or Production |
| **Session 2** | Not involved. Continues booking-lane work on `main` `126a101`. | Participate in P0 |

**Merge discipline unchanged:** Session 3 opens PRs; the **coordinator** reviews and merges. The harness itself is a PR like any other and follows the same path.

---

## 8. What P0 unlocks, and what it does not

A clean P0 justifies proceeding to the canary discussion. It does **not** authorise the canary.

The canary still requires, as separate owner decisions:
1. **Production flag enablement** on the J KISS control plane — `OPERION_AUTOMATION_ENABLED` + `OPERION_PREVIEW_AUTOMATION_ENABLED` + `OPERION_GITHUB_ACTIONS_ENABLED`. This is a **Production write**, and it is unavoidable: `preflight.ts:34` blocks dispatch from Preview by design. The long-flagged contradiction between "dispatch the canary" and "keep all automation flags OFF" resolves **here**, and only by owner decision.
2. **Authorisation to write to Supercharged** (branch + PR on Preview).
3. A `DeploymentRecord` verification step that has never once been exercised.

**Status: awaiting approval. Nothing executes until the coordinator approves the fixture table.**
