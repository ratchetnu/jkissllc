# 16 — First Implementation Sprint (Phase 15)

> The safest first sprint. Foundational, not flashy. Cited to `~/jkissllc@main`,
> 2026-07-12. **Do not execute until the owner approves.**

## Principle

The first sprint must (a) change **nothing** users can see, (b) touch **no**
existing Redis data, (c) leave every J KISS flow byte-identical, and (d) lay the
load-bearing foundation (tenant identity + tenant-aware principal + closed
security drift) that every later phase depends on. It is Roadmap **Phase 0 +
Phase 1a**.

## In scope (recommended)

1. **ADRs** — `docs/adr/` with the first three decisions recorded:
   ADR-001 pooled multi-tenancy via Redis key prefix; ADR-002 `AsyncLocalStorage`
   tenant context; ADR-003 Redis-first, Postgres-later-for-billing.
2. **Flag/kill-switch module** — small typed, Redis-backed, global+tenant scope
   (foundation for dark-launching everything). Includes a `TENANCY_ENABLED` flag
   defaulting **off**.
3. **`Tenant` + `User` + `Membership` seed** — types + `t:jkiss` seeded
   byte-identical to today's `company.ts` identity. No existing keys rewritten.
4. **Tenant-aware principal** — `SessionPayload` gains optional `tid`;
   `requireTenantSession(req) → {tenantId,userId,role}`; `getPrincipal` returns it.
   With the flag off, resolves to `t:jkiss` for everyone, so behavior is unchanged.
5. **`AsyncLocalStorage` tenant context** — established in `proxy.ts`, carrying
   `{tenantId, principal}`; read by a new `getTenant()` helper. Not yet used to
   prefix Redis.
6. **Close the cheap security drift (Phase 0):**
   - Fail-closed webhooks (M1): reject Twilio/email if verifying secret absent.
   - Fail-closed cron (L1): reject if `CRON_SECRET` absent.
   - CSPRNG reminder ack token (M2): replace `Math.random` in `reminders.ts:147`.
   - **Authorization-coverage test (H2 detection):** enumerate admin/portal
     routes, assert each guard's permission exists in the matrix; then convert the
     highest-risk coarse `requireSession` routes (reports, disposal, claims) to
     `requirePermission`.
7. **Audit-attribution groundwork (start H3):** make `Principal.sub` available to
   `pushAudit` (thread it, default `'legacy:admin'`), without yet rewriting all
   call sites.
8. **Tests + CI:** new tests green; enable CI branch protection so the gate
   actually blocks.

## Explicitly OUT of scope (do NOT do in sprint 1)

- **No Redis key prefixing** of existing data (that's Phase 1b, dark-launched).
- **No data migration** (businesses/pay maps = Phase 2).
- **No credential/context per-tenant wiring**, no Stripe Connect.
- **No industry-pack extraction**, no UI noun rename, no AI changes.
- **No Postgres**, no schema, no destructive change.

## Acceptance criteria

- With `TENANCY_ENABLED=off` (default), production J KISS is **byte-identical** —
  same routes, same auth, same data, same outputs.
- Every admin/portal route resolves a tenant-scoped `Principal`; the
  authorization-coverage test passes and is blocking in CI.
- `tsc --noEmit` + full `npm test` + AI regression all green in CI.
- The three fail-open gates (Twilio, email, cron) are fail-closed; the reminder
  ack token is CSPRNG.
- `t:jkiss` tenant/membership seed exists and equals today's identity.

## Rollback plan

- Everything new is flag-gated (`TENANCY_ENABLED` off) or additive (new keys under
  `platform:*`, new tests). Revert is a branch revert; **no existing data is
  touched**, so there is nothing to un-migrate. Vercel instant-rollback covers the
  deploy.

## Risk

Low-medium. The one critical-path change is the session/principal signature; it is
covered by the flag (off = today's behavior) and by new principal tests. The
security-drift fixes are surgical and independently valuable.

## Complexity / sizing

Small-to-medium. Bulk of effort is the guard signature change (36 call sites,
mechanical) + tests. The security fixes are hours each.

## Suggested branch & flow

Branch `opspilot/tenancy-foundation` off `main`, jkissllc only (no supercharged
port this engagement). Show the diff before commit; do not deploy until reviewed.

## The exact next prompt to start

> "Approved. Begin OpsPilot First Sprint **Phase 0 + Phase 1a** per
> `docs/opspilot-os/16-first-sprint-plan.md`, on a new branch
> `opspilot/tenancy-foundation`, jkissllc only. Scope: (1) `docs/adr/` with
> ADR-001..003; (2) flag/kill-switch module with `TENANCY_ENABLED` default off;
> (3) `Tenant`/`User`/`Membership` seed with `t:jkiss` byte-identical to today;
> (4) `requireTenantSession` principal + `AsyncLocalStorage` context in
> `proxy.ts`, unused for prefixing; (5) fail-closed Twilio/email/cron gates +
> CSPRNG reminder ack token + authorization-coverage test; (6) thread
> `Principal.sub` into `pushAudit` defaulting `legacy:admin`. Do NOT prefix
> Redis, migrate data, or change the DB. Typecheck + full test suite green; show
> me the diff before committing; do not deploy."
