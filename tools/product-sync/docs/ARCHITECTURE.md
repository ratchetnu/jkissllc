# Product Synchronization Platform — Architecture

Engineering infrastructure that governs how features move from an **upstream** product
(the canonical engineering source) into **downstream** products *safely, repeatably,
and auditably*. It is **product-agnostic** and **NOT an Operion feature** — it lives in
`tools/product-sync/`, outside the Next build, and ships no customer-facing UI.

Supported relationships (see `products.json`):

- Operion → Supercharged
- Operion → ClaimGuard
- Operion → future editions

> **Key architectural fact:** downstream products are *branded copies with UNRELATED
> git histories* (not forks). There is no common ancestor, so synchronization and
> discovery are **content-based** (path + hash) and **ledger-tracked** (the manifest
> registry), never `git log upstream..downstream`.

## The pipeline

```
                          ┌─────────────────────────────────────────────┐
   UPSTREAM (operion)     │            PRODUCT SYNC PLATFORM             │   DOWNSTREAM
   canonical source       │  tools/product-sync/  (read-only over repos) │   (supercharged, …)
        │                 │                                             │        │
        │  1 DISCOVERY ───▶│  discovery.ts   content diff → DriftReport  │◀───────┤ (read-only)
        │                 │        │                                    │        │
        │  2 CLASSIFY ────▶│  classify.ts    → direct-port | adaptation │        │
        │                 │        │            already | partial |     │        │
        │                 │        │            excluded | manual        │        │
        │  3 GATES ───────▶│  gates.ts       ✓ clean ✓ branch ✓ flags-off│──stop─▶│ (any fail halts)
        │                 │        │            ✓ deps ✓ migration …     │        │
        │  4 PLAN ────────▶│  plan.ts        AdaptationPlan (before code)│        │
        │                 │        │                                    │        │
        │  5 IMPLEMENT ───▶│  branch sync/<product>/<id> · own commits  │───────▶│ downstream PR
        │                 │        │                                    │        │
        │  6 VERIFY ──────▶│  tsc·eslint·unit·regression·preview·flag-off│        │
        │                 │        │            ·rollback → manifest      │        │
        │  7 PREVIEW ─────▶│  Preview deploy · trace · screenshots       │        │
        │                 │        │                                    │        │
        │  8 APPROVE ─────▶│  approval package (manifest+plan+tests+…)   │        │
        │                 │        │                                    │        │
        │  9 DRIFT ───────▶│  drift report + dashboard (Phase 10/11)     │        │
        └─────────────────┴─────────────────────────────────────────────┴────────┘
                          The MANIFEST is the single source of truth read/written at every step.
```

## Components

| Layer | File | Role |
|---|---|---|
| **Manifest schema** | `manifest/schema.ts` | The `UpdateManifest` type, the 11-state status machine (`canTransition`), validation + safety invariants (flags OFF by default). Pure. |
| **Classification** | `classify.ts` | `classifyUpdate(manifest, signals)` → one of 6 classes; exclusion rules (Release Center). Pure. |
| **Planner** | `plan.ts` | `buildAdaptationPlan(manifest)` → source/dest files, reused/adapted/excluded, conflicts, gates, blockers, rollback, risk. Pure. "No implementation without a plan." |
| **Drift model** | `drift.ts` | `DriftReport`/`summarizeDrift`/`answerDriftQuestions`. Pure. |
| **Registry** | `registry/*.json` | One manifest per update — the ledger. Seeded by the initial migration. |
| **Config** | `products.json` | Product topology, repo paths, compare dirs, ignore rules, flags file. |
| **Discovery engine** | `engine/discovery.ts` | READ-ONLY content diff upstream↔downstream → `out/drift-*.json`. |
| **Gates** | `engine/gates.ts` | READ-ONLY Phase-4 compatibility checks; non-zero exit halts the pipeline. |
| **CLI** | `engine/cli.ts` | `plan` / `verify` / `approve` / `drift` — generates artifacts under `out/`. |
| **Dashboard** | `engine/dashboard.ts` | Internal HTML (`out/dashboard.html`) — products, pending/completed/blocked, drift, history, rollout. Not customer-facing. |

**Purity boundary:** all *logic* (schema, classify, plan, drift) is pure TypeScript,
typechecked and unit-tested. All *I/O* (fs, git, child_process) lives in the `engine/`
`.ts` scripts run via `tsx`. The engine is **read-only over product repositories** — it
only ever writes generated reports under `tools/product-sync/out/` (git-ignored).

## Safety invariants (enforced by the schema + gates)

1. **Every synchronized update ships with its feature flags OFF by default** —
   `validateManifest` errors otherwise; the `feature-flags-off` gate re-checks the
   downstream `FLAG_DEFAULTS`. Sync never turns behavior on.
2. **No implementation without a generated, blocker-free plan** (`planIsImplementable`).
3. **Any compatibility-gate failure stops the pipeline** (`gates.ts` exits non-zero).
4. **The engine never writes to a product repo.** Discovery/gates/drift are read-only.
5. **Status changes route through `canTransition`** so the manifest history can't record
   an impossible jump.

## What this sprint delivered

The synchronization *platform* only — schema, engine, registry (8 historical entries),
docs, tests. It performs **no** product synchronization, **no** deploy, **no** merge.
