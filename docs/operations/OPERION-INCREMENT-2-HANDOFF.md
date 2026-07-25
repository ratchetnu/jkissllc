# Operion Release Center — Increment 2 Handoff: Evidence-Based Baseline Adoption

> **Purpose.** A self-contained brief for an agent (ChatGPT / Codex / a fresh session) with
> **no prior context** to take over this work. Everything under "Verified ground truth" was
> established by direct inspection of the live system — treat it as fact and do not
> re-derive or contradict it.
>
> **Written:** 2026-07-25 · **Prerequisite:** PR #85 (Increment 1), merged as `b1a6477`.

---

## Repo

`ratchetnu/jkissllc` — Next.js App Router, TypeScript, Vercel.

Read `AGENTS.md` / `CLAUDE.md` first: this Next.js version has breaking changes versus
common training data. Consult `node_modules/next/dist/docs/` before writing framework code.

Commands: `npm test` (node:test via tsx, ~2100 tests) · `npx tsc --noEmit` ·
`npx eslint <files>` · `npm run build`.

---

## Verified ground truth — do not re-derive, do not contradict

### Program context

Operion is a release control plane living in J KISS that ships changes to a **second
product**, Supercharged (`ratchetnu/supercharged`). It currently ships *individual UPD
records*, not versioned release packages. This is a multi-increment program; this document
covers **Increment 2 only**.

### Already shipped and merged — do not redo, do not weaken

- **Retry policy** is centralized in `retryEligibility()` (`automation/deploy-view.ts`),
  shared by the dispatcher, the Retry button, and its copy. Archived / rejected / deployed /
  already-present / superseded / unknown updates cannot retry; a blocked retry does **not**
  increment `attemptCount` and dispatches nothing; owner retries are capped.
- **Installed-version display** is centralized in `deriveVersionState()`
  (`release/versions.ts`): `current | update_available | version_unknown | not_installed |
  incompatible`. It **fails closed to `version_unknown`** and never infers
  `update_available` from an absent baseline.
- **`deriveBusinessProvenance()`** (`automation/finalize.ts`) writes `currentVersion` /
  `latestVerifiedVersion` **only** from an associated `releaseVersion`. It never derives a
  version from a commit.

### Merged prerequisite — Increment 1

**PR #85**, merged as `b1a6477`, file
`app/lib/platform/release/semver-policy.ts`. Strict SemVer parse / compare / bump policy.
Increment 2 intentionally adds the first two authoring importers: verified finalization and
evidence-based baseline adoption. The strict and legacy parsers remain separate.

The API you will consume: **`evaluateVersionBump()` returns `baseline_required`** when the
previous version is unknown — it refuses to invent a first version. **That is precisely
what Increment 2 exists to resolve.**

### Two version parsers exist ON PURPOSE

`updates/policy.ts` `parseVersion` / `compareVersions` are deliberately **lenient** (accept
`v1`, `1.2`; ignore prerelease when ordering) because historical records depend on it.
`semver-policy.ts` is the **strict authoring layer**. Reading old data stays lenient;
writing a new version is strict.

**Do not "unify" them.** Both behaviours are pinned by tests.

### Current record model

- `PlatformUpdate` — the UPD ID, an immutable engineering change identifier.
- `PlatformBusiness.currentVersion` / `latestVerifiedVersion` / `currentCommit` /
  `latestVerifiedCommit` — the de-facto installed baseline, with **no provenance field**.
- `UpdateAutomationJob` — **conflates** installation and attempt (carries an `attemptCount`
  integer, not attempt records).
- **Do not exist anywhere in the codebase:** `ReleasePackage`, `TargetInstallation`,
  `ExecutionAttempt`, `InstalledBaseline`, `baselineSource`, and **`manifestHash`**.

### Environment facts

- Every **Production** product has an unknown installed baseline (`currentVersion` absent).
- **Operion Sandbox `0.1.0` exists only in Preview** and is a disposable TEST-ONLY product.
  It is **NOT** a Production platform baseline.
- **Preview and Production use separate KV stores.** Preview data does not reflect
  Production, and a fixture seen in one will not exist in the other.
- **`UPD-1004` is archived and terminal.** Never revive, requeue, or retry it.
- An earlier **draft release map** (0.1.0 → 0.3.0) exists in conversation only. It is **not
  authoritative**, contains an ordering contradiction, and must not be written to any record.

---

## Objective

Implement **evidence-based baseline adoption**, so products that predate semantic release
tracking can be versioned truthfully — without fabricating history.

### Baseline states

| State | Meaning |
|---|---|
| `verified` | Proven by a successful Operion finalization carrying a `releaseVersion` |
| `adopted` | Current deployed state is verified, but the deployment predates version tracking |
| `unknown` | Insufficient evidence to assign a version |

### Requirements

1. Add `baselineSource` provenance: `installed_by_release | adopted | unknown`. **Never**
   label an adopted baseline as `installed_by_release`.
2. The adoption record must carry: `targetProduct`, `proposedVersion`, `deployedCommit`,
   `capabilityManifestHash`, schema/migration state, relevant flag state, verification
   evidence, `baselineSource='adopted'`, `adoptedBy`, `adoptedAt`, `ownerApproval`,
   `rollbackSnapshot`.
3. A **read-only adoption dry run** reporting: matched capabilities, deployed-commit
   evidence, schema/migration evidence, relevant flags, missing evidence, conflicts,
   proposed version, records that would change, rollback snapshot, and a verdict of
   `safe_to_adopt | needs_review | insufficient_evidence`.
4. **No write may occur without explicit owner approval after the dry run.** Enforce this
   server-side, not merely in the UI.
5. `currentVersion` may change **only** via approved adoption or verified finalization.
6. Surface adopted provenance in the Release Center **distinctly** from
   `installed_by_release`.

---

## Hard prohibitions

- Never infer a version from commit history alone.
- Never fabricate or backfill a version. **Unknown stays unknown.**
- Adoption must not create fake jobs, attempts, release history, or finalizations.
- Do **not** create `ReleasePackage`, `TargetInstallation`, `ExecutionAttempt`, lock,
  checkpoint, reconciliation, or general `manifestHash` records — those are later
  increments. You will need a capability-manifest hash *as an input*: define the minimum
  needed for adoption evidence, and say explicitly that you did so.
- Do not weaken manual-port, compatibility, archive, retry, migration, or approval gates.
- Do not modify Production data, products, versions, updates, jobs, attempts, flags,
  providers, credentials, environment variables, or deployments.
- Do not publish the draft release map.
- **Do not merge.** Open one isolated PR and leave it unmerged.

---

## Tests required

Adopted vs. verified vs. unknown provenance · unknown preserved · no fabricated version ·
dry run produces each of the three verdicts · approval required before any write · approved
adoption updates `currentVersion` · failed or declined adoption changes nothing · successful
finalization still updates `currentVersion` · failed / cancelled / blocked / superseded
attempts do not · an adopted baseline unblocks `evaluateVersionBump()`'s `baseline_required`
· legacy records with no version remain readable · the installed-version display behaviour
from PR #84 is unchanged · UI and backend share the same policy helper.

---

## Verification before finishing

Focused tests · full suite · `tsc --noEmit` · ESLint **on tracked files only** · `npm run
build`.

> **Lint note:** repo-wide `npm run lint` exits non-zero on a clean tree — roughly 3.8k of
> its errors come from untracked `.claude/worktrees/**/.next/` build artifacts that the flat
> config does not ignore, and ~49 more are pre-existing in files unrelated to this work.
> Lint the changed files explicitly; do not read the top-line exit code as a regression.

Browser validation only if a visible surface changes; otherwise state **N/A with evidence**
(e.g. "module has zero `app/` importers").

---

## Required output

- Current-model audit (what you found before editing)
- Files changed
- Baseline-adoption design
- Provenance model
- Dry-run contract and verdicts
- Approval boundary
- Test results
- Browser validation (or N/A + evidence)
- PR link (unmerged)
- Blockers
- Next increment

---

## Known failure modes for this increment

Two specific ways this goes wrong, called out so they can be avoided rather than discovered
in review:

1. **Fabrication by convenience.** The entire point is that a version may come only from
   evidence. The tempting shortcut is inferring one from a commit, a git tag, or "the
   product obviously has *something*." `currentVersion` must be writable only through
   approved adoption or verified finalization, and unknown must genuinely stay unknown.
2. **A cosmetic approval gate.** A dry run that computes a verdict, paired with a write path
   that does not actually require the approval, satisfies the letter and defeats the
   purpose. The gate must be enforced server-side.

A third, subtler one: do not "tidy up" the two version parsers, the centralized retry
policy, or the version-state derivation. Each is deliberately shaped, and each is pinned by
tests that explain why.
