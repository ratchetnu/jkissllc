# PR #33 — comparison evidence preserved before closure

**PR:** ratchetnu/jkissllc #33 — *feat(operion): enforce managed-target transfer boundary (Stage 2A)*
**Head:** `9921637688aae6f20a29ed9b2bc30d539fcd0d5c`
**Merge-base:** `80b7989f7ecaf788fa0899ab262c45a98e3678d6`
**State at closure:** `CONFLICTING` / `DIRTY` — 9 files, +526/−10
**Closed:** 2026-07-22, during Operion Sprint 1 integration
**Full patch preserved at:** `docs/operations/superseded/pr-33-target-boundary-enforcement.patch` (42,044 bytes)
**Branch retained:** `codex/operion-target-boundary-enforcement` — *not* deleted; the code remains recoverable from both the branch and the patch.

---

## Why it was closed

It could not be merged as-is. Seven of its nine files were **rewritten on `main` after its merge-base** by the four transfer-safety PRs that landed subsequently, which is the direct cause of the merge conflict:

| PR #33 file | Status on `main` | Last change on `main` |
|---|---|---|
| `app/api/automation/manifest/route.ts` | rewritten | `ba42d52` — block target file drift (PR #50) |
| `app/lib/platform/automation/apply-executor.ts` | rewritten | `93c4d04` — deterministic Commit-Transfer Apply Executor |
| `app/lib/platform/automation/manifest-builder.ts` | rewritten | `4e51835` — dependency closure (PR #51) |
| `app/lib/platform/automation/manifest.ts` | rewritten | `87aa730` — dynamic-route brackets |
| `app/lib/platform/automation/preflight.ts` | rewritten | `1e80da5` — required-updates + transfer_ready (PR #52) |
| `scripts/manifest-builder.test.ts` | rewritten | `4e51835` (PR #51) |
| `scripts/operion-apply.mjs` | rewritten | `ba42d52` (PR #50) |
| **`app/lib/platform/automation/target-policy.ts`** | **ABSENT** | — never merged |
| **`scripts/operion-target-policy.test.ts`** | **ABSENT** | — never merged |

Rebasing would mean re-authoring the 7 conflicted files against gate logic that did not exist when #33 was written. Closing and re-raising the residual capability is cheaper and safer than resolving a 7-file conflict across four generations of security gates.

---

## ⚠️ What is genuinely superseded — and what is NOT

**Superseded (delivered by merged work):** the manifest/apply/preflight plumbing changes. The transfer chokepoint now enforces, in order: compatibility fail-closed + `pathsToExclude` (#49) → rename refusal + three-way drift + `targetBaseCommit` handshake (#50, SC #14) → dependency closure (#51) → `required_updates` + `transfer_ready` (#52).

**NOT superseded — a real capability gap remains open:**

`app/lib/platform/automation/target-policy.ts` (179 lines) is a **pure, server-authoritative, role-based path boundary**. Its stated purpose:

> *"The single source of truth for WHICH repository paths may be transferred into WHICH kind of business. It exists so a managed target (e.g. Supercharged) can NEVER receive Operion control-plane code — even if an update is mislabeled or its source commit happens to contain forbidden files. Enforcement is by PATH + resolved business ROLE, never by a label."*

It defines `TARGET_POLICY_VERSION`, `ComponentClass`, `TransferBlockerCode`, and a segment-prefix (not substring) matcher over control-plane-only path families: `app/lib/platform/automation`, `app/lib/platform/updates`, `app/lib/platform/sync`, `app/lib/platform/release`, `app/api/automation`, `app/api/admin/release`, `app/admin/operations/release`. Roles resolve from `PlatformBusiness.role`, and an unknown role **fails closed**.

**Nothing on `main` replaces this.** The closest merged mechanism is `pathsToExclude` (#49), but the two differ in kind:

| | `pathsToExclude` (merged, #49) | `target-policy.ts` (unmerged, #33) |
|---|---|---|
| Scope | per-update, per-business | categorical, role-derived |
| Source | **owner-declared configuration** | **code-defined invariant** |
| Failure mode if omitted | the path transfers — **fails open on owner error** | still blocked — fails closed |
| Matching | exact paths only (§4 #8: directories cannot be expressed) | segment-prefix families |

So today, a mislabeled update whose commit happens to contain `app/lib/platform/automation/**` is stopped **only if the owner remembered to enumerate those exact paths** in that update's `pathsToExclude`. There is no categorical floor preventing Operion control-plane code from reaching Supercharged.

### Recommended follow-up

Re-raise as a **fresh, narrowly-scoped PR containing only the two absent files** — `target-policy.ts` + `operion-target-policy.test.ts` — plus a single call site in the current `manifest-builder.ts`. That is additive against today's `main`, carries no conflict, and restores the categorical boundary without re-litigating the seven superseded files.

Related: this also addresses §4 #8 of `OPERION_CURRENT_STATE.md` (directory exclusion impossible), since the policy matches path *families* rather than exact paths.
