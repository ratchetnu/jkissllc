# 07 — AI Operating Layer (Phase 6)

> Cited to `file:line` on `~/jkissllc@main`. Current AI = **FACT**; the target
> intelligence+action architecture = **RECOMMENDATION** built on it.
> Platform brand: **Operion**. Internal identifiers (`opspilot:` Redis prefix,
> `ai:*` Redis key family, `docs/opspilot-os/` path) are retained verbatim as
> legacy identifiers for compatibility.
>
> _(Updated 2026-07-14: two things changed since the 2026-07-12 baseline — (1) the
> live AI feature registry grew from 5 to **7** features with the Book Now vision
> chain, and (2) the "9 assistants" + "0–5 action ladder" this doc recommended are
> now **SCAFFOLDED** as `app/lib/platform/ai-workers/`, flag-gated OFF. Sections
> below mark FACT vs RECOMMENDATION accordingly.)_

## 0. Headline

Operion already has the hard part of a governed AI platform. `runAiTask`
(`app/lib/ai/service.ts`) is a real intelligence-and-governance pipeline, not
a chatbot wrapper — the **single governed chokepoint** every migrated AI feature
passes through. The transformation is **not** "add AI" — it's "extend the
existing governed pipeline from Level 0–2 (inform/recommend/draft) up to Levels
3–4 (approval-gated and policy-bounded action), safely."

## 1. What exists today (FACT)

Pipeline in `runAiTask` (`service.ts`, verified in code):
1. **RBAC** — `can(principal.role, requiredPermission)` → 403 (only when a
   permission is required; public features skip it).
2. **Cost governance** — `overBudget()` → 429 fail-soft; per-tenant-per-day key
   `ai:cost:<tid>:<day>` against `AI_DAILY_COST_CAP_USD` (`budget.ts`).
3. **Prompt resolution** — versioned registry, built-in v1 + Redis overrides +
   A/B arm (`prompts.ts`, `prompt-store.ts`).
4. **Model routing** — `modelForFeature()` (`routing.ts`): resolution order is
   env override `AI_MODEL_<FEATURE>` → per-feature `ROUTES` table → platform
   default. Default model `anthropic/claude-sonnet-4-6` (`app/lib/ai.ts`, env
   `AI_MODEL`), called via the **Vercel AI Gateway** — auto-authenticated by
   `VERCEL_OIDC_TOKEN` in production (no explicit key needed) or `AI_GATEWAY_API_KEY`.
5. **Retries** — transient-only (`network/provider_unavailable/rate_limit`),
   `maxAttempts=2`; permanent failures (billing/auth/bad-request) are not retried.
6. **Cost reconciliation** — provider-actual when the Gateway returns a finite
   cost, else the list-price estimate (`costSource` = `actual`|`estimated`;
   `telemetry.ts`).
7. **Schema validation** — `validateJson` → `invalid_response`/502 (`schema.ts`).
8. **Quality scoring** — heuristic, read-only (`quality.ts`).
9. **Telemetry** — every outcome incl. failures, tenant-stamped; index `ai:log`
   capped 10k (`telemetry.ts`).

_(Updated 2026-07-14 — TENANCY NOTE: the `ai:*` Redis key family that backs prompt
overrides, telemetry, and the daily cost cap is **platform-GLOBAL / shared**, not
tenant-scoped. This is a documented tenancy-activation blocker: before Operion can
serve a second live tenant, `ai:*` prompts and telemetry must be tenant-partitioned.
See `05-multi-tenant-architecture.md`.)_

**Control Center** (`app/admin/operations/ai/page.tsx`): 6 tabs — Overview,
Registry, Prompts (edit→version→activate→rollback→A/B), Quality, Cost,
Observability. **RBAC:** `ai:use` / `ai:analytics` / `ai:prompts:manage`
(`rbac.ts:42-44`). **Eval:** golden-fixture regression gate wired into
`predeploy` (`ai-regression.test.ts`, `package.json:14`).

**The typed safety invariant:** every AI feature is `writes:false`
(`app/lib/ai/registry.ts`). No AI feature mutates authoritative business data
today. _(Updated 2026-07-14: the registry now lists **7** features — the two
Book Now vision passes were added.)_

| Feature | Nature |
|---|---|
| `ops.command` (⌘K palette) | Read-only — model returns an allowlisted id; server builds the href (injection-resistant) |
| `ops.message` | Draft-only — drafts a customer SMS/email a human sends |
| `ops.insights` | Read-only advisory briefing |
| `ops.reviewReply` | Draft-only — drafts a public review reply |
| `ops.photoEstimate` | Public read-only — photo → load size + price range |
| `ops.junkAnalysis` | Public read-only — primary vision pass; itemizes a junk job (volume/truck-fill/labor) as observations, never a price |
| `ops.junkAnalysisReview` | Public read-only — independent second-opinion pass that critiques the primary analysis before an instant quote |

### The Book Now AI chain (FACT — always advisory, owner approves)

The `/quote` "Book Now" flow runs a multi-stage, defense-in-depth AI chain
(`app/lib/ai/*` + `app/lib/book-now-ai.ts` / `book-now-confirmation.ts`), executed
by the durable `book-now-ai` worker off the `*/3min` cron — never inline on the
customer request:

`photo-estimate` → `junk-analysis` (primary vision) → `analysis-monitor`
(consistency/quality check) → `junk-critic` (independent second opinion) →
**deterministic pricing / quote-decision** → routing `decision`
(`instant_quote` | `estimate_range` | `manual_review`) → **guided customer
confirmation** (`StepConfirm` / `guided-approval`) → `confirmed-analysis` (final
pass on the confirmed inputs).

Two invariants hold throughout: **(a)** the vision passes emit *observations only*
— the **deterministic engine sets every price**, the model never does; and **(b)**
the whole chain is **advisory** — the owner approves before any quote is sent
(`manual_review` / `awaiting_approval` gate the queue). This is the concrete,
shipped instance of the "model proposes, deterministic code disposes" rule below.

## 2. What is absent (FACT — the gaps to close before Level 3+)

- **No RAG / retrieval / embeddings** on `main` (a RAG effort lives on a
  non-present branch). Context is hand-built JSON per route.
- **No PII redaction before model calls.** Raw `customerName`, review text, user
  query, and base64 images are passed straight into prompt vars
  (`message/route.ts:29-36`, `review-reply/route.ts:12-19`).
- **No prompt-injection / jailbreak defense.** Free-text drafts forward
  untrusted review/message content into prompts with only length truncation.
- **Quality is heuristic, not LLM-judge** (explicit, `quality.ts`).
- **No action executor, no rollback** — because nothing acts yet. _(Updated
  2026-07-14: an **approval-queue state machine is now scaffolded** at
  `app/lib/platform/approvals/` (`machine.ts` + `types.ts`), flag-gated by
  `APPROVAL_QUEUE_ENABLED` (**OFF**). It is inert data/logic — no executor
  consumes approved requests yet, so the `writes:false` ceiling is intact.)_

## 3. Target AI architecture (RECOMMENDATION)

Extend the existing subsystem into a governed **intelligence + action** system:

```
Context Service ──► builds tenant-scoped, permission-filtered, PII-redacted context
Retrieval Layer ──► RAG over tenant + industry + platform knowledge (NEW)
Tool Registry   ──► typed tools, each declaring {permission, actionLevel, writes}
runAiTask (exists) ─► RBAC → budget → prompt → model → schema → quality → telemetry
Recommendation Engine ─► emits AiRecommendation records
Approval Queue  ──► ApprovalRequest (human-in-the-loop) (NEW)
Action Executor ──► executes ONLY approved/policy-bounded tools, under tenant ctx (NEW)
Audit Trail     ──► AiActionLog (attributed, reversible where possible)
Kill Switch     ──► per-tenant + global AI-action disable (NEW; extends budget cap)
```

Reuse verbatim: telemetry, budget, prompt registry, model routing, schema
validation, eval/regression. Add: context service (with redaction), retrieval,
tool registry, approval queue, action executor, kill switch.

### Cross-tenant & injection safety (must-build before any Level 3)
- **Redaction** in the Context Service: strip/tokenize PII before prompts; never
  place another tenant's data in context (enforce via the same key-prefix
  boundary as `09-data-architecture.md`).
- **Injection defense:** treat uploaded files and inbound messages as untrusted;
  keep the `ops.command` pattern (model emits allowlisted ids, server resolves)
  as the template for all action tools — the model proposes, deterministic code
  disposes.
- **Confidence + explanation** on every recommendation; **redaction of secrets**
  and **per-tenant metering** (already have the metering).

## 4. The 9 assistants (SCAFFOLDED — all on shared platform intelligence)

_(Updated 2026-07-14 — FACT: these nine are now registered in
`app/lib/platform/ai-workers/registry.ts` as `ai-coo`, `ai-dispatcher`,
`ai-sales`, `ai-support`, `ai-finance`, `ai-workforce`, `ai-fleet`,
`ai-marketing`, `ai-advisor`, each with a max-autonomy ceiling and an inherited
prohibited-action set (`governance.ts`). The whole workforce is gated by
`AI_WORKFORCE_ENABLED` (**OFF**) and governance is **fail-closed**. Each is a
*view + tool-set* over the same context/tool registry — **not** a separate prompt
silo — so this remains the target design, now backed by a typed registry rather
than prose.)_

| Assistant | Reads (context) | Proposes (tools) | Max level (recommended) |
|---|---|---|---|
| **AI COO** | ops summary, jobs-at-risk, KPIs | daily briefing, escalations | L0–L1 |
| **AI Dispatcher** | routes, crew availability, equipment | crew assignment, reassignment drafts | L2 (draft) → L3 (approve) |
| **AI Sales Assistant** | leads, quotes, pricing calibration | draft quotes/follow-ups | L2 |
| **AI Support Assistant** | messages, booking context | draft replies (extends `ops.message`) | L2 |
| **AI Finance Analyst** | ledger, invoices, pay | variance flags, forecast (extends `ops.insights`) | L0–L1 |
| **AI Workforce Assistant** | availability, time-off, compliance | schedule drafts, reminder drafts | L2 |
| **AI Fleet/Equipment** | equipment, assignments, maintenance | maintenance-due alerts | L0–L1 |
| **AI Marketing Assistant** | reviews, analytics | review replies (extends `ops.reviewReply`), post drafts | L2 |
| **AI Business Advisor** | everything (read model) | strategic recommendations | L0–L1 |

## 5. Action levels 0–5 (SCAFFOLDED) and mapping

_(Updated 2026-07-14 — FACT: the 0–5 ladder is now code in
`app/lib/platform/ai-workers/autonomy.ts` — `AutonomyLevel` type, `AUTONOMY_LABELS`,
`APPROVAL_REQUIRED_AT = 3`, `requiresApproval()`/`isPolicyBounded()`/
`isAutonomouslyExecutable()` (L5 never executes), and a `PROHIBITED_ACTIONS` set
(permission.change, tenant.administer, record.delete, tax.file, legal.determine,
employee.discipline/terminate, refund.large, bank_account.change,
tenant.cross_access, audit.disable, safety_control.remove). Capability AI actions
carry a `level` field typed to this ladder. It is inert until `AI_WORKFORCE_ENABLED`
is on; the table below is the design intent it encodes.)_

| Level | Meaning | Guardrail |
|---|---|---|
| **L0 Informational** | reads & explains | RBAC read only |
| **L1 Recommendation** | recommends, cannot prepare/execute | logged recommendation |
| **L2 Draft** | prepares message/quote/schedule/invoice for review | human sends; `writes:false` (today's ceiling) |
| **L3 Approval-required** | executes only after authorized approval | ApprovalRequest + audit + rollback |
| **L4 Policy-bounded** | auto-executes within pre-approved rules/limits | tenant policy + per-action cap + kill switch |
| **L5 Prohibited/restricted** | never autonomous | hard-blocked |

**Mapping the prompt's example actions:**

| Action | Level | Why |
|---|---|---|
| Summarize today's operations | L0 | read |
| Identify jobs at risk | L1 | inference, no action |
| Recommend crew assignments | L1 → L2 draft | proposes; human assigns |
| Draft a schedule | L2 | draft |
| Send route confirmations | **L3** | outbound to contractors; approval-gated |
| Reassign a worker | **L3** | affects a person's day/pay |
| Change a customer's price | **L3** (L5 without cap) | revenue integrity |
| Issue a refund | **L5 (or tightly L4 w/ hard cap)** | irreversible money out |
| Create an invoice | **L3** | financial record |
| Send a payment reminder | L4 (policy-bounded) | low-risk, bounded frequency |
| Approve time off | **L3** | employment decision |
| Generate contractor statements | **L3** | financial doc; immutable once issued (`pay-statements.ts`) |
| Generate tax-related documents | **L5** | legal/tax liability |
| Send disciplinary messages | **L5** | employment/legal |
| Delete records | **L5** | irreversible |
| Export customer data | **L3** (owner-only) | privacy/PII |
| Change permissions | **L5** (human-only) | privilege escalation risk |
| Access location data | **L3** | worker-privacy (GPS is PII, `route/[token]:129`) |
| Publish marketing content | **L3** | brand/public |

**Rule:** anything touching money-out, employment, tax, permissions, deletion, or
irreversible external side-effects is **L5 by default** and only demoted to L4
with an explicit tenant-approved policy + hard numeric cap + kill switch. The
current `writes:false` invariant is the correct L2 ceiling; do not lift it
without the approval queue + action executor + audit + rollback in place.

## 6. Evaluation & governance (RECOMMENDATION — extends `13-...`)

Add to the existing eval suite before shipping any Level 3+ tool:
tool-selection tests, AI-authorization tests (a crew-scoped principal cannot
invoke an admin tool), cross-tenant leakage tests (tenant A context never
contains tenant B data), prompt-injection fixtures (malicious review/message),
hallucination checks on structured outputs, and human-approval tests (no
execution without a recorded approval).

## 7. Maturity (2026-07-14)

| Element | Evidence | Maturity |
|---|---|---|
| Governed chokepoint `runAiTask` | `app/lib/ai/service.ts` | **Production Functional** — RBAC→budget→prompt→model→schema→quality→telemetry, live |
| Feature registry (7, `writes:false`) | `app/lib/ai/registry.ts` | **Production Functional** — typed catalog, invariant enforced |
| Prompt store (version/rollback/A-B) | `prompt-store.ts`, AI Control Center | **Production Functional** |
| Book Now AI chain | `book-now-ai.ts` + `app/lib/ai/*` | **Production Functional** — advisory; deterministic pricing; owner approves |
| AI-workers registry + 0–5 ladder | `app/lib/platform/ai-workers/` | **Prototype** — scaffolded, `AI_WORKFORCE_ENABLED` OFF, fail-closed |
| Approval queue | `app/lib/platform/approvals/` | **Prototype** — state machine only, no executor, `APPROVAL_QUEUE_ENABLED` OFF |
| Action executor / rollback / RAG / PII-redaction | — | **Planned / Not Found** — prerequisites for Level 3+ |
| `ai:*` tenant isolation | — | **Planned** — key family is platform-global (activation blocker) |

The live layer is genuinely governed and safe at its `writes:false`, Level-0–2
ceiling; everything that would let AI *act* (Levels 3+) is scaffolded or planned,
not activated.
