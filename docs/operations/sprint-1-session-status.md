# Operion Sprint 1 — Shared Session Status

**Coordinator:** lead session · **Opened:** 2026-07-22 · **Authority:** this file is the single source of truth for session ownership. `OPERION_CURRENT_STATE.md` is the engineering handoff; where the two disagree on a SHA or a PR state, **this file wins** (it was verified later).

> Every session MUST re-read this file before its first write, and update its own row after every increment. Do not edit another session's row.

---

## 🔴 FREEZE — `main` `c791d4e` IS BLOCKED FOR NEW FEATURE WORK (2026-07-22)

**A regression from merged PR #47 is confirmed on the pre-existing route lane. It is NOT flag-suppressed.**

### Status by session — effective immediately

| Session | Status | Permitted |
|---|---|---|
| **S1** | ✅ **AUTHORIZED — hotfix only** | Prepare **one narrow isolated hotfix PR** against `app/lib/schedule/conflicts.ts` + its tests. Nothing else. No worktree pruning, no branch deletion, no stash, no unrelated edits. |
| **S2** | ⛔ **READ-ONLY — PAUSED** | No source writes. No branch commits. Wait for the corrected `main` SHA to be published in this section. |
| **S3** | ⛔ **READ-ONLY — PAUSED** | No source writes. No Supercharged writes. No transfer dispatch. Wait for the corrected `main` SHA. |

**Do not rebase onto `c791d4e`.** A corrected SHA will be published here. Sessions are released only by the coordinator, in this file.

### The regression — coordinator-verified independently

`app/lib/schedule/conflicts.ts:171`, changed by #47:

```diff
- if (it.lane === 'confirmed' && it.scheduled && it.crew.length === 0) {
+ if (it.lane === 'confirmed' && it.scheduled && !it.crewComplete) {
```

`detectConflicts` runs over the **unified** item list — bookings *and* routes. In `unified.ts`:

- `routeToScheduleItem:272` → `lane = r.status === 'draft' ? 'pending' : 'confirmed'` — every non-draft route is `'confirmed'`
- `routeToScheduleItem:310` → `crewComplete = (r.assignees?.length ?? 0) > 0 && !gap.incomplete`

So a **scheduled non-draft route with one assigned driver and an incomplete crew gap** has `crew.length === 1` but `crewComplete === false`:

| | pre-#47 (`crew.length === 0`) | post-#47 (`!crewComplete`) |
|---|---|---|
| Route, 1 driver, gap incomplete | `false` → no conflict | **`true` → emits `missing_crew`** ❌ |

The emitted message is also factually false: *"…is confirmed for {date} with no crew assigned."* — about a route that **has** a driver.

**Why the flag does not suppress it:** #47 added `BOOKING_ASSIGNMENT_ENABLED` gating **only inside `bookingToScheduleItem`**. `routeToScheduleItem` was not touched and has no flag path. The route lane therefore changed behavior with the flag OFF ⇒ **the merge was not fully inert.** Severity is `warning` (not `error`), and the surface is admin-facing, but it is spurious noise on a live lane and it can mask genuine warnings.

**Test gap:** the full suite passed 1856/1856 through this change. No test covers a partially-crewed route against `missing_crew`. The hotfix must add one.

### Required hotfix shape (coordinator's independent analysis — S1 may propose better)

A single condition restores routes exactly while **preserving #47's valid booking-side fix**:

```ts
if (it.lane === 'confirmed' && it.scheduled && it.crew.length === 0 && !it.crewComplete) {
```

| Case | `crew` | `crewComplete` | pre-#47 | post-#47 | with fix |
|---|---|---|---|---|---|
| Route, 1 driver, gap incomplete | 1 | false | none | **missing_crew** ❌ | none ✅ restored |
| Route, 0 assignees | 0 | false | missing_crew | missing_crew | missing_crew ✅ |
| Route, full crew | 2 | true | none | none | none ✅ |
| Booking flag-OFF, roster hidden, legacy `assignedTo` set | 0 | true | missing_crew (false positive #47 fixed) | none | **none ✅ #47's fix preserved** |
| Booking, genuinely uncrewed | 0 | false | missing_crew | missing_crew | missing_crew ✅ |

For routes the added clause is provably a no-op (`crew.length === 0` ⇒ `assignees === 0` ⇒ `crewComplete === false`), so **route behavior becomes byte-identical to pre-#47**. Only the booking lane keeps #47's improvement.

**Reverting all of #47 is NOT authorized** unless this narrow fix cannot preserve the booking-side changes. On the above analysis it can.

### Merge criteria for the hotfix — all must hold

route behavior restored · booking flag-off behavior still correct · full suite · `tsc` · ESLint · AI regression · `npm run build` · Preview green · all flags OFF · no env var changed.

---

## 🔴 Blocking activation defects — Blob readiness (S2 read-only audit, coordinator-recorded)

Both are **blocking for booking-assignment Production activation**. Neither is being fixed yet.

| # | Defect | Location | Consequence |
|---|---|---|---|
| **BLOB-1** | Crew upload route **fails closed** when `BLOB_STORE_ID` is absent | `app/api/portal/upload/route.ts:34-37` — throws `blob_store_not_configured` | Every crew completion upload → HTTP 400 → generic "Upload failed" in the field, the moment the flag is turned on |
| **BLOB-2** | Photo validation **degrades to a host-suffix floor** when `BLOB_STORE_ID` is absent | `app/lib/job-assignment.ts:313-316`; `scripts/job-assignment.test.ts:310` asserts a Preview-store URL passes | A **Production** record can reference **Preview-hosted** bytes |

Store IDs verified live: Production `jkiss-invoice-photos` = `store_WK8DoJzb2Q1lu5sv`; Preview `operion-preview-blob` = `store_Ulabe9q3GBD8ZYQh`.

**Standing restrictions:** ⛔ Production `BLOB_STORE_ID` write **NOT approved** — owner decision pending. ⛔ Booking-claims implementation **NOT authorized** (answers S2's B-3: it stays Sprint 3 scope, do **not** start). ⛔ `BOOKING_ASSIGNMENT_ENABLED` stays **OFF** throughout.

### Agreed sequence

1. Merge + verify the narrow #47 route-conflict hotfix ← **in progress**
2. Publish the corrected `main` SHA here
3. Update the ownership map
4. Assign BLOB-1 + BLOB-2 as **one narrow isolated increment** — only if file ownership is disjoint (coordinator verifies before assigning)
5. Validate that increment in **Preview**
6. Run the full booking-assignment **Preview E2E**
7. **STOP for owner approval** before setting Production `BLOB_STORE_ID`
8. `BOOKING_ASSIGNMENT_ENABLED` OFF throughout

---

## ✅ MERGE RECORD — Sprint 1 authorized sequence COMPLETE (2026-07-22 16:19Z)

`origin/main`: `ee577c2` → **`c791d4e`**. Two merges, owner-authorized, executed one at a time.

| # | PR | Merge commit | Merged | Production deployment | Status |
|---|---|---|---|---|---|
| 1 | **#52** dependency preflight | **`b015564`** | 16:15:01Z | `dpl_FfyYpLokVu1qNynihWtvgSFviM5a` | ● Ready |
| 2 | **#47** rollback inertness | **`c791d4e`** | 16:19:03Z | `dpl_DTjcqRv266kP41oAoGPWC39gYzPY` | ● Ready, aliased to jkissllc.com |

**Pre-merge rollback target (production before the sequence):** `dpl_DFTgafHN2JemUBQmktwqzHHkMMxW`

### Exact rollback commands

```bash
# Fastest: repoint the production alias. No rebuild, no code change.
vercel rollback dpl_DFTgafHN2JemUBQmktwqzHHkMMxW --yes    # undo BOTH merges
vercel rollback dpl_FfyYpLokVu1qNynihWtvgSFviM5a --yes    # undo #47 only, keep #52

# Durable: revert the merge commits (redeploys automatically; reverse order)
git revert -m 1 c791d4e    # revert #47
git revert -m 1 b015564    # revert #52
```

### Verified after the sequence

- Full suite **1854/1854** on #52; **1856/1856** + `tsc` clean on the #47 **merge result** (tested against the new `main`, not the branch in isolation)
- Total delta `ee577c2..c791d4e` = **exactly 12 files**, `+880/−22` — the 8 from #52 plus the 4 from #47, nothing else
- **`app/lib/platform/flags.ts` is not in the diff** — no flag default can have changed
- No `vercel.json` / `.env` / workflow file touched
- Production: `/` → **200** · `/api/admin/platform/updates` → **401** · `/api/automation/manifest` → **405**
- `BLOB_STORE_ID` still **absent** in Production (0 occurrences) — not set, per instruction
- `BOOKING_ASSIGNMENT_ENABLED` still **absent** in Production — defaults `false`
- **UPD-1004 not retried**: last `Operion Update` run was `2026-07-22T05:26:27Z` (failure), ~11h *before* the sequence; **zero** Supercharged workflow runs after 16:00Z; no `operion/upd-1004` branch exists; no new Supercharged PR
- Stashes untouched: 2 in J KISS, 1 in Supercharged
- **No worktree pruned. No branch deleted.**

### PRs closed as superseded

| PR | Disposition |
|---|---|
| **#33** | Closed. Evidence preserved: full 42KB patch + file-by-file comparison at `docs/operations/superseded/`. ⚠️ **Only partially superseded** — see follow-up below. |
| **#29** | Closed, superseded by `OPERION_CURRENT_STATE.md`. |

**Open follow-up from #33:** `app/lib/platform/automation/target-policy.ts` + its test were never merged and nothing on `main` replaces them. `pathsToExclude` (#49) is per-update owner *configuration* that **fails open** when a path is omitted; the target policy is a categorical role-derived boundary that **fails closed**. Re-raise as a fresh additive PR carrying only those two files plus one call site.

**Remaining open PRs: #38, #43** — both deliberately not merged.

### ⚠️ Concurrent sessions are LIVE — rebase your base

Two worktrees appeared during the sequence that the coordinator did not create:

- `/Users/nunubabymuzik/jkissllc-booking-prod` @ `c791d4e` [`codex/sprint1-booking-prod-readiness`] — **Session 2 has started** and correctly adopted the ownership map's branch name.
- `/private/tmp/claude-501/…/a800b6d9-…/scratchpad/verify-main` @ `c791d4e` (detached) — a different session verifying the merged main.

**Base correction for S2 and S3:** §3 originally told you to stack on the PR heads `fa4b028` / `1e80da5`. Those PRs are now **merged**. Branch directly off `origin/main` = **`c791d4e`** instead. Session 2 already did this correctly.

---

## 0. Ground truth (verified 2026-07-22, post-fetch)

| Fact | Handoff said | **Verified reality** |
|---|---|---|
| J KISS `origin/main` | `ee577c2` | `ee577c2` ✅ confirmed |
| J KISS **local** `main` | — | `a5f647d` — **41 commits behind**, clean fast-forward, no divergence |
| J KISS primary worktree `/Users/nunubabymuzik/jkissllc` | — | on `codex/operion-dependency-closure` `c82744b` — **already merged (PR #51)**, **18 untracked files** |
| Supercharged `origin/main` | `52d50b7` | `52d50b7` ✅ confirmed |
| Supercharged **local** `main` | — | `c619920` — **2 commits behind** origin/main |
| Supercharged stale `jkiss/main` remote | "must never be merged" | **already removed** — only `origin` remains. Risk closed. |
| Worktrees (J KISS) | 25, "~13 merged" | **25 total — 20 are on branches already merged into `origin/main`** |
| Worktrees in `/private/tmp/` | "several" | **8** — volatile, lost on reboot |
| Stashes | "two unexplained" | **two** in J KISS (`codex/operion-vercel-rollback-api`) **+ a third in Supercharged** on `main`: `wip next-env before parity migration` |
| `BLOB_STORE_ID` in J KISS Production | absent (P1 #1) | **absent — confirmed** (names-only listing; no values read) |
| `BOOKING_ASSIGNMENT_ENABLED` in Production | absent ⇒ false | **absent — confirmed correct** |

### Open PR reality check (all checks green unless noted)

| PR | Branch | Mergeable | Files | Domain |
|---|---|---|---|---|
| **#52** | `codex/operion-dependency-preflight` | **CLEAN** | 8 — `platform/automation/{orchestrator,preflight}.ts`, `updates/policy.ts`, 2 admin routes, admin page, 2 tests | **S3** |
| **#47** | `codex/operion-sprint1-flag-projection` | **CLEAN** | 4 — `schedule/conflicts.ts`, `schedule/unified.ts`, 2 booking tests | **S2** |
| **#38** | `feat/obs-provider-failstage` | **CLEAN** | 4 — `ai/junk-analysis.ts`, `ai/service.ts`, `observability/pipeline-trace.ts`, 1 test | **S1** (orphan, no domain conflict) |
| **#43** | `codex/sites-by-nu-branding` | **CLEAN** | 3 — home footer + credit component + png | **S1** (cosmetic, owner decision) |
| **#33** | `codex/operion-target-boundary-enforcement` | **CONFLICTING / DIRTY** | 9 — incl. `manifest-builder.ts`, `preflight.ts`, `operion-apply.mjs` | **S3 triage → S1 executes** |
| **#29** | `docs/operion-roadmap-update` | CLEAN | 1 doc | **S1** — close, superseded |

**The four mergeable PRs (#52, #47, #38, #43) have completely disjoint file footprints.** They cannot conflict with each other.

**#33 is conflicting because it rewrites `manifest-builder.ts` / `operion-apply.mjs`, which merged PRs #49/#50/#51 already replaced, and it collides with #52 on `preflight.ts`.** It is superseded, not merely stale.

---

## 1. 🔴 BLOCKING DECISION — owner approval required before any merge

**J KISS auto-deploys Production on every push to `main`** (Vercel Git integration, project `jkissllc`, `prj_KkbKoiRYHJOvppR6vco5JI1W11fr`).

Therefore **merging PR #52 or #47 is a Production write**, and the standing rule is *no Production write without explicit owner approval*. This is true even though every relevant flag is OFF and the change is functionally inert in Production.

**Nothing merges until the owner says so.** Until then all three sessions are restricted to read-only / branch-local work.

Second approval needed, independently: **setting `BLOB_STORE_ID=store_WK8DoJzb2Q1lu5sv` in the Production scope** (P1 #1/#2). That is a secret-scope write to Production.

---

## 2. Session ownership map

Ownership is by **file path**, not by intent. A session may only write paths in its own domain. Overlap = stop and escalate to the coordinator.

### SESSION 1 — Repository cleanup & PR integration

| | |
|---|---|
| **Branch / worktree** | Operates on **git metadata only**. Admin worktree: `/Users/nunubabymuzik/jkissllc-integration` on `integration/sprint-1-cleanup` (to be created, off `origin/main`). |
| **Owned paths** | **No application source files.** Owns: worktree registry, local/remote branch refs, stash refs, PR state (merge/close/label), issue state. Owns this status file's §0 and §3. |
| **Explicitly NOT owned** | Any file under `app/`, `scripts/`, `tools/`, `docs/`. S1 merges other sessions' work; it never authors it. |
| **Current task** | T1.1 fast-forward local `main` → `origin/main`. T1.2 preserve the 18 untracked files in the primary worktree (see §4 hazard). T1.3 prune the 20 merged worktrees + branches. T1.4 close #29; close #33 on S3's written recommendation. T1.5 stash triage (record contents, do not apply). |
| **Commit SHA** | — not started |
| **Test status** | n/a until a merge is authorized; full suite required before each merge |
| **Blockers** | **B-1 (owner approval for Production deploy)** blocks all merge tasks. Cleanup tasks T1.1–T1.3, T1.5 are unblocked. |
| **Merge readiness** | Blocked on B-1 |

### SESSION 2 — Booking assignment production readiness

| | |
|---|---|
| **Branch / worktree** | `/Users/nunubabymuzik/jkissllc-booking-prod`, branch `codex/sprint1-booking-prod-readiness`, **based on PR #47 head `fa4b028`** (not `main`) — see §3 sequencing. |
| **Owned paths** | `app/lib/job-assignment.ts` · `app/lib/bookings.ts` · `app/lib/booking-*.ts` · `app/lib/schedule/**` · `app/lib/crew-timeclock.ts` · `app/portal/**` + `app/api/portal/**` · `app/api/admin/bookings/**` · claims modules · `scripts/booking-*.test.ts`, `scripts/job-assignment.test.ts`, `scripts/portal-presigned-upload.test.ts` · `docs/operations/` booking-activation docs |
| **Explicitly NOT owned** | `app/lib/platform/**`, `scripts/operion-apply.mjs`, `tools/product-sync/**` (S3) · Supercharged repo (S3) · any git-admin action (S1) |
| **Current task** | T2.1 (read-only) re-verify the three P1 defects against reality — `BLOB_STORE_ID` absence confirmed; re-run the §4 #2 cross-store-URL probe; re-confirm `customerView` strips `assignees`. T2.2 draft the Production activation gate list. **No source writes until B-1 resolves.** |
| **Commit SHA** | — not started |
| **Test status** | baseline to establish: `npm test` on `fa4b028` |
| **Blockers** | **B-1** (merge of #47) · **B-2** owner approval for the `BLOB_STORE_ID` Production write · **B-3** claims do not read booking assignments (Sprint 3 scope — out of scope here, do not start) |
| **Merge readiness** | Not ready — PR #47 must land first |

### SESSION 3 — Supercharged automated transfer preparation

| | |
|---|---|
| **Branch / worktree** | J KISS: `/Users/nunubabymuzik/jkissllc-transfer-prep`, branch `codex/sprint1-transfer-prep`, **based on PR #52 head `1e80da5`**. Supercharged: `/Users/nunubabymuzik/supercharged-transfer-prep`, branch `codex/sprint1-transfer-target-prep` off SC `origin/main` `52d50b7`. |
| **Owned paths** | `app/lib/platform/**` (updates, automation, closure, preflight, orchestrator, providers) · `app/api/admin/platform/**` · `app/api/automation/**` · `app/admin/operations/platform/**` · `scripts/operion-apply.mjs` · `scripts/{manifest-builder,dependency-closure,platform-*,preflight-*,required-updates,github-provider}.test.ts` · `tools/product-sync/**` · **the entire Supercharged repo** |
| **Explicitly NOT owned** | Booking/schedule/portal/claims paths (S2) · git-admin actions (S1) |
| **Current task** | T3.1 (read-only) write the **#33 triage recommendation** (close vs. rebase) with evidence — hand to S1. T3.2 draft the `UPD-1004` split into `UPD-A` / `UPD-B` with explicit `dependencies[]` and `pathsToExclude[]`. **UPD-1004 itself is never retried.** T3.3 specify the §4 #7 audit-trail persistence. **No source writes until B-1 resolves.** |
| **Commit SHA** | — not started |
| **Test status** | baseline to establish: `npm test` on `1e80da5` (handoff claims 1854/1854) |
| **Blockers** | **B-1** (merge of #52) · **B-4** Supercharged has never completed a full Operion Preview E2E — Preview-only flag enablement is Sprint 2, needs its own approval · **B-5** SC local `main` is 2 behind `origin/main` |
| **Merge readiness** | Not ready — PR #52 must land first |

### Overlap analysis — verdict

| Pair | Shared paths | Verdict |
|---|---|---|
| S1 ↔ S2 | none (S1 owns no source) | ✅ may run concurrently |
| S1 ↔ S3 | none (S1 owns no source) | ✅ may run concurrently |
| S2 ↔ S3 | none — `schedule/**`+`bookings` vs `platform/**` are disjoint; PR #47 and #52 file lists do not intersect | ✅ may run concurrently |

**No session is stopped for overlap.** All three are gated instead on the single Production-deploy approval (B-1).

---

## 3. Sequencing rule (why S2/S3 do not branch off `main`)

`origin/main` = `ee577c2` does **not** contain #47 or #52. If S2 branched off `main` and edited `schedule/unified.ts`, it would conflict with #47 the moment #47 merged. Same for S3 and `preflight.ts` / #52.

So each session **stacks on its own pending PR**:

```
origin/main ee577c2
├── #47 fa4b028 ──► S2 branch codex/sprint1-booking-prod-readiness
└── #52 1e80da5 ──► S3 branch codex/sprint1-transfer-prep
```

After S1 lands #47 and #52, both sessions rebase onto the new `main` — a no-op rebase, since their base commits become ancestors of `main`.

**Merge order when B-1 clears:** #52 → verify main green → #47 → verify main green → then #38, then #43 (owner's call). One merge at a time; re-check `origin/main` before each.

---

## 4. Active hazards

| # | Hazard | Owner | Action |
|---|---|---|---|
| **H-1** | **`OPERION_CURRENT_STATE.md` is UNTRACKED and uncommitted** — it exists only in the working tree of `/Users/nunubabymuzik/jkissllc`. Any `git clean` destroys the authoritative handoff. 17 other untracked deliverables sit beside it (guides, PDFs, sprint-1 validation docs, `scripts/observability-verify.mjs`). | S1 | Back these up **before** any cleanup, and commit them on a docs branch. **Never run `git clean` in the primary worktree.** |
| **H-2** | The **primary worktree is on an already-merged branch** (`codex/operion-dependency-closure`). It looks like live work and is not. | S1 | Do not delete this branch while it is checked out. Move the primary worktree to `main` only after H-1 is resolved. |
| **H-3** | **8 worktrees live in `/private/tmp/`**, including the ones holding PR #52 and #47 heads. A reboot destroys them. | S1 | The PR branches exist on `origin` — recoverable. Recreate S2/S3 worktrees under `$HOME`, never `/private/tmp/`. |
| **H-4** | **Three stashes**, all unexplained (2 J KISS + 1 Supercharged). | S1 | Record `git stash show -p` output to a file. **Do not apply.** |
| **H-5** | **Concurrent-session hazard is real** — the primary worktree was dirty at audit time. | all | Re-check `git status` + mtimes immediately before every write. |
| **H-6** | New worktrees need `node_modules` as an **APFS clone** (`cp -c -R`), not a symlink — Turbopack rejects symlinks. | S2, S3 | Apply at worktree creation, before running tests. |

---

## 5. Standing rules in force

1. Never merge J KISS and Supercharged histories — unrelated histories, content-based sync only.
2. **Do not retry `UPD-1004`.** It gets split into ordered prerequisite updates instead.
3. Every Operion and booking-assignment flag stays **OFF**.
4. No Production write — deploy, env var, or promotion — without explicit owner approval.
5. Do not apply any stash.
6. Do not delete a branch without proven merged status **and** worktree safety.
7. Focused tests after every increment; **full suite before every merge**.
8. Re-check `origin/main` before every write, push, and merge.
9. No unrelated feature work.

---

## 6. Change log

| When | Who | What |
|---|---|---|
| 2026-07-22 | coordinator | Audit complete; ownership map published; all sessions gated on B-1. |
