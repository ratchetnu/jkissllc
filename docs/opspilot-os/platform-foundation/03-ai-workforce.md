# 03 — AI Workforce

**Files:** `app/lib/platform/ai-workers/{autonomy,types,registry,governance}.ts` ·
**Tests:** `scripts/ai-workers.test.ts` · **Flag:** `AI_WORKFORCE_ENABLED` (off).

## Autonomy ladder (`autonomy.ts`)
L0 Informational · L1 Recommendation · L2 Draft · L3 Approval-required · L4
Policy-bounded · L5 Prohibited. `requiresApproval` = L3; `isPolicyBounded` = L4;
L5 is never executable. A fixed `PROHIBITED_ACTIONS` set (permission changes,
tenant admin, deletion, tax filing, legal, discipline, termination, large refunds,
bank-account changes, cross-tenant access, audit-disable, safety-control removal)
is always Level-5.

## The nine workers (`registry.ts`)
AI COO, Dispatcher, Sales, Support, Finance, Workforce, Fleet, Marketing, Advisor.
Each declares: allowed capabilities + tools, the human permissions the invoker
needs, data domains, default autonomy, approval threshold, budget + rate limits,
audit-required, prohibited actions (incl. the global set), escalation rule, tenant
enablement, industry-pack compatibility, prompt-version id, model-routing policy,
and PII/location/financial access rules. Defaults are conservative (PII redacted,
no location/financial, approval at L3, audit on).

## Governance engine (`governance.ts`)
`authorizeWorkerAction(req)` enforces, fail-closed at each step:
1. **kill switch** (global or per-tenant) overrides everything;
2. **AI workforce enabled** (flag);
3. **tenant enablement**;
4. **declared capability/tool only**;
5. **invoker holds all required permissions**;
6. **Level-5 / prohibited → never executes**;
7. **L3 → requires recorded approval** (cannot auto-execute).
**Audit metadata is produced on every decision — allow and deny.** It reuses the
existing `runAiTask` governance rather than replacing it (workers become the
declarative layer feeding it in a later phase).

## Not done
Wiring workers into live `runAiTask` calls, the conversational interface, and the
context/redaction service — all deferred (`14-deferred-work.md`).
