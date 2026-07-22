# Operion — Current State & Engineering Handoff

**Audited:** 2026-07-22 · **Auditor:** automated engineering agent · **Purpose:** allow another AI engineering agent to take over Operion development with no prior context.

**Scope of this document:** the Operion platform as it runs for two real businesses — **J KISS LLC** (source of truth) and **Supercharged** (target). Enterprise/multi-tenant SaaS expansion is explicitly *deferred*; everything below is oriented to daily internal operations.

> **Ground truth at audit time**
> J KISS `main` = `ee577c2` · Supercharged `main` = `52d50b7`
> J KISS tests **1830/1830** · Supercharged tests **469/469** · both TypeScript-clean
> J KISS Production **Ready** · Supercharged Production serving prior Ready build
> **Operion automation flags are provisioned and enabled in Production; the actions they
> gate stay behind explicit owner approval.** The master switch `OPERION_AUTOMATION_ENABLED`
> is ON in the Production runtime (audited 2026-07-22 via the Release Center's resolved
> state), alongside the preview-automation and GitHub-Actions flags. What is *gated* — not
> off — is every side-effecting action: cross-business transfer, Preview canary, and
> Production promotion each require a staged owner approval and typed confirmation. As a
> result **no automated Production transfer has ever executed** — 0 `approved_production`
> jobs, 0 promotions, 0 publish/rollback records. Separately, J KISS Production keeps
> deploying normally through its **own Vercel Git integration** (a push to `main` builds and
> promotes, as it always has); that path is independent of Operion release automation. See
> §7 and §9.

---

## 1. Architecture overview

### 1.1 The two products

| | J KISS LLC | Supercharged |
|---|---|---|
| Repo | `ratchetnu/jkissllc` | `ratchetnu/supercharged` |
| Local | `/Users/nunubabymuzik/jkissllc` | `/Users/nunubabymuzik/supercharged` |
| Vercel project | `jkissllc` | `supercharged` |
| Role | **source** of platform changes + a live moving/junk-removal business | **target** — a branded sibling running the same platform |
| Git relation | — | **unrelated histories.** Never `git merge` between them. Sync is content-based. |

Supercharged is a *branded copy*, not a fork you can rebase. It has its own branding, its own customers, and files that legitimately diverge (`app/lib/company.ts`, `app/quote/page.tsx`). **Any change that overwrites those is a regression, not an update.**

### 1.2 Runtime stack

- **Next.js 16.2.2** App Router (`app/`), React 19, TypeScript strict, Turbopack.
  `AGENTS.md` requires reading `node_modules/next/dist/docs/` before writing Next.js code — this version has breaking changes vs. common training data.
- **Vercel** hosting; Node 24 runtime; Fluid Compute.
- **Upstash Redis** (via `app/lib/redis.ts`) — *all* persistence. There is no SQL database.
- **Vercel Blob** — photos and documents.
- **AI** through the Vercel AI Gateway (`ai@^7`), used for the Book Now photo-estimation pipeline.
- **Stripe** payments, **Twilio** SMS, **Resend** email.

### 1.3 The four subsystems

```
┌─ Business operations (live, in daily use) ──────────────────────┐
│  Book Now intake → AI photo estimate → quote → booking →        │
│  crew assignment → crew portal execution → pay statements       │
└─────────────────────────────────────────────────────────────────┘
┌─ Operion control plane (built; flags on, actions gated) ────────┐
│  Update registry → compatibility → preflight → commit transfer  │
│  → GitHub Actions on the target → Preview → owner approval      │
│  → production promotion → rollback                              │
└─────────────────────────────────────────────────────────────────┘
┌─ Product sync ledger (merged, advisory) ────────────────────────┐
│  tools/product-sync/ — 16 registry entries tracking which       │
│  platform improvements have reached Supercharged                │
└─────────────────────────────────────────────────────────────────┘
┌─ Observability / AI telemetry (built, flag-gated) ──────────────┐
│  Per-stage pipeline tracing, cost accounting, latency dashboard  │
└─────────────────────────────────────────────────────────────────┘
```

### 1.4 Operion control-plane data model

All in Redis, all versioned records (`app/lib/platform/updates/types.ts`):

| Record | Key | Meaning |
|---|---|---|
| `PlatformUpdate` | `UPD-####` | one platform change: source repo + **source commit**, risk flags, validation checklist, `dependencies[]` |
| `PlatformBusiness` | e.g. `supercharged` | a target: repo, default branch, GitHub App installation, Vercel Preview project, automation mode |
| `UpdateCompatibility` | update × business | owner's assessment: status, `pathsToExclude[]` (machine-enforced), `componentsToExclude[]` (prose) |
| `UpdateAutomationJob` | `AUTO-####` | one transfer attempt; idempotency key = `business:update:sourceCommit` |
| `DeploymentRecord` | `dep_*` | what actually landed on a target; carries `verificationStatus` |

### 1.5 The transfer pipeline (the part most recently hardened)

`app/lib/platform/automation/manifest-builder.ts` is the chokepoint. Order matters and is load-bearing:

```
1. compatibility status must be compatible | compatible_with_changes   ← PR #49
2. resolve refs: source commit (+ first parent) and target branch → pinned targetBaseCommit
3. validate + apply pathsToExclude                                     ← PR #49
4. refuse renamed files                                                ← PR #50
5. DEPENDENCY CLOSURE — every local import must exist in the manifest
   or on the target (existence only, never content)                    ← PR #51
6. per-file THREE-WAY DRIFT: source-baseline vs source-new vs target   ← PR #50
7. build manifest + contents → signed response incl. targetBaseCommit
```

The CI runner (`scripts/operion-apply.mjs`, copied into each target repo) then verifies `git rev-parse HEAD === targetBaseCommit` **before writing any file** — the TOCTOU handshake (J KISS PR #50 + Supercharged PR #14).

**Design principle throughout: detect and refuse; never auto-complete.** Auto-closing the last failed update would have grown a 41-file transfer to 59 files, silently shipping three unrelated subsystems under one approval.

---

## 2. Completed features

### 2.1 Business operations (live in Production)

| Feature | Notes |
|---|---|
| Book Now intake + AI photo estimation | durable job queue, retries, shadow evaluation, manual-review path |
| Quote → booking → payment | Stripe + Zelle w/ sealed proof, promo codes, deposits/balances |
| Customer confirmation flow | inventory confirmation, second AI analysis, reschedule, cancel, review |
| Crew portal | login, routes, clock in/out with GPS, documents, availability, time off, pay |
| Contract routes lane | roster crew, per-person pay snapshots, equipment, completion proof |
| Pay statements | deterministic engine, immutable snapshots, claim deductions, PDF + email, public `/verify` |
| Unified schedule | bookings + routes in one projection with cross-lane conflict detection |
| Admin operations shell | Apple-style nav, Book Now queue, AI Command Center, Release Center |
| Multi-tenant foundation | built and merged, **flag-off** (`TENANCY_ENABLED=false`) |

### 2.2 Operion Sprint 1 — booking ↔ crew join (merged, flag-off in Production)

The Routes lane and the Bookings lane were never joined; a customer booking could not be crewed, clocked, or paid. Merged 2026-07-22 across PRs #42, #44, #45, and (pending) #47:

- Staff-linked crew + equipment on bookings (`BOOKING_ASSIGNMENT_ENABLED`)
- Crew portal "My Jobs" — accept/decline, clock, completion photos via presigned Blob upload
- Booking work reaches **payroll** (status-gated, `effectiveServiceDate`, no cross-store photo leaks)
- **Attributed audit ledger** for all nine assignment actions — no GPS, no tokens, no customer data in metadata
- Customer-facing data minimised: `customerView` strips `assignees` entirely

### 2.3 Operion transfer safety (merged 2026-07-22)

| PR | Gate | What it prevents |
|---|---|---|
| #49 | `pathsToExclude` enforcement + compatibility fail-closed | branded files being overwritten; a missing compat record silently disabling exclusions |
| #50 | three-way target drift + rename refusal + `targetBaseCommit` handshake | overwriting or **downgrading** a target-owned file; a moved branch racing the transfer |
| SC #14 | runner-side checkout verification | applying a manifest to a tree that moved |
| #51 | dependency closure | transferring files whose imports do not exist on the target |

These were driven by a real incident (issue #48) and each is verified against the real artefacts.

### 2.4 Platform infrastructure (merged, flag-off)

AI telemetry + cost accounting · AI pipeline observability (per-stage latency) · AI latency Phase 2 (critic dedup, event-driven recovery, due-job index) · AI image optimization · calibrated customer progress UX · product-sync ledger (16 registry entries) · Release Center with approval + publish + rollback + history.

---

## 3. Features in progress

| Item | Where | State |
|---|---|---|
| **Phase B: required updates + pre-dispatch transfer gate** | J KISS PR **#52** (`codex/operion-dependency-preflight`) | **Open, awaiting review.** 1854/1854, build passes. Adds `required_updates` + `transfer_ready` preflight gates so no job/branch/dispatch happens for an incomplete update. |
| **Assignment rollback inertness** | J KISS PR **#47** | Open, reviewed, approve-recommended. Makes flag-off genuinely inert on the unified schedule. |
| **Provider fail-stage observability** | J KISS PR **#38** | Open since 2026-07-20. Already synced to Supercharged (SC PR #7 merged) — J KISS side is the laggard. |
| **Managed-target transfer boundary (Stage 2A)** | J KISS PR **#33** | Open since 2026-07-20, superseded in part by #49/#50/#51. **Needs triage: close or rebase.** |
| **Sites By Nu branding credit** | J KISS #43 / SC #13 | Open, cosmetic, independent of Operion. |
| **Roadmap doc update** | J KISS PR **#29** | Open since 2026-07-19, stale — supersede with this document. |

---

## 4. Remaining bugs and known defects

Ordered by consequence. None is currently reachable in Production because the relevant flags are off.

### P1 — must fix before enabling anything in Production

| # | Defect | Location | Evidence |
|---|---|---|---|
| 1 | **`BLOB_STORE_ID` absent in Production.** Crew completion uploads fail closed (`blob_store_not_configured` → HTTP 400 → generic "Upload failed" in the field). | Vercel env, Production scope | verified via `vercel env ls production` |
| 2 | **Production accepts cross-store photo URLs.** With no `BLOB_STORE_ID`, `isCompletionPhotoUrl` falls back to the host-suffix floor, so a Production record can reference preview-store bytes. | `app/lib/job-assignment.ts` | one-directional; the same env fix closes it |
| 3 | **Booking `assignees` reach the customer *if* PR #47's sibling issue recurs.** Fixed in #45 (`customerView` strips it) — **re-verify after any change to `CustomerBooking`.** | `app/lib/bookings.ts` | regression test exists |

### P2 — operational hazards

| # | Defect | Notes |
|---|---|---|
| 4 | **Re-assessing compatibility without `pathsToExclude` used to wipe it** — fixed in #49 (`resolveDependencies`/`resolvePathsToExclude` PATCH semantics). Verify the same pattern is applied to any new list field. |
| 5 | **Rollback leaves a `missing_crew` warning** on crewed bookings (severity *warning*, was three *errors* before PR #47). Document in the rollback checklist or suppress. |
| 6 | **Read amplification in the drift loop** — 2–3× sequential GitHub reads per file (≈123 serial calls for a 41-file update). Latency/timeout exposure on the manifest endpoint. |
| 7 | **Audit trail is incomplete.** `driftCheckedPaths`, `closureCheckedPaths`, `excludedPaths` and the transfer manifest are all computed server-side and **never persisted** to the job record. An incident review currently requires forensic git archaeology. |
| 8 | **Directory exclusion impossible** — `pathsToExclude` matches exact paths only, so `docs/opspilot-os/**` must be enumerated and a newly-added file transfers silently. |
| 9 | **A component label passes write validation** (`jkiss-logo` is a structurally valid path) and fails late at manifest build with a confusing message. |
| 10 | **Booking pay/hours reach payroll but claims do not.** `claims` still read routes only. |

### P3 — quality and hygiene

- `parentCount` plumbed through the provider but never consulted.
- `isSafeRepoPath` duplicated across five call sites including `operion-apply.mjs`.
- Symlinks/submodules unmodelled by the transfer gates (would be written as regular files).
- Three pre-existing `display:none` file inputs (WCAG 2.1.1) recorded in `scripts/wizard-a11y.test.ts` `KNOWN_GAPS`.
- `componentsToExclude` still silently truncates at 40 entries.
- Job status is not checked at manifest fetch — a terminal job can re-request its manifest.

---

## 5. Open PRs

### J KISS (`ratchetnu/jkissllc`)

| PR | Branch | Age | Recommendation |
|---|---|---|---|
| **#52** | `codex/operion-dependency-preflight` | new | **Review and merge next.** Completes issue #48 Phase B. |
| **#47** | `codex/operion-sprint1-flag-projection` | 1d | Approve-recommended; merge to make assignment rollback inert. |
| **#38** | `feat/obs-provider-failstage` | 2d | Small; already live on Supercharged. Merge or close. |
| **#33** | `codex/operion-target-boundary-enforcement` | 2d | **Triage.** Largely superseded by #49/#50/#51. |
| **#43** | `codex/sites-by-nu-branding` | 1d | Cosmetic; owner decision. |
| **#29** | `docs/operion-roadmap-update` | 3d | **Close** — superseded by this document. |

### Supercharged (`ratchetnu/supercharged`)

| PR | Branch | Recommendation |
|---|---|---|
| **#13** | `codex/sites-by-nu-branding` | Cosmetic; pair with J KISS #43. |

### Open issues

| Issue | Subject | State |
|---|---|---|
| **#48** | UPD-1004 transfer failure — root-cause audit | P1-2 (drift) and P1-3 (exclusions) **closed**; P1-1 (dependency closure) closed by #51 at build time, **Phase B in PR #52**. Keep open until #52 merges. |
| **#46** | Booking-assignment activation audit | GO for Preview, **NO-GO for Production** until the P1 items in §4 clear. |
| **#27** | Automation follow-ups from reviews of #22–#26 | Stale; re-triage against current state. |

---

## 6. Current branches

**J KISS: 25 active worktrees.** This is the single largest source of confusion for an incoming agent.

| Category | Branches |
|---|---|
| **Live work** | `codex/operion-dependency-preflight` (PR #52) · `codex/operion-sprint1-flag-projection` (PR #47) |
| **Merged, safe to delete** | `codex/operion-dependency-closure` · `codex/operion-target-drift-gate` · `codex/operion-manifest-target-exclusions` · `codex/operion-sprint1-assignment-audit` · `codex/operion-sprint1-pay-lifecycle` · `feat/booking-job-assignment` · `sync/sprint4-manifests` · `sync/ledger-obs003-ux002` · `feat/product-sync-pipeline` · `feat/progress-ux-option-a` · `feat/ai-latency-phase2` · `feat/ai-image-optimization` · `feat/ai-pipeline-observability` |
| **Open PR** | `feat/obs-provider-failstage` · `codex/operion-target-boundary-enforcement` · `codex/sites-by-nu-branding` · `docs/operion-roadmap-update` |
| **Stale / needs decision** | `feat/multitenant-phase-1` (needs rebase) · `hardening-security-performance` · `qa/ui-mobile-polish` · `feat/customer-communications` · `feat/crew-portal-workforce` · `feat/unified-operations-book-now` · `feat/ai-job-recovery` · `feat/update-center-sync` · `phase-5b` |

> **First action for a new agent:** prune merged worktrees (`git worktree remove`) and delete their remote branches. The worktree list is at `git worktree list`; several point at `/private/tmp/` and will not survive a reboot.

**Supercharged: 12 remote branches**, all but `codex/sites-by-nu-branding` merged or superseded. Note the stale `jkiss/main` remote — a leftover cross-repo remote that must **never** be merged.

**Two stashes exist** on `codex/operion-vercel-rollback-api` (`operion-boundary-audit-update`, `operion-ai-review-handoff`) — provenance unclear, do not apply blindly.

---

## 7. Deployment status

### J KISS (`jkissllc`)

| Environment | State |
|---|---|
| Production | **Ready** — deployed ~8h before audit; serving `jkissllc.com` |
| Preview | Ready — most recent 4m before audit (PR #52 branch) |
| Auto-deploy | Git integration on; Preview per branch, Production on `main` |

### Supercharged (`supercharged`)

| Environment | State |
|---|---|
| Production | Last build **Canceled by Ignored Build Step** (scripts-only change — expected and correct); Production serves the prior **Ready** build |
| Preview | Ready (12h before audit) |
| Ignored Build Step | Configured at **project level**, not in `vercel.json` — a scripts-only PR correctly skips its build and reports a green Vercel check |

**No automated Production transfer has executed.** `OPERION_PREVIEW_AUTOMATION_ENABLED` and `OPERION_GITHUB_ACTIONS_ENABLED` are **enabled** in J KISS Production, so owner-initiated Preview canaries do run — the target workflow dispatches only on `workflow_dispatch` and lands a work branch + PR + Vercel **Preview**, never Production. As of the audit, seven owner-initiated automation jobs exist, all `automated_preview` mode (four failed before reaching a verified Preview, two were cancelled at owner review, one reached a verified Preview); none is `approved_production` and none carries a promotion. One update (UPD-1006) *is* on Supercharged Production, but it arrived through a **manual PR merge** of its Operion preview branch (commit `dd8f658`, PR #1) into the target's `main` — Supercharged's own Vercel Git integration then deployed it, and reconciliation merely recorded it (`DEP-1001`). That is a human git merge, not an Operion production promotion.

---

## 8. Database / storage status

**There is no SQL database.** Everything is Upstash Redis + Vercel Blob.

### Redis (KV)

| Environment | Store |
|---|---|
| J KISS Production | `jkissllc-analytics` |
| J KISS Preview | `OperionPreview` — **isolated**, separate credentials |
| Supercharged Production | own store (`KV_REST_API_*` prod scope) |
| Supercharged Preview | `SuperchargedPreview` — separated from J KISS during the Sprint 1 isolation work |

Key namespaces: `bk:*` bookings · `rt:*` routes · `paystmt:*` pay statements · `upd:*` / `biz:*` / `compat:*` / `dep:*` Operion records · `auto:*` automation jobs.

**Concurrency:** bookings use compare-and-swap with bounded retry (`app/lib/booking-concurrency.ts`) plus a per-record write lease for multi-step side-effecting operations. Any new booking mutation **must** go through `updateBooking`.

### Vercel Blob

| Store | ID | Scope | Contents |
|---|---|---|---|
| `jkiss-invoice-photos` | `store_WK8DoJzb2Q1lu5sv` | J KISS **Production + Development** | 84 files / 31.5 MB |
| `operion-preview-blob` | `store_Ulabe9q3GBD8ZYQh` | J KISS **Preview** | 17 files / 8.2 MB |
| `supercharged-docs` | `store_iKS2iioifS6rWFQ2` | Supercharged | 1 file |
| `supercharged-preview-blob` | `store_dy4tlLfTdLb52UCk` | Supercharged Preview | **0 files — provisioned, not yet wired** |

**Isolation is verified and structural.** Preview holds `BLOB_STORE_ID` and *no* write token; Production holds a write token whose embedded store id is `WK8DoJzb2Q1lu5sv` and *no* `BLOB_STORE_ID`. A Preview deployment therefore cannot mint a token for the production store.

**Migrations:** none pending. There is no migration framework; records carry `recordVersion` and readers backfill defaults (`normalize()` in `app/lib/bookings.ts`). `docs/operations/07-migration-safety-checklist.md` governs any change to persisted shapes.

---

## 9. Environment variable status

> Values are never printed here, and `vercel env pull` **redacts** many Production values — presence in the dashboard is the source of truth, not the local `.env.*` files.

### J KISS Production — Operion-relevant

Present: `OPERION_AUTOMATION_ENABLED` · `OPERION_GITHUB_ACTIONS_ENABLED` · `OPERION_PREVIEW_AUTOMATION_ENABLED` · `OPERION_PRODUCTION_PROMOTION_ENABLED` · `OPERION_APPROVAL_GATE_ENABLED` · `OPERION_AI_ADAPTATION_ENABLED` · `OPERION_AUTOMATIC_ROLLBACK_ENABLED` · `OPERION_SYNC_STATUS_ENABLED` · `OPERION_SYNC_PRODUCT_IDS` · `OPERION_CALLBACK_SECRET` · `GITHUB_APP_ID` · `GITHUB_APP_PRIVATE_KEY` · `VERCEL_TOKEN` · `VERCEL_TEAM_ID` · `BLOB_READ_WRITE_TOKEN`

> **Resolved flag state (audited 2026-07-22).** These Operion flags are not merely present —
> the automation switches are **enabled** in the Production runtime. `OPERION_AUTOMATION_ENABLED`
> resolves ON (confirmed via the Release Center; `vercel env pull` redacts the raw value, so the
> runtime is the source of truth), and the preview-automation and GitHub-Actions path is live
> (owner-initiated Preview canaries have dispatched). All Operion flags in Production were
> created by the account owner (Vercel team OWNER `nunubaby-6829`), the automation set on
> 2026-07-16; `OPERION_PRODUCTION_PROMOTION_ENABLED` was last modified 2026-07-20. Enablement
> only makes a subsystem *eligible* — the transfer/promotion **actions stay approval-gated**, and
> per §7 no automated Production transfer has executed. Doc 15's inventory table lists code
> **defaults** (all `OPERION_*` default OFF); this note records the resolved Production values.

**Absent (deliberately or as a gap):**
- `BOOKING_ASSIGNMENT_ENABLED` — absent ⇒ default `false`. Correct today.
- **`BLOB_STORE_ID` — absent. This is P1 #1/#2 in §4.**

### J KISS Preview

`BOOKING_ASSIGNMENT_ENABLED` · `BLOB_STORE_ID` (= preview store) · `BLOB_WEBHOOK_PUBLIC_KEY` · `TENANCY_ENABLED` · `TENANCY_DARK_LAUNCH` · `OPERION_SANDBOX_REPAIR_ENABLED` · `AI_PIPELINE_OBSERVABILITY_ENABLED` · plus the shared Operion/GitHub set. **No `BLOB_READ_WRITE_TOKEN`** — so the legacy admin upload brokers fail in Preview by design.

### Supercharged

- **Production:** minimal — `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, `BLOB_READ_WRITE_TOKEN`, `CRON_SECRET`, `DOC_ENCRYPTION_KEY`, `KV_REST_API_*`. **No `OPERION_*` flags at all.**
- **Preview:** adds `AI_PIPELINE_OBSERVABILITY_ENABLED`, `SC_PREVIEW_READ_WRITE_TOKEN`, `REDIS_URL`/`KV_URL`.
- The runner's `OPERION_CALLBACK_URL` / `OPERION_CALLBACK_SECRET` are **GitHub Actions secrets in the target repo**, not Vercel env vars.

### Flag defaults (`app/lib/platform/flags.ts`)

Every Operion, tenancy, AI-latency, image-opt, observability, progress-UX and booking-assignment flag defaults to **`false`**. The one exception is `CAPABILITY_REGISTRY_ENABLED: true` (inert data). An absent variable and an explicit `false` behave identically — verified by test.

---

## 10. Test status

| Suite | Result |
|---|---|
| J KISS `main` (`ee577c2`) — `npm test` | **1830 / 1830 pass** |
| J KISS PR #52 branch — `npm test` | **1854 / 1854 pass** (+24) |
| J KISS TypeScript | clean |
| J KISS production build | passes — 163/163 static pages |
| J KISS AI regression (`npm run test:ai:regression`) | 2 / 2 |
| Supercharged `main` (`52d50b7`) — `npm test` | **469 / 469 pass** |
| Supercharged build | passes — 133/133 pages |

**180 test files** in `scripts/*.test.ts`. Style is deliberately behavioural: real handlers driven against an in-memory Upstash fake with genuinely signed sessions (see `scripts/hardening-portal-abuse.test.ts` for the canonical pattern). Prefer that over source-text assertions.

Commands: `npm test` · `npm run test:ai:regression` · `npm run test:ai` · `npm run audit:mobile` · `npx tsc --noEmit` · `npx eslint <files>` · `npm run build`.

> **Turbopack note:** a git worktree needs `node_modules` as an **APFS clone** (`cp -c -R`), not a symlink — Turbopack rejects symlinked `node_modules` and the build fails with `Symlink [project]/node_modules is invalid`.

---

## 11. Current blockers

### Blocking Production activation of booking assignment

1. **`BLOB_STORE_ID` not set in J KISS Production** (§4 #1). Must be `store_WK8DoJzb2Q1lu5sv`. Closes §4 #2 at the same time.
2. **PR #47 unmerged** — until it lands, disabling the flag after assignments exist leaves un-resolvable cross-lane conflicts on the schedule. Interim: unassign crew and clear equipment *before* flipping the flag off.
3. **Claims do not read booking assignments** — a damage claim cannot be filed against booking work.

### Blocking Operion automation activation

4. **PR #52 unmerged** — required-updates + pre-dispatch transfer gates.
5. **`UPD-1004` must remain rejected** and must not be retried. It needs splitting into ordered prerequisite updates (issue #48 §8): Book Now intake → telemetry (already present on SC) → tenancy-only.
6. **Supercharged has never completed a full Operion Preview E2E run.** Every transfer to date failed or was manual.
7. **Audit trail gap** (§4 #7) — reconstructing a failed transfer currently requires git archaeology.

### Process blockers

8. **25 worktrees / ~20 stale branches** — high risk of an agent editing the wrong tree. Several live in `/private/tmp/` and will vanish on reboot.
9. **Two unexplained stashes.**
10. **Concurrent-session hazard** — more than one agent has operated in this repo. Always re-check `git status` and file mtimes before writing.

---

## 12. Recommended next 5 sprints

Scoped strictly to *making Operion work for J KISS and Supercharged day to day*. No enterprise tenancy, no self-service onboarding, no billing.

### Sprint 1 — Close the loop and clean the workshop *(highest value per hour)*

**Goal:** merge what is already reviewed, and make the repo navigable.

1. Merge PR **#52** (Phase B gates) and PR **#47** (rollback inertness).
2. Triage PR **#33** (close or rebase) and **#38** (merge — Supercharged already has it). Close **#29**.
3. Set **`BLOB_STORE_ID=store_WK8DoJzb2Q1lu5sv`** in J KISS Production scope. Re-verify with the §4 #2 probe.
4. Delete ~13 merged branches; remove their worktrees. Resolve or drop the two stashes.
5. Close issue **#48**; re-triage **#27**.

**Done when:** ≤4 open PRs, ≤8 worktrees, `BLOB_STORE_ID` set, #48 closed.

### Sprint 2 — Make a transfer actually succeed end to end

**Goal:** one real Operion update reaches Supercharged Preview through the automated path. This has *never* happened.

1. Split `UPD-1004` into ordered updates using the now-enforced `dependencies` field: `UPD-A` Book Now intake (`intake-workflow.ts`, `pack-services.ts` + consumers) → `UPD-B` tenancy-only (the safe ~30 files of `e42af39`), excluding `app/quote/page.tsx`, `app/lib/businesses.ts`, the confirmation route and `docs/opspilot-os/**`.
2. Enable `OPERION_PREVIEW_AUTOMATION_ENABLED` + `OPERION_GITHUB_ACTIONS_ENABLED` **in Preview only**.
3. Dispatch `UPD-A` → PR on Supercharged → Preview deploy → owner verify → record a `DeploymentRecord` with `verificationStatus: passed`.
4. Dispatch `UPD-B` and watch `required_updates` pass because `UPD-A` is verified.
5. Persist the transfer manifest + `driftCheckedPaths` + `closureCheckedPaths` on the job record (§4 #7) so the run is auditable afterwards.

**Done when:** two updates land on Supercharged through automation, with an audit record you can read without git archaeology.

### Sprint 3 — Finish the booking→money loop

**Goal:** a customer job can be crewed, worked, paid and claimed against, in Production.

1. Enable `BOOKING_ASSIGNMENT_ENABLED` in **Preview**, run the 20-step E2E checklist in issue #46 §12 — including the never-exercised real Blob upload.
2. Wire **claims** to read booking assignments (§4 #10).
3. Add **audit events** to assignment mutations that still lack them, and surface booking pay lines in the owner's pay review.
4. Fix the post-rollback `missing_crew` warning (§4 #5) or document it in `06-rollback-checklist.md`.
5. Enable in **Production** only after the checklist passes and §11 items 1–3 are clear.

**Done when:** a real J KISS booking is crewed, clocked, completed with photos, and appears on a pay statement — in Production.

### Sprint 4 — Owner-grade operations surface

**Goal:** the owner can run both businesses without an engineer.

1. Release Center: **editor for `dependencies`** ("Required updates"), and render the required-update verdicts on the update page.
2. Surface `transfer_ready` and `required_updates` at **approval** time, not just at prepare time.
3. Cause-shaped failure copy everywhere (issue #48 §10): name the cause, state plainly that nothing changed, say what happens next, keep jargon behind a disclosure.
4. Rollback rehearsal in Preview for both businesses; update `06-rollback-checklist.md` with the real observed behaviour.
5. Owner-facing "what changed" release notes generated from `DeploymentRecord` history.

**Done when:** the owner can send an update, read a refusal, fix it and retry — without reading a CI log.

### Sprint 5 — Durability and cost

**Goal:** the platform survives scale and stops wasting money.

1. **Payroll scan ceiling** — `computePay` reads `listBookings(2000)` ordered by `updatedAt`; a completed booking outside that window is silently unpaid. Move to a date-scoped read.
2. **Read amplification** (§4 #6) — bound-parallelise the drift loop's per-file reads.
3. **Portal feed cost** — `/api/portal/jobs` performs ~1000 Redis GETs per crew page load with a 500-record ceiling.
4. **Directory exclusions** (§4 #8) and the label-vs-path validation gap (§4 #9).
5. **Symlink/submodule handling** in the transfer gates; converge `sanitizePhotos` and `isCompletionPhotoUrl` on one host policy.

**Done when:** no silent data ceiling remains in a money path, and a 41-file transfer completes in a fraction of the current wall-clock.

---

## Appendix A — Orientation for the incoming agent

**Read first, in order:** `AGENTS.md` → `docs/operations/README.md` → `docs/operations/00-system-architecture.md` → `docs/operations/15-feature-flags.md` → this file → issue #48 → issue #46.

**Non-obvious rules that will bite you:**

1. **Never merge between the two repos.** Unrelated histories; sync is content-based via `tools/product-sync/`.
2. **Never overwrite Supercharged branding.** `app/lib/company.ts`, `app/quote/page.tsx` and the confirmation route legitimately diverge. 54 dependencies differ by content *on purpose*.
3. **Flag-off must mean inert** — no writes, no reads, no nav items, no requests. This has regressed twice.
4. **Fail closed, always.** Every gate in the transfer pipeline refuses on uncertainty. Never "assume present".
5. **Report, never auto-fill.** `conflicts.ts`, `jobCrewGap`, the payroll-gap gate and the closure gate all follow this. Do not add an auto-completer.
6. **Verify against reality.** Run the probe, read the deployment, check the env — do not trust a PR description, including your own.
7. **Production actions and secret writes need explicit owner go-ahead.**
8. Booking mutations go through `updateBooking` (CAS). Customer-facing output goes through `customerView`.
9. Worktree `node_modules` must be an **APFS clone**, not a symlink.

**Where the Operion code lives:**

```
app/lib/platform/
  updates/{types,store,policy,prompt,seed}.ts     records + pure policy
  automation/
    manifest-builder.ts     ← the transfer chokepoint
    closure.ts              ← dependency closure (pure)
    preflight.ts            ← the gate list (pure)
    orchestrator.ts         ← job creation + dispatch
    provider.ts             ← interface + inert StubProvider
    github-provider.ts      ← the only live provider
    apply-executor.ts, manifest.ts, callback.ts, store.ts
app/api/admin/platform/     control-plane routes (owner-gated)
app/api/automation/manifest/route.ts   ← HMAC-signed manifest for the CI runner
app/admin/operations/platform/page.tsx ← Release Center UI
scripts/operion-apply.mjs   ← runner; copied into each target repo
tools/product-sync/         ← advisory ledger
```

---

## Appendix B — Verification commands used for this audit

```bash
git fetch --all --prune && git log --oneline -8 origin/main
git branch -r --sort=-committerdate && git worktree list
gh pr list --state open --json number,title,headRefName
gh issue list --state open
vercel list --yes                      # deployments
vercel env ls production | awk 'NR>4 {print $1}'   # NAMES ONLY
vercel blob list-stores
npm test && npx tsc --noEmit && npm run build && npm run test:ai:regression
```

Environment values were never read or printed. Production was not modified. No application code was changed in the course of this audit.
