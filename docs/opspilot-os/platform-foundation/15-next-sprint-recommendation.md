# 15 — Next Sprint Recommendation

With the foundation in place, the next sprint should close the **three
commercialization blockers** that make a second tenant safe — the highest-value,
highest-risk work — behind the flags this sprint created.

## Recommended: "Tenant Isolation" sprint (roadmap Phases 1b–2)

**Objective:** make data isolation real for a second tenant, still with J KISS as
the only live tenant.

1. **Prefix Redis at the chokepoint** — thread the per-handler tenant context
   into `redis.ts` `call()` using the existing `tenantKey` contract, behind
   `TENANCY_ENABLED`. Dark-launch: with the flag off, keys are byte-identical to
   today; with it on (preview), `t:jkiss:` prefixes everything. (Blocker C1.)
2. **Hand-migrate the two bypass files** (`app/api/track`, `app/api/admin/analytics`).
3. **Backfill script** against Upstash directly (no SCAN in the client) to rewrite
   existing keys to `t:jkiss:*` — reversible, dual-read during cutover.
4. **Name-derived-key migration** — `biz:{name}` → `biz:{id}`, rewrite
   `Staff.payByBusiness` maps, scope `learn:*` per tenant. (Blocker C3.)
5. **Tenant-isolation test** as a CI gate — tenant A can never read/write tenant
   B's keys; name collisions are impossible.

**Why this next:** it is the gate to GA, it is the riskiest change (so do it while
J KISS is the only tenant and every step is flag-guarded + dual-read), and it
unblocks per-tenant credentials and billing after.

**Then:** per-tenant credentials + `AsyncLocalStorage`-selected Stripe/Twilio/
Resend, then **Stripe Connect** (blocker H1), then onboarding + plans.

## Exact next prompt
> "Approved. Begin the OpsPilot **Tenant Isolation** sprint (roadmap Phases 1b–2)
> on branch `opspilot/tenant-isolation`, jkissllc only. Wire the per-handler
> tenant context into `redis.ts` `call()` via `tenantKey`, gated by
> `TENANCY_ENABLED` (default off → byte-identical keys). Hand-migrate the two
> analytics bypass files. Write a reversible Upstash backfill (dual-read) and the
> `biz`/`payByBusiness`/`learn` name-key migration. Add a tenant-isolation CI
> gate. Do NOT deploy or run the backfill against prod; show me the diff and the
> dry-run plan first."
