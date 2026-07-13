# 13 — Testing & AI Evaluation (Phase 12)

> Cited to `file:line` on `~/jkissllc@main`, 2026-07-12.

## 1. What exists (FACT)

- **Runner:** Node `--test` via `tsx@4` (no Jest/Vitest). **23 `scripts/*.test.ts`,
  ~220 cases.** Strong coverage on the money/claims/AI core: `claims.test.ts`
  (~40), `finance.test.ts` (18), `doc-crypto.test.ts` (16),
  `booking-payments.test.ts` (15), `reminders.test.ts` (13), plus `rbac`,
  `session`, `verbal-confirm`, `applicants`, `crew-comp`, `phaseb/phasec`.
- **AI eval:** a real evaluation harness — `ai-service`(12) + `ai-phase2`(12) +
  `ai-phase3`(10) + `ai-audit`(6) + `ai-regression`(2). Golden-fixture regression
  (`eval.ts` `FIXTURES`) asserts every prompt renders, every registered feature
  has fixture coverage, structured outputs validate, and quality thresholds hold.
- **Gate wiring:** `predeploy` = `tsc --noEmit && test:ai:regression`
  (`package.json:14`); CI (`ai-regression.yml`) runs typecheck + `test:ai` +
  regression on push/PR — but is **advisory** (doesn't block Vercel deploy).

## 2. Gaps (FACT)

- **No integration/API/webhook/e2e/component/visual/accessibility/load tests.**
  Tests are unit-level against lib modules (mostly pure logic + Redis-mocked).
- **No authorization-coverage test** — nothing asserts a route's guard matches
  the RBAC matrix (this is why the enforcement drift, `H2`, went unnoticed).
- **No tenant-isolation test** — because tenancy doesn't exist yet.
- **CI doesn't run the full suite** (`test`), only `test:ai`; and doesn't gate deploy.

## 3. Target quality strategy (RECOMMENDATION)

Layered, sized for the stack (Node test runner + Playwright for e2e; no new heavy
frameworks unless justified).

| Layer | Scope | Priority |
|---|---|---|
| **Unit** (have) | lib logic, money math, state machines | keep + expand |
| **Authorization** (NEW) | every admin/portal route asserts its guard = matrix entry; crew cannot reach admin tools | **P0** |
| **Tenant-isolation** (NEW, with tenancy) | tenant A request never reads/writes tenant B keys; name-derived keys don't collide | **P0** (blocks GA) |
| **Integration** (NEW) | book→pay→webhook→record; route confirm→clock→pay; quote→lead | P1 |
| **Webhook** (NEW) | Stripe/Twilio/email signature verify incl. **fail-closed** (M1 regression) | P1 |
| **Background-job** (NEW) | cron sweep idempotency, outbox drain, dead-letter | P1 |
| **Component + a11y** (NEW) | the promoted `ui.tsx` primitives; axe checks; focus-trap | P2 |
| **E2E** (NEW, Playwright) | the minimum must-pass flows below | P1 |
| **Visual-regression** (NEW) | key screens across light/dark, mobile/desktop | P3 |
| **Load** (NEW) | quote→pay and route-confirm critical paths | P3 |

## 4. AI evaluation strategy (RECOMMENDATION — extends `eval.ts`)

Before any Level-3 AI action ships, add:

| AI test | Asserts |
|---|---|
| **Tool-selection** | model picks the correct tool for an intent (extends command-palette id tests) |
| **AI-authorization** | a crew/manager principal cannot invoke a tool above their permission (`runAiTask` RBAC path) |
| **Cross-tenant leakage** | context built for tenant A never contains tenant B data (the leakage test that tenancy demands) |
| **Prompt-injection** | fixtures with malicious review/message text do not alter tool choice or exfiltrate |
| **Hallucination** | structured outputs validate against schema; ids must be allowlisted (already the pattern) |
| **Human-approval** | no Level-3 tool executes without a recorded `ApprovalRequest` |
| **Cost/latency** | telemetry stays within per-tenant budget; p95 within target |
| **Rollback** | a failed/reverted AI action leaves state consistent |

Keep the golden-fixture regression as the deploy gate; add the above to `test:ai`.

## 5. Minimum must-pass-before-deploy set (RECOMMENDATION)

Wire these into CI **and make CI blocking** (enable branch protection —
`ai-regression.yml:6-10` already notes this is off):

1. `tsc --noEmit` (already in predeploy).
2. Full unit suite (`npm test`), not just `test:ai`.
3. AI regression gate (already).
4. **Authorization-coverage test** (new — cheap, catches privilege drift).
5. **Tenant-isolation test** (once tenancy lands — the GA gate).
6. E2E smoke: book→pay→confirm and login→route-confirm→clock.

## 6. Immediate, low-cost win

Add the **authorization-coverage test** now (before any tenancy work): enumerate
admin/portal routes, assert each calls a guard whose required permission exists
in the matrix and matches intent. This turns `H2` from an invisible drift into a
CI failure and prevents regressions during the migration.
