# Product Synchronization — Workflow, Verification, Approval, Rollback

The end-to-end operating procedure for porting one upstream update into a downstream
product. Every command is read-only over the product repos except the implementation
step (which works only on its own `sync/<product>/<id>` branch).

## 0. Manifest format (Phase 1)

An update is one JSON file in `registry/`. Terse entries are fine — `normalizeManifest`
fills defaults. Required: `id` (`ABC-001`), `title`. Everything else defaults. See
[MANIFEST.md](./MANIFEST.md) for the field reference. Statuses:

`discovered → planned → approved → adapting → implemented → verified → preview-ready → merged → released`
plus terminals `blocked` and `rejected`. Transitions are enforced by `canTransition`.

## 1. Discovery (Phase 2) — read-only

```
npm run sync:discover -- supercharged
```

Content-diffs upstream vs downstream (path + sha1, since histories are unrelated) and
writes `out/drift-operion-to-supercharged.json`. Reports: missing/changed/moved/renamed
files, dependency drift, migration drift, environment drift, feature-flag drift, API /
component / route / documentation drift, and un-registered upstream commits. **It never
writes to any product repo.**

## 2. Classification (Phase 3)

`classifyUpdate(manifest, signals)` assigns exactly one class:

| Class | Meaning | Example |
|---|---|---|
| `direct-port` | applies cleanly, absent downstream | Graceful worker deadline |
| `adaptation-required` | needs branding/config/API/dep/migration work | AI Observability |
| `already-present` | downstream already has a matching copy | — |
| `partially-present` | some exists; port the remainder | — |
| `excluded` | never ported (policy) | **Release Center** |
| `manual-review` | ambiguous — a human decides | — |

Exclusion rules live in `classify.ts` (`EXCLUSION_RULES`). Release Center is the
canonical exclusion — a downstream product is a release *target*, not a release
*operator*.

## 3. Compatibility gates (Phase 4) — read-only, halts on failure

```
npm run sync:gates -- supercharged
```

Verifies: clean repository · clean working tree · correct branch · no conflicting
session (no in-progress merge/rebase/lock) · dependency compatibility · migration
compatibility · **feature flags OFF** · environment compatibility · authentication
compatibility · tenancy compatibility. **Any failure exits non-zero and stops the
pipeline** — do not proceed to implementation.

## 4. Adaptation plan (Phase 5) — before any code

```
npm run sync:plan -- LAT-001
```

Generates `out/plan-<id>.json`: source files, destination moves, functions reused /
adapted / excluded, expected conflicts, required gates, blockers, risk, required tests,
rollback. **No implementation without a blocker-free plan** (`planIsImplementable`).
Blockers include: classification `excluded`/`manual-review`/`already-present`, or unmet
manifest dependencies.

## 5. Implementation (Phase 6)

- One update → **its own branch** `sync/<product>/<id>` (e.g. `sync/supercharged/OBS-001`).
- Its own commits, its own verification, its own downstream PR.
- Reuse pure logic as-is; adapt branding-coupled surfaces (UI, shared components);
  drop excluded surfaces. Preserve downstream branding (copy, colors, logo).
- Shared high-traffic files (`flags.ts`, `package.json`) → partial staging to avoid
  clobbering concurrent downstream work.

## 6. Verification (Phase 7)

```
npm run sync:verify -- OBS-001
```

Runs the gauntlet and records a `VerificationRecord` into `out/verify-<id>.json`:
TypeScript · ESLint · unit · integration · regression · Preview build · **feature-OFF
verification** (flags off ⇒ byte-identical) · **rollback verification**. Results are
written back to the manifest.

## 7. Preview validation (Phase 8)

Standardized on the observability-verify harness pattern: a fresh Preview deployment
with the update's flags set **Preview-only**, driven end-to-end, verifying deployment +
commit + flags + expected behavior + screenshots + trace output + rollback. **Never
auto-deploy Production.** (See `scripts/observability-verify.mjs` upstream for the
reference harness.)

## 8. Approval (Phase 9)

```
npm run sync:approve -- OBS-001 <approver>
```

Generates `out/approval-<id>.json` — manifest + plan + verification + preview reference
+ known differences + rollback + approver + timestamp. This is a **record for a human
to sign**, not an instruction to merge or deploy.

## 9. Drift report + dashboard (Phases 10–11)

```
npm run sync:drift -- supercharged      # answers the six drift questions
npm run sync:dashboard                  # → out/dashboard.html (internal)
```

## Rollback

Every manifest carries `rollbackSteps` (the planner supplies a default when omitted).
The universal rollback order:

1. **Flag OFF first** — `SET <flag>=OFF` is instant, no redeploy, and restores
   byte-identical prior behavior (this is why flags-off-by-default is a hard invariant).
2. **Revert the downstream sync PR** commit(s).
3. **Migrations** (if any) — run the down-migration; confirm no data was written while
   the flag was on.
4. Re-run discovery to confirm the downstream returned to its prior drift baseline.

## Best practices

- **One update = one manifest = one branch = one PR.** Never batch unrelated updates.
- **Flags OFF by default, always.** If an update has behavioral surface and no flag,
  the validator warns — justify or add a flag.
- **Port dependencies first.** `LAT-001` depends on `OBS-001`; the planner blocks it
  until the dependency lands.
- **Preserve downstream branding.** Pure logic is reused; UI/shared-components are
  *adapted*, never blindly copied.
- **Partial-stage shared files** (`flags.ts`, `package.json`) to coexist with
  concurrent downstream sessions.
- **Read-only means read-only.** Discovery/gates/drift never write to a product repo.
- **Dark-launch risky infra** (e.g. the due-job index): maintain + parity-check before
  flipping any read path.
- **Register, don't reimplement.** Completed upstream work enters the registry as a
  historical manifest; the pipeline ports it later, once, per the workflow.
