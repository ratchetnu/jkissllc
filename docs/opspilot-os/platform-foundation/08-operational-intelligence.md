# 08 — Operational Intelligence

**Files:** `app/lib/platform/intelligence/{types,generators,index}.ts` ·
**Tests:** `scripts/intelligence.test.ts` · **Flag:** `INSIGHTS_UI_ENABLED` (off).

## Contract (`types.ts`)
`Insight`: category (16 types incl. revenue/profitability/scheduling/payment-risk/
compliance/cost-anomaly/automation-failure/…), severity (info→critical), tenant,
affected entity, title, plain-language explanation, **evidence (never empty)**,
confidence, financial + operational impact, recommended action, eligible AI
worker, approval requirement, expiry, dismissed/resolved state.

## Three real read-only generators (`generators.ts`)
Each is **pure over an injected snapshot of verified data** (no fabrication; live
fetch is deferred + flagged):
1. **Unconfirmed upcoming assignments** — routes ≤48h out with unconfirmed crew;
   severity scales with proximity; recommends nudge/reassign (L3 → approvalRequired).
2. **AI cost-budget warning** — daily spend ≥80% of the cap; medium→critical.
3. **Overdue reminders** — reminder sends past due without acknowledgement.

## Runner (`index.ts`)
`computeInsights(snap)` stamps the tenant and prioritizes (severity → confidence →
financial impact). `runInsightGenerators(snap)` is the flag-gated entry — **off by
default, returns nothing**, so no insight can surface until explicitly enabled.

## Not done
Live data wiring, the other 13 categories' generators, dismiss/resolve
persistence, and any UI — deferred.
