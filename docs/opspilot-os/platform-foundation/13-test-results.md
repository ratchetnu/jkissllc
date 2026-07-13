# 13 — Test Results

## Gates (branch `opspilot/platform-foundation`)
- `npx tsc --noEmit` — **clean (0 errors)**
- `npm test` (node --test via tsx, all `scripts/*.test.ts`) — **296 pass / 0 fail**
  (baseline was ~220; +76 new)
- `npx eslint` on all new/changed files — **clean (0 errors, 0 warnings)**
- Full **existing** suite unmodified and green (session, rbac, claims, finance,
  reminders, booking-payments, verbal-confirm, doc-crypto, phaseb/phasec, …).

> Note: `npm run build` (`next build`) fails locally on `next/font/google`
> network fetch — a pre-existing, environment-related quirk unrelated to this
> change (prod builds are unaffected). Local verification therefore uses tsc +
> tests + eslint, matching the repo's own `predeploy` gate.

## New test files (14) and what they lock
| File | Asserts |
|---|---|
| `platform-flags.test.ts` | flag defaults + env parsing + override isolation |
| `platform-tenancy.test.ts` | seed equality, tenantKey compat + fail-closed, principal, context scope, cross-tenant denial, requireTenantSession round-trip |
| `security-hardening.test.ts` | CSPRNG ack token, attributed audit |
| `webhook-cron-auth.test.ts` | webhook + cron fail-closed (at the handler) |
| `authorization-coverage.test.ts` | every admin route has a server-side guard |
| `platform-capabilities.test.ts` | registry validity, role visibility, tenant enablement, AI eligibility |
| `ai-workers.test.ts` | undeclared capability/tool, missing perm, tenant-disabled, approval-not-bypassed, Level-5 block, kill switch, audit-always |
| `industry-packs.test.ts` | JKISS preserved, example disabled, config precedence, cap cross-refs |
| `business-events.test.ts` | envelope validation, tenant requirement, versioning, idempotent outbox, correlation |
| `approvals.test.ts` | legal transitions, mandatory decider, no approval-bypass, restricted-unapprovable, rollback |
| `intelligence.test.ts` | 3 generators, prioritization, flag gating, tenant stamping |
| `workspaces.test.ts` | destination integrity, persona visibility, route-map coverage |
| `observability.test.ts` | key + value redaction, nested, logger never emits secrets |
| `design-system.test.ts` | all 18 primitives exported as components |

## Coverage mapped to the sprint's required tests
Tenant isolation ✓ · authorization ✓ · capability dependencies ✓ · role visibility
✓ · AI worker permissions ✓ · AI autonomy levels ✓ · kill switches ✓ · approval
requirements ✓ · event validation ✓ · audit attribution ✓ · webhook/cron failure
✓ · secure token generation ✓ · configuration precedence ✓ · existing J KISS
critical workflows ✓ (untouched, green).

## Deferred test layers (need new harness — see `../13-testing-and-ai-evaluation.md`)
DOM-based component/accessibility tests (jsdom/Playwright), integration/e2e flows,
and AI prompt-injection/leakage tests (arrive with the context service).
