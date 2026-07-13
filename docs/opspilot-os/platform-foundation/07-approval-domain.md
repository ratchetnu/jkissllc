# 07 — Approval Domain

**Files:** `app/lib/platform/approvals/{types,machine}.ts` ·
**Tests:** `scripts/approvals.test.ts` · **Flag:** `APPROVAL_QUEUE_ENABLED` (off).

## Model (`types.ts`)
`ApprovalRequest`: requested action, requesting worker, tenant, approver role,
risk class (`low/medium/high/restricted`), action preview, explanation, evidence,
confidence, expected impact, expiry, status, decider, decision reason, execution
result, rollback metadata. Statuses: draft, pending, approved, rejected, expired,
executing, completed, failed, cancelled (five terminal).

## State machine (`machine.ts`)
`transition(req, to, opts)` enforces:
- **Legal transitions only** — `executing` is reachable **only from `approved`**,
  so nothing executes that was not approved (`pending → executing` is illegal).
- **A human decider is mandatory** for `approved`/`rejected`.
- **Restricted (Level-5) actions can never be approved** via the queue.
- Prohibited action ids **floor the risk to `restricted`** (`riskFloorForAction`).
Failure carries rollback metadata; terminal statuses have no outgoing edges.

## Safety
No automatic execution for financial, disciplinary, legal, tax, permission, or
destructive actions — those are restricted and unapprovable here. Nothing executes
this sprint (no executor; flag off).

## Not done
The action executor, persistence, expiry sweeper, and the admin approval view —
deferred (roadmap Phase 7).
