# 20 — Operion ↔ Supercharged: how the pairing actually works

Verified against both repositories, 2026-08-21. Facts below were read out of the
code, not recalled. Where something is NOT implemented, this says so.

---

## 1. Which repository is the source of truth for shared platform code

**`ratchetnu/jkissllc` (Operion) is the source. `ratchetnu/supercharged` is a
managed target.** The direction is one-way and enforced structurally, not by
convention:

- Operion holds the update/release/deployment records (`platform:upd:*`,
  `platform:rel:*`, `platform:autojob:*`) and the automation orchestrator.
- Supercharged holds no control-plane state at all. It has no update records, no
  release records, and no way to dispatch anything at Operion.
- The only channel from target to control plane is the signed callback, and it
  carries results and a value-free capability snapshot — never a request.

**The two repositories have UNRELATED git histories.** Nothing may be merged or
cherry-picked between them; parity is content-based. That is why the shared
constants in `capabilities/contract.ts` are duplicated by design and pinned by a
test on each side: a one-sided edit must fail a test rather than produce two
deployments that quietly disagree about what a state code means.

## 2. What is intentionally tenant-specific

Three categories, and they are separated on purpose because they need different
protections.

| Category | Where it lives | Why a transfer cannot touch it |
|---|---|---|
| **Identity / branding** | Repository files | A **standing** policy (`release/target-owned-paths.ts`) withholds them on every transfer, unioned with any curated exclusions. A record may withhold more; never less. |
| **Capability choices** | The target's own Redis, tenant-scoped `settings:capabilities` | Not a file. A file transfer has no path to it. |
| **Provider credentials** | The target's own environment | Not a file, and never in git. Operion holds a non-secret *reference* at most (a variable NAME), never a value. |
| **Tenant data** | The target's own Redis, tenant-prefixed | Not a file. |

The standing file list (each with a stated reason):
`app/lib/company.ts` · `public/` · `vercel.json` · `.env` · `.env.example` ·
`app/lib/tenant-branding.ts` · `README.md`.

`app/lib/company.ts` is the one that matters most: it holds the legal name, DOT/MC
numbers, phone, email, address and brand colour. That file *is* the business.

## 3. How release identity is represented

**A commit, and only a commit.** `release/source-artifact.ts` resolves an update
into `{ repo, commit }` and refuses everything else:

- a branch name, a tag, `HEAD`, `latest`, `current` — a moving position means
  something different tomorrow, which is the property that makes it unusable as
  identity;
- anything shorter than a 7-character object name;
- a record explicitly marked as captured from a dirty worktree.

A `ReleasePackage` groups update keys under a semantic version for the human story;
the **artifact** is still the commit underneath. `describeSourceArtifact()` renders
`owner/name@abc1234`, which is what the guided screen shows so nobody types one.

**A local dirty worktree cannot be deployed.** The transfer path resolves files from
a committed source commit through the GitHub API and applies them on the target via
`scripts/operion-apply.mjs`; there is no path from a checkout to a target. The
remaining risk is a human running `vercel --prod` from a working tree, which
`AGENTS.md` warns about and the guided workflow never offers.

## 4. How compatibility is checked

Layered, cheapest first, each blocking before the next runs:

1. **Preflight** (`automation/preflight.ts`) — ~22 gates, each carrying a *class*
   (platform / review / capability / documentation) and rolled into one verdict:
   `ready` · `ready_optional_unavailable` · `manual_review` · `blocked_by_platform`.
2. **Required updates** — an update may declare predecessors that must already be
   installed AND verified on *this* target.
3. **Transfer closure** (`automation/closure.ts`) — every import the transferred
   files reach must resolve on the target at its pinned base commit.
4. **Symbol verification** — the named exports those imports expect must exist.
5. **Target-owned exclusion** — the standing policy above.

An optional provider is checked by **none** of them. A test greps the rendered gate
set for `stripe`, `twilio` and `resend` and fails if any appears.

## 5. How configuration is mapped without copying secrets

It is not mapped. It is **declared**.

- An update may state `activationRequirements`: a capability, a kind
  (`tenant_enable` / `provider_credential` / `feature_flag`) and a variable **NAME**.
- The target reports back which variable NAMES it is still missing.
- Operion never holds a value, and the evidence validator drops any entry whose
  `missingVars` contains something that is not an env-var name — dropped whole,
  never truncated, because a truncated secret is still a secret.

Activation requirements are reported as a **soft** preflight gate. They never block.

## 6. How Preview and Production targets are paired

On the `PlatformBusiness` record, all non-secret:

| Field | Meaning |
|---|---|
| `repoName` / `githubInstallationId` | which repository, and the App installation that may write to it |
| `defaultBranch` + `allowedTargetBranches` | the base branch allowlist |
| `automationWorkflowFile` | the workflow Operion may dispatch (`operion-update.yml`) |
| `previewProjectId` + `previewDeploymentProvider` | where the Preview appears |
| `productionProjectId` | what a promotion may promote |

Work branches are **server-derived** (`operion/{update-key}`), never taken from
browser input. The Preview is created by the target project's own git integration on
branch push; Operion polls it server-side.

Promotion is bound in two independent ways: the approval record pins
`sourceDeploymentId`, and `previewMatchesArtifact()` pins the **commit**. The second
is what catches a Preview rebuilt from a newer head after the owner reviewed it.

## 7. How drift is detected

- **Target drift** — the manifest is built against a pinned `targetBaseCommit`, and
  every transferred path is compared against the target's content at that commit
  (`driftCheckedPaths` in the transfer evidence).
- **Source drift** — `commitDriftDetected(approvedCommit, currentHead)` refuses a
  promotion whose PR head has moved since approval.
- **Renames** — refused outright; a rename needs its own reviewed update.
- **Deployment drift** — `/api/health` returns the live build id, so what is serving
  is checked rather than inferred from a green Ready label.

## 8. How rollback works

Before promoting, the job captures `rollbackTargetDeploymentId` **and**
`rollbackTargetCommit` — the deployment id *and* the verified commit it was built
from, bound together so a rollback cannot promote a deployment nobody verified.
`automaticRollbackEligible()` requires: the flag on, a production project id, a
previously verified commit, and **no irreversible migration**.

That last condition is the honest limit, and the guided review screen says so: a
schema change is the one difference class marked `irreversible: true`, because
putting the previous build back does not put the data back.

## 9. What an update cannot overwrite — summary

| Thing | Protected by |
|---|---|
| Branding / identity files | standing target-owned policy, applied every time |
| Capability choices | stored in the target's Redis; unreachable by a file transfer |
| Provider credentials | stored in the target's environment; never in git, never in an Operion record |
| Tenant data | tenant-prefixed keys in the target's own store |
| Deployment configuration | `vercel.json` is target-owned |

---

## 10. What is NOT implemented

Stated plainly so nobody reads the above as more than it is.

- **No automatic schema migration.** `migrationRequired` is a flag that forces owner
  approval and marks the change irreversible. Nothing runs a migration on the target.
- **Plans are declared but not enforced.** Every capability currently lists all three
  tiers, so `unavailable_on_plan` cannot occur in production. The rule is implemented
  and tested; the data is deliberately empty.
- **The capability backfill has not been run anywhere.** Until it is, both
  deployments resolve provider adapters through the legacy credential fallback,
  reported as `legacy-uninitialized`.
- **Supercharged has no `AI_PROVIDER` seam.** It reaches the model through the Vercel
  Gateway only; J KISS can also use Anthropic directly. The readiness spec on each
  side matches its own transport.
- **`TENANCY_ENABLED` is off in Production.** See
  `GET /api/admin/platform/ga-readiness` for the thirteen dimensions and the exact
  remaining actions.
