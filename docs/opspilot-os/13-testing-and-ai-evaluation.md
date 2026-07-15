# 13 — Testing & AI Evaluation (Phase 12)

> Product: **Operion** (J KISS LLC is the first production tenant). Cited to
> `file:line` on `~/jkissllc@main`, baseline 2026-07-12, refreshed 2026-07-14.

## 1. What exists (FACT)

_(Updated 2026-07-14: the suite roughly tripled — **23 → 75 test files, ~220 → 586
cases** — and the security/tenancy layers that were "gaps" below now exist as real
tests. CI was hardened from advisory-AI-only into a **blocking full gate**.)_

- **Runner:** Node `--test` via `tsx@4` (no Jest/Vitest), invoked as
  `npm test` = `tsx@4 --test scripts/*.test.ts` (`package.json`). **75
  `scripts/*.test.ts`, ~586 cases.** Strong coverage on the money/claims/AI core:
  `claims.test.ts`, `finance.test.ts` (18), `doc-crypto.test.ts` (16),
  `booking-payments.test.ts` (15), `reminders.test.ts` (13), plus `rbac`,
  `session`, `verbal-confirm`, `applicants`, `crew-comp`, `phaseb/phasec`.
- **Security & tenancy suites (NEW since baseline):** `tenant-isolation`,
  `bypass-detection` (asserts every Redis key routes through `scopeKey()` — no raw
  Upstash calls in feature code), `rbac`, `authorization-coverage` (route guard ↔
  RBAC matrix), and `security-hardening`. These make the former P0 gaps real,
  runnable gates — see §2/§5.
- **AI eval:** a real evaluation harness — `ai-service`(12) + `ai-phase2`(12) +
  `ai-phase3`(10) + `ai-audit`(6) + `ai-regression`. Golden-fixture regression
  (`eval.ts` `FIXTURES`) asserts every prompt renders, every registered feature
  has fixture coverage, structured outputs validate, and quality thresholds hold.
- **Gate wiring:** `predeploy` = `tsc --noEmit && test:ai:regression`
  (`package.json`). CI (`.github/workflows/ai-regression.yml`, job `verify`) now
  runs **`tsc --noEmit` → the FULL `npm test` (all 586 cases, incl.
  tenant-isolation, bypass-detection, rbac, authorization-coverage,
  security-hardening, AI regression, workflow tests) → `next build`** on the Node
  version pinned by `.nvmrc` (**Node 24**, matching `engines: ">=24 <25"`), on every
  push to `main` and every PR. _(Updated 2026-07-14: previously advisory and
  AI-only; now a blocking full quality gate. Note: to make it a hard-stop on the
  actual Vercel deploy still requires branch protection or Vercel "only deploy when
  checks pass" — the workflow header documents this.)_

## 2. Gaps (FACT)

_(Updated 2026-07-14: most former gaps are now CLOSED. Remaining gaps narrowed to
higher layers.)_

- **CLOSED — authorization-coverage:** `authorization-coverage.test.ts` now asserts
  route guards match the RBAC matrix (this was the `H2` enforcement-drift gap).
- **CLOSED — tenant-isolation:** `tenant-isolation` + `bypass-detection` tests now
  exist (tenancy context wiring landed as S1; see `05-...`, `14-...`, `16-...`).
- **CLOSED — CI full suite + blocking:** CI now runs the full `npm test` and is a
  blocking gate (branch-protection/Vercel-gate is the only remaining opt-in step).
- **STILL OPEN — no e2e / component / visual-regression / load tests, and limited
  integration/webhook coverage at the HTTP layer.** The 586 cases are still
  predominantly unit/logic-level against lib modules (pure logic + Redis-mocked);
  there is no Playwright browser suite yet. These are the P1–P3 layers in §3.

## 3. Target quality strategy (RECOMMENDATION)

Layered, sized for the stack (Node test runner + Playwright for e2e; no new heavy
frameworks unless justified).

_(Updated 2026-07-14: Authorization and Tenant-isolation moved from NEW → HAVE.)_

| Layer | Scope | Priority |
|---|---|---|
| **Unit** (have) | lib logic, money math, state machines | keep + expand |
| **Authorization** (HAVE) | `authorization-coverage.test.ts` — every admin/portal route asserts its guard = matrix entry; crew cannot reach admin tools | **DONE** (keep green) |
| **Tenant-isolation** (HAVE) | `tenant-isolation` + `bypass-detection` — tenant A request never reads/writes tenant B keys; every key routes via `scopeKey()`; name-derived keys still a known risk (`14-...`) | **DONE**; deepen before activation |
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

_(Updated 2026-07-14: items 1–5 are DONE and wired into the blocking CI `verify`
job. The workflow header still notes that a hard-stop on the Vercel deploy needs
branch protection or the Vercel "only deploy when checks pass" setting — that is
the one remaining opt-in.)_

1. `tsc --noEmit` — **DONE** (in `predeploy` and CI).
2. Full suite (`npm test`, all 586 cases) — **DONE** (CI now runs the full suite).
3. AI regression gate — **DONE**.
4. **Authorization-coverage test** — **DONE** (`authorization-coverage.test.ts`).
5. **Tenant-isolation test** — **DONE** (`tenant-isolation` + `bypass-detection`);
   deepen name-derived-key collision coverage before data activation.
6. E2E smoke: book→pay→confirm and login→route-confirm→clock — **STILL OPEN**
   (no Playwright suite yet; the top remaining testing gap).

## 6. Immediate, low-cost win

_(Updated 2026-07-14: the original low-cost win — the authorization-coverage
test — is DONE and green in CI, so `H2` drift is now a CI failure rather than an
invisible risk.)_ The next low-cost win is an **e2e smoke** on the two critical
paths (book→pay→confirm, login→route-confirm→clock) — the only P1 layer with zero
coverage today — plus deepening tenant-isolation to assert the known
name-derived-key collisions (`businesses.ts` bizKey, `job-learning.ts`) don't
cross tenants once activation begins.
