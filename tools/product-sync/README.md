# Product Synchronization Platform

Engineering infrastructure that governs how features move from an **upstream** product
(Operion / jkissllc) into **downstream** products (Supercharged, ClaimGuard, future
editions) — safely, repeatably, auditably. **Product-agnostic. Not a product feature.
No customer-facing UI.** Lives outside the Next build (`tools/product-sync/`).

## Layout

```
tools/product-sync/
  manifest/schema.ts    Update manifest type, 11-state status machine, validation
  classify.ts           Classification (6 classes) + exclusion rules
  plan.ts               Adaptation planner ("no implementation without a plan")
  drift.ts              Drift model + summariser + the six drift questions
  products.json         Product topology + compare config (content-based; unrelated histories)
  registry/*.json       The ledger — one manifest per update (8 historical entries seeded)
  engine/               Read-only Node/tsx scripts (never write to product repos):
    lib.ts                registry/config loaders, content hashing, git, flags/deps readers
    discovery.ts          Phase 2 — content diff upstream↔downstream → out/drift-*.json
    gates.ts              Phase 4 — compatibility gates; non-zero exit halts the pipeline
    cli.ts                Phases 5/7/9/10 — plan | verify | approve | drift
    dashboard.ts          Phase 11 — internal HTML dashboard → out/dashboard.html
  docs/                 ARCHITECTURE.md · WORKFLOW.md · MANIFEST.md
  out/                  Generated reports (git-ignored)
```

## Commands (all read-only over product repos)

```
npm run sync:discover  -- supercharged      # Phase 2  content drift report
npm run sync:gates     -- supercharged      # Phase 4  compatibility gates (halts on fail)
npm run sync:plan      -- OBS-001           # Phase 5  adaptation plan (before coding)
npm run sync:verify    -- OBS-001           # Phase 7  verification gauntlet → manifest
npm run sync:approve   -- OBS-001 <name>    # Phase 9  approval package
npm run sync:drift     -- supercharged      # Phase 10 drift questions
npm run sync:dashboard                      # Phase 11 internal dashboard
npm run test:sync                           # unit tests for the pure logic
```

## Safety invariants

1. Every synchronized update ships with **feature flags OFF by default** (schema errors otherwise).
2. **No implementation without a blocker-free adaptation plan.**
3. **Any compatibility-gate failure stops the pipeline.**
4. **The engine never writes to a product repository** — reports go to `out/` only.
5. Status changes route through the validated status machine.

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) and [docs/WORKFLOW.md](./docs/WORKFLOW.md).
This sprint built the platform only — **no product sync, no deploy, no merge.**
