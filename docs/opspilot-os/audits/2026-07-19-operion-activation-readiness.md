# Operion Activation Readiness Audit — 2026-07-19

> Scope: PR #28 (`codex/operion-production-project-resolver`) at commit
> `637a2d2d1df6b5923ea4a3514abbb619f373269f`. This audit was read-only. It did
> not publish, roll back, dispatch a workflow, alter a business record, change an
> environment variable, or expose a credential.

## Verdict

**READY for the existing owner-controlled Preview and Production stages.**

**NOT YET ACTIVATED for advanced automation.** AI adaptation and automatic
rollback remain disabled until the controlled Supercharged canary proves the
complete deploy → detect failure → rollback → recovery path.

The authoritative PR Preview reported:

- `safeToEnablePreview: true`
- `safeToEnableProduction: true`
- Provider access: **ready**
- Preview automation: **ready**
- Controlled Production: **ready**
- Advanced automation: **disabled** (safe, expected)

## Evidence source

- PR: <https://github.com/ratchetnu/jkissllc/pull/28>
- Protected Vercel Preview:
  `jkissllc-git-codex-operion-produ-ef5d27-nunubaby-6829s-projects.vercel.app`
- Runtime: Vercel `preview`
- Owner-only endpoints:
  - `GET /api/admin/platform/whoami`
  - `GET /api/admin/release/activation-readiness`
  - `GET /api/admin/release/businesses`
- Access method: authenticated `vercel curl`; the temporary application-session
  cookie was deleted immediately after the requests.

No raw environment values, private keys, tokens, callback secret, password, or
session cookie were printed or retained. Readiness consumes configuration as
booleans only.

## Gate results

| Stage | Result | Evidence |
|---|---|---|
| Trusted runtime | PASS | Evaluation ran in Vercel Preview. |
| GitHub provider | PASS | GitHub App ID and private key are configured. |
| Vercel provider | PASS | Vercel token and project context are configured. |
| Signed callback | PASS | Automation callback secret is configured. |
| Preview business readiness | PASS | Every active business has complete Preview configuration. |
| Preview execution flags | PASS | Master automation, GitHub dispatch, and Preview automation are enabled in Preview. |
| Production business readiness | PASS | Every active business has an owner-gated Production path and verified rollback evidence. |
| Production control flags | PASS | Approval gate and controlled Production promotion are enabled in Preview. |
| AI adaptation | DISABLED | Flag remains off; this is not a blocker for controlled operation. |
| Automatic rollback | DISABLED | Flag remains off pending the controlled canary. |
| Rollback executors | PASS | Every active business has a server-side executor and distinct prior known-good deployment. |

## Business results

### J KISS LLC

- Preview-ready: **yes**
- Production-ready: **yes**
- Repository and default branch allowlisted: **yes**
- GitHub installation and automation workflow mapped: **yes**
- Preview and Production projects configured: **yes**
- Owner approval explicitly required: **yes**
- Controlled Production promotion permitted: **yes**
- Current Production and distinct rollback target known: **yes**
- Server-side rollback executor ready: **yes**

### Supercharged Enterprises

- Preview-ready: **yes**
- Production-ready: **yes**
- Repository and default branch allowlisted: **yes**
- GitHub installation and automation workflow mapped: **yes**
- Preview and Production projects configured: **yes**
- Owner approval explicitly required: **yes**
- Controlled Production promotion permitted: **yes**
- Current Production and distinct rollback target known: **yes**
- Server-side rollback executor ready: **yes**

## Quality and independent review

- TypeScript: pass
- Focused lint: pass
- Release Center / publish / history / rollback focused tests: **49/49 pass**
- Activation-readiness focused tests after the owner-tab correction: **12/12 pass**
- GitHub CI `verify`: pass
- Vercel Preview deployment: ready
- Claude Code independent follow-up review: P3 resolved; no remaining merge
  blocker

## Local diagnostic note

The first local check was correctly blocked because a local runtime is not a
trusted activation environment and local configuration intentionally differs
from Preview. A stale local dev process also served the pre-correction Release
snapshot without `ownerAccess`; restarting the server resolved that mismatch.
The same owner session was independently verified as `owner: true`. This was a
local process-cache issue, not a login, Production, or authorization defect.

## Remaining activation gate

Before enabling advanced automation:

1. Merge PR #28 after all checks remain green.
2. Deploy and smoke-test the Release Center in J KISS Production.
3. Run the inert Supercharged canary through Preview.
4. Exercise a controlled publish, induced verification failure, server-side
   rollback, and recovery to the expected known-good deployment.
5. Confirm idempotency, audit history, target linkage, and no customer-data
   mutation.
6. Keep automatic rollback off if any canary assertion fails.

Only after that evidence is recorded may the owner separately consider enabling
AI adaptation or automatic rollback. This audit does not authorize either flag.

## Controlled rollback canary — executed & recovered (2026-07-19)

The deploy → rollback → recovery path was exercised end-to-end against the
Supercharged managed target. Automatic rollback and AI adaptation remained OFF
throughout; every step was owner-authorized and control-plane–driven.

| Stage | Evidence |
|---|---|
| Rollback endpoint | **J KISS PR #30** (merge `a2a7192`) switched controlled + automatic rollback off the promote endpoint onto the dedicated Vercel rollback API `POST /v9/projects/{project}/rollback/{deploymentId}` (a prior production deployment 404s on promote). |
| Initial rollback attempt | **RBK-1002 FAILED** — that rollback call passed the project **display name** (`"supercharged"`); Vercel returned `404 not_found`. |
| Root cause | Vercel's rollback endpoint requires the immutable `prj_…` project id (the CLI resolves the project first and rolls back with `project.id`). Operion passed the configured name. Verified project id: `prj_fqqMknsnyUKapcyqEgnDx3sHROlr`. |
| Fix | **J KISS PR #31** (`codex/operion-resolve-vercel-project-id`, merge `bf1eb14…`): added `VercelPreviewProvider.resolveProjectId` (read-only, `prj_…` passthrough, fail-closed, never falls back to the name) and routed `rollbackProduction` through it. Publish (`promoteProduction`) unchanged; all automatic flags OFF. tsc/eslint clean; provider+rollback 39/39; suite 1601/1601; ai:regression 2/2; build OK. J KISS Prod redeployed: `dpl_CibfHf8RWvBou2boXcNyLDEnGpSW`. |
| Successful rollback | **RBK-1003 COMPLETED** — production restored to `dpl_EYmcm6MQzC8svtHJhw6YtaScJgMb` (commit `98e0fe5`). Verified: `superchargedenterprise.com` + `www` → HTTP 200; `/operion-rollback-canary.json` → **404** (canary marker no longer served in production). |
| Idempotency | Identical repeat returned `ok=true, idempotent=true, rollback.id=RBK-1003`; no second Vercel rollback and no duplicate rollback record created. |
| Recovery | **Supercharged PR #5** (`codex/operion-canary-recovery`, merge `0d9156f`): removed **only** `operion-rollback-canary.json` (inert marker, `runtimeEffect: none`). Checks green (regression, Vercel, Preview Comments); suite 395/395; build OK. Recovery deployment `dpl_BoFGAmaQd9R3ELDhjXSgLCh1Z3ch` (commit `0d9156f`) built **READY**, `target:production`. |
| Alignment promotion | The recovery deployment `dpl_Bo…` (commit `0d9156f`) built READY but did not auto-promote over the RBK-1003 rollback pin (production stayed on `dpl_EYmc`/`98e0fe5`). Owner-authorized **promotion** of `dpl_BoFGAmaQd9R3ELDhjXSgLCh1Z3ch` cleared the pin. Verified: both `superchargedenterprise.com` and `www` now resolve to `dpl_Bo…`; apex 200, www 308→200; a `/_next/static` asset 200; `/operion-rollback-canary.json` → **404**; live Production commit = repo `main` = `0d9156f` (**aligned**). All automatic flags remained OFF; no J KISS files transferred; neither J KISS stash applied. |

Net: the rollback/recovery stage is **complete** — the rollback API defect is
fixed and proven (RBK-1003 + idempotency), the canary marker is removed from the
repo and no longer served in production, and Supercharged Production is realigned
with `main` at `0d9156f`. The remaining program work is the managed-target
boundary enforcement below.

## Control-plane ↔ managed-target boundary (added 2026-07-19)

**Architecture.** J KISS LLC is the Operion **control plane** and owns the
Release Center. Supercharged is a **managed target business** and must receive
only approved updates applicable to the Supercharged line of business. A managed
target must never receive the Release Center UI, `/admin/operations/release`
routes, platform-owner controls, cross-business configuration, Operion
orchestration logic, publish/rollback controls, control-plane credentials, or
any ability to manage other businesses.

**Verification against PR #30 (`fe24631`) and the current canary.**

| # | Claim | Result | Evidence |
|---|---|---|---|
| 1 | PR #30 changes only the J KISS control plane | PASS | Diff touches only `app/api/admin/release/businesses/[id]/rollback/route.ts`, `app/lib/platform/automation/{orchestrator,vercel-provider}.ts`, and two `scripts/*.test.ts` — all in the `jkissllc` repo. |
| 2 | PR #30 copies no Release Center code into Supercharged | PASS | PR #30 does not touch the `supercharged` repo at all. |
| 3 | The rollback canary changes only the deployment pointer + a harmless marker | PASS | Supercharged commits `85f557b`/`4a517bf` add only `operion-rollback-canary.json`; a Vercel rollback repoints production (`dpl_597…` → `dpl_EYmc…`) and writes no repo files. |
| 4 | Recovery removes only `operion-rollback-canary.json` | PASS | **Done** — Supercharged PR #5 (merge `0d9156f`) deleted exactly that one file and nothing else (1 file, 5 deletions); recovery deployment `dpl_BoFGAmaQd9R3ELDhjXSgLCh1Z3ch` was promoted to Production and `main`/Production are aligned at `0d9156f`. |
| 5 | No control-plane functionality is present in Supercharged | OBSERVATION | Supercharged `main` contains a **read-only** Release Center surface — `app/admin/operations/release/page.tsx` + `app/api/admin/release/route.ts` (GET-only snapshot, `requireAdmin`, no secrets, no publish/rollback/orchestration). Introduced by the **manual** platform-sync commit `98e0fe5`, not the automated transfer pipeline. It carries no control-plane capability, but the two files cross the stated boundary and should be removed under a separate cleanup. Per-business publish/rollback routes, orchestrator, and cross-business config are **absent** (confirmed). |
| 6 | Update-transfer enforces a target-specific allowlist/manifest that cannot transfer control-plane files to a managed business | **FAIL — PRODUCTION BLOCKER** | The commit-transfer engine derives its manifest purely from the source commit's own changed-file list (`manifest-builder.ts` → `manifestFromCommitFiles`). The only file-level guard is `isSafeRepoPath` (path-safety: no traversal/absolute/bad chars) plus a 200-entry cap and hash verification. There is **no** control-plane path denylist and **no** target-aware allowlist. `change-classification.ts` can label changes "release-engine code" but only feeds the read-only Publish Review dashboard (`publish-review-enrichment.ts`); it does not block a transfer. Preflight gates cover runtime, compatibility status, branch allowlist, rollback-eligibility, and commit-drift — none inspect file paths. If an approved update's source commit touched control-plane paths, those files **would** be transferred to the target repo. |

**Blocker (item 6).** Do **not** enable automated update transfers (nor
automatic rollback / AI adaptation) until the transfer engine enforces a
target-aware control-plane boundary. Recommended enforcement, in a **separate
blocking PR** (do not expand PR #30): reject any manifest whose entries touch
control-plane paths (`app/api/admin/release/**`, `app/admin/operations/**`,
`app/lib/platform/automation/**`, `app/lib/platform/release/**`, and the like)
when the target business role is a managed target — enforced in
`validateManifest`/`buildCommitTransferManifest` and re-checked in `preflight`,
with unit tests proving a control-plane file cannot reach a managed target.

**Canary status (final).** The controlled rollback canary copied no control-plane
code into Supercharged (item 3) and is now **complete**. After PR #31 fixed the
project-id resolution, the live rollback ran under owner authentication
(`mode==='live'`: `VERCEL_ENV=production` + `OPERION_PRODUCTION_PROMOTION_ENABLED`)
— **RBK-1003 COMPLETED**, idempotent repeat confirmed (`ok=true, idempotent=true,
rollback.id=RBK-1003`, no second rollback). Recovery PR #5 removed the marker and
Production was promoted to `dpl_BoFGAmaQd9R3ELDhjXSgLCh1Z3ch` (commit `0d9156f`),
aligned with `main`; the marker now returns 404 and all Operion automatic
execution flags remain OFF. **This does not affect item 6:** target-aware
transfer enforcement is still missing and remains the open Production blocker
before any automated update transfers (or automatic rollback / AI adaptation) are
enabled.
