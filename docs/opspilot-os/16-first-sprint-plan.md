# 16 — First Implementation Sprint (Phase 15) — **DONE as S1**

> The safest first sprint. Foundational, not flashy. Cited to `~/jkissllc@main`,
> originally authored 2026-07-12.
>
> _(Updated 2026-07-14: **This sprint is EXECUTED — shipped to `main` + prod as
> "S1".** The "do not execute until the owner approves" framing is removed: it was
> approved and it happened. What actually shipped is captured in **§Executed (S1)**
> below; the recommended-scope list that follows is retained as the historical
> plan. The **new next Stage-0 sprint** is **dark-launch validation** — see §The
> next Stage-0 sprint.)_

## Principle

The first sprint had to (a) change **nothing** users can see, (b) touch **no**
existing Redis data, (c) leave every J KISS flow byte-identical, and (d) lay the
load-bearing foundation (tenant identity + tenant-aware principal + closed
security drift) that every later phase depends on. It was Roadmap **Phase 0 +
Phase 1a**. _(All four held — see §Executed.)_

## Executed (S1) — what actually shipped _(Updated 2026-07-14)_

Operion (legacy internal id: `opspilot:` Redis prefix + `app/lib/platform/`
paths, retained for compatibility) tenant-context wiring is **live on `main` +
prod** as a **byte-identical no-op** (`TENANCY_ENABLED=false`):

- **Per-request tenant context on 104 request handlers** via the central wrapper
  `app/lib/platform/tenancy/with-tenant-route.ts` (`withTenantRoute` +
  `activeTenantIds()`), and **explicit per-tenant context on 3 crons + 3
  webhooks** via `withBackgroundTenant` (`app/api/cron/{daily,reminders,ai-jobs}`,
  `app/api/webhooks/{email,twilio/sms,twilio/status}`). This is the
  **per-handler** `runWithTenant(...)` approach corrected in `19-...` (ALS cannot
  bridge `proxy.ts`→handlers).
- **Redis chokepoint fails CLOSED:** `app/lib/redis.ts` routes every key through
  `scopeKey()` and throws if `TENANCY_ENABLED` is on without a tenant context.
- **Bypass-detection is a blocking CI gate:** `scripts/bypass-detection.test.ts`.
- **Anti-spoofing:** `proxy.ts` strips inbound `x-tenant-id`; identity comes only
  from the signed session (`tid`) → `requireTenantSession`.
- With the flag off, prod is **live no-op / byte-identical**; flipping it in the
  isolated Preview is the next step (below), not a prod change.

Remaining foundation items (seed types, ADRs, config sections) tracked under
`15-migration-roadmap.md` S2. The security-drift fixes (M1/M2/L1/H2/H3
groundwork) shipped — see `20-security-hardening-sprint.md`.

## In scope (recommended) — _historical plan, now delivered_

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

## Acceptance criteria _(all MET as of S1, 2026-07-14)_

- ✅ With `TENANCY_ENABLED=off` (default), production J KISS is **byte-identical** —
  same routes, same auth, same data, same outputs. (104 handlers + 3 crons + 3
  webhooks carry context that is inert while the flag is off.)
- ✅ Every admin/portal route resolves a tenant-scoped principal; the
  authorization-coverage test passes and is blocking in CI.
- ✅ `tsc --noEmit` + full `npm test` (now **586 cases / 75 files**) + AI
  regression + **`next build`** all green in the blocking CI job
  (`.github/workflows/ai-regression.yml`, Node 24 via `.nvmrc`).
- ✅ The three fail-open gates (Twilio, email, cron) are fail-closed; the reminder
  ack token is CSPRNG.
- ✅ `t:jkiss` tenant/membership seed exists and equals today's identity.

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

## Branch & flow _(delivered)_

Shipped jkissllc-only (no supercharged port this engagement). The tenant-context
wiring was reviewed as a diff and is now on `main` + prod as S1. Branch name
`opspilot/tenancy-foundation` (legacy internal identifier) referenced the working
branch; product-facing name is **Operion**.

## The next Stage-0 sprint — **dark-launch validation** _(Updated 2026-07-14)_

Tenant Context Wiring (the sprint above) is **complete**, so the next Stage-0
step is **not** re-doing it — it is to **validate the isolated dark-launch
Preview**. An isolated Preview environment already exists: a separate Upstash
Redis (`OperionPreview`) + Blob (`operion-preview-blob`), with Preview-only flags
`TENANCY_ENABLED=false` + `TENANCY_DARK_LAUNCH=true`, fully data-isolated from
Production. Dark-launch **telemetry has not yet been exercised** — status is
**DARK-LAUNCH READY, NOT YET VERIFIED**.

**Scope of the validation sprint:**

1. In the isolated Preview, exercise real workflows end-to-end (book-now intake,
   admin operations, pay/claims reads, messaging) so the dark-launch comparator
   (`app/lib/platform/tenancy/dark-launch.ts`) runs its legacy-vs-tenant key
   compare on live paths.
2. Inspect the `tenancy:dark-launch-mismatch` telemetry (legacy internal
   identifier, retained for compatibility) for any divergence between the current
   (unscoped) key and the would-be tenant-scoped key.
3. Triage each mismatch class; feed the collision classes into S2
   (`15-migration-roadmap.md`): Blob path scoping, `ai:*` prompt/telemetry
   scoping, and the name-derived key collisions (`businesses.ts` bizKey→payroll,
   `job-learning.ts`).
4. **Only after** dark-launch is verified clean does S2 (data migration under
   `DARK_LAUNCH`→`DUAL_WRITE`, public-route host-based tenant resolution) begin.

**Acceptance:** dark-launch mismatch telemetry reviewed with every mismatch class
either explained (safe) or ticketed into S2; Production untouched (flag stays
off); Preview remains data-isolated. **Rollback:** none needed — Preview-only, no
prod change, no data migration.
