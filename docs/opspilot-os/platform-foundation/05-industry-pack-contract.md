# 05 — Industry Pack Contract

**Files:** `app/lib/platform/industry-packs/{types,jkiss,example-cleaning,config,registry}.ts` ·
**Tests:** `scripts/industry-packs.test.ts` · **Flag:** `INDUSTRY_PACKS_ENABLED` (off).

## Contract (`types.ts`)
An `IndustryPack` supplies vertical DATA — terminology, supported capabilities,
service templates, intake questions, pricing methods, job stages, evidence
requirements, equipment categories, worker requirements, customer communications,
automation templates, per-worker AI instructions, dashboard priorities, compliance
rules — never platform-core logic.

## JKISS pack (`jkiss.ts`)
`jkiss-field-service`, `enabledByDefault: true`. Preserves current terminology
(jobNoun **Route**, workerNoun **Crew**, accountNoun **Business**), the RouteStatus
job stages, box-truck equipment, and the delivery/hauling/moving/junk services.
Covers appliance/final-mile delivery, box-truck ops, hauling, moving, cleanouts.

## Example pack (`example-cleaning.ts`)
`cleaning-residential`, `enabledByDefault: false` — a skeletal shape example
proving the contract generalizes. Offered to no tenant.

## Layered config (`config.ts`)
`resolveConfig(base, { platform, pack, tenant, override })` with precedence
**override → tenant → pack → platform** (tested). Typed and section-scoped (reuse
the `disposal.ts`/`policy.ts` merge-over-defaults pattern), not a mega JSON blob.

## Not done
A tenant-facing pack editor, and extracting J KISS's hardcoded assumptions into
the pack at runtime — deferred (that extraction is roadmap Phase 4).
