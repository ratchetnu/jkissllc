# 07 — AI Operating Layer (Phase 6)

> Cited to `file:line` on `~/jkissllc@main`, 2026-07-12. Current AI = **FACT**;
> the assistant catalog and action-level model = **RECOMMENDATION** built on it.

## 0. Headline

OpsPilot already has the hard part of a governed AI platform. `runAiTask`
(`app/lib/ai/service.ts:71`) is a real intelligence-and-governance pipeline, not
a chatbot wrapper. The transformation is **not** "add AI" — it's "extend the
existing governed pipeline from Level 0–2 (inform/recommend/draft) up to Levels
3–4 (approval-gated and policy-bounded action), safely."

## 1. What exists today (FACT)

Pipeline in `runAiTask` (`service.ts:13-24`, verified in code):
1. **RBAC** — `can(principal.role, requiredPermission)` → 403 (`service.ts:94-97`).
2. **Cost governance** — `overBudget()` → 429 fail-soft (`service.ts:100-105`;
   per-tenant-per-day key `ai:cost:<tid>:<day>`, `budget.ts:11`).
3. **Prompt resolution** — versioned registry, built-in v1 + Redis overrides +
   A/B arm (`prompts.ts`, `prompt-store.ts`).
4. **Model routing** — `modelForFeature()` (`routing.ts`); default
   `anthropic/claude-sonnet-4-6` (`ai.ts:8`), via Vercel AI Gateway.
5. **Retries** — transient-only (`network/provider_unavailable/rate_limit`),
   `maxAttempts=2` (`service.ts:119-129`).
6. **Cost reconciliation** — provider-actual when finite else estimated
   (`service.ts:138-143`, `telemetry.ts:55-73`).
7. **Schema validation** — `validateJson` → `invalid_response`/502
   (`service.ts:156-161`, `schema.ts`).
8. **Quality scoring** — heuristic, read-only (`quality.ts`).
9. **Telemetry** — every outcome incl. failures, tenant-stamped
   (`telemetry.ts:14-45`; index `ai:log` capped 10k).

**Control Center** (`app/admin/operations/ai/page.tsx`): 6 tabs — Overview,
Registry, Prompts (edit→version→activate→rollback→A/B), Quality, Cost,
Observability. **RBAC:** `ai:use` / `ai:analytics` / `ai:prompts:manage`
(`rbac.ts:42-44`). **Eval:** golden-fixture regression gate wired into
`predeploy` (`ai-regression.test.ts`, `package.json:14`).

**The typed safety invariant:** every AI feature is `writes:false`
(`registry.ts:25-59`). No AI feature mutates business data today. The 5 features:

| Feature | Nature |
|---|---|
| `ops.command` (⌘K palette) | Read-only — model returns an allowlisted id; server builds the href (injection-resistant) |
| `ops.message` | Draft-only — drafts a customer SMS/email a human sends |
| `ops.insights` | Read-only advisory briefing |
| `ops.reviewReply` | Draft-only — drafts a public review reply |
| `ops.photoEstimate` | Public read-only — photo → load size + price range |

## 2. What is absent (FACT — the gaps to close before Level 3+)

- **No RAG / retrieval / embeddings** on `main` (a RAG effort lives on a
  non-present branch). Context is hand-built JSON per route.
- **No PII redaction before model calls.** Raw `customerName`, review text, user
  query, and base64 images are passed straight into prompt vars
  (`message/route.ts:29-36`, `review-reply/route.ts:12-19`).
- **No prompt-injection / jailbreak defense.** Free-text drafts forward
  untrusted review/message content into prompts with only length truncation.
- **Quality is heuristic, not LLM-judge** (explicit, `quality.ts:9`).
- **No approval queue, no action executor, no rollback** — because nothing acts yet.

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

## 4. The 9 assistants (RECOMMENDATION — all on shared platform intelligence)

Each is a *view + tool-set* over the same context/tool registry, **not** a
separate prompt silo:

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

## 5. Action levels 0–5 (RECOMMENDATION) and mapping

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
