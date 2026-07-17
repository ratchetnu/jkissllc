# Operion Multi-Tenant — Executive Summary

> Companion to `2026-07-17-multitenant-readiness-audit.md`. One-page decision brief
> for whoever plans the next tenancy sprint. Verified against `main @ a7ac3f6`.
> Audit-only artifact — no production behavior has changed.

---

## Current maturity level

**Level 4 of 5 — "Built & wired, dormant."** The multi-tenant foundation is not a
plan; it is merged code sitting behind `TENANCY_ENABLED=false`.

| # | Maturity stage | Status |
|---|---|---|
| 1 | No primitives | passed |
| 2 | Models + types defined | passed |
| 3 | Chokepoints built | passed — `scopeKey()` (Redis) + `scopeBlobPath()` (Blob) |
| 4 | **Chokepoints wired, flag-off (byte-identical today)** | **← we are here** |
| 5 | Isolation enforced (flag on) for ≥1 real tenant | not started |

Evidence: 138/169 routes `withTenantRoute`-wrapped; session token carries
`tid/sub/role/staffId`; RBAC matrix live; real per-user credentials (`users.ts`);
1254/1254 tests pass. The gap between L4 and L5 is a **small, bounded set of items
that key-prefixing alone does not fix** — not a rebuild.

---

## Highest-priority remaining gaps

| ID | Gap | Risk | Why it blocks the flag |
|---|---|---|---|
| **G1** | Public `[token]` routes can't resolve tenant before the record read | HIGH | Enabling the flag fails booking/route/invoice/portal links closed |
| **G2** | Inbound Twilio SMS webhook hardcodes `activeTenantIds()[0]` | HIGH | All inbound SMS + opt-outs misattribute to tenant #0 once >1 tenant |
| **G3** | Name/external-derived keys (`biz:{name}`, `promo`, `ship`, `cust:*`, `msg:phone`, `Staff.payByBusiness`) | HIGH | Two tenants collide/merge within the shared store |
| **G4** | 2 Blob writes bypass `scopeBlobPath` (`image-convert.ts:77` + client-upload brokers) | MEDIUM | Objects land in the shared namespace under tenancy |
| **G5** | `AuditEntry` has no `tenantId`; many `pushAudit` sites log `'admin'/'system'` | MEDIUM | No per-tenant forensics / real actor attribution |
| **G6** | Per-tenant credential + edition layer (Stripe/Twilio/Resend/Blob, capabilities) | MEDIUM | Only needed when a 2nd tenant onboards; revenue commingling risk |
| **G7** | `toPrincipal` fail-open defaults (no role → admin) | LOW | Safe only while every mint sets claims |

---

## Recommended implementation order

Ordered so each step is independently shippable and de-risks the next.

1. **G1** — global `token → tenantId` index (unblocks public routes; prerequisite for any flag-on Preview).
2. **G4** — route the 2 blob bypasses through `scopeBlobPath` (small, isolated, no data migration).
3. **G5** — add `tenantId` to `AuditEntry` + a `listAudit` filter; roll `pushAudit`→`pushAuditFor` at hot sites.
4. **Dark-launch validation** — `TENANCY_DARK_LAUNCH` on Preview, watch mismatch telemetry.
5. **Dual-write + backfill** — `TENANCY_DUAL_WRITE` + `scripts/tenant-migration` for `t:jkiss:*`, verify parity.
6. **Flag on (Preview only)** — flip `TENANCY_ENABLED`; validate J KISS end-to-end.
7. **G3** — name→id data migration (`biz:id:{stableId}`, remap `payByBusiness`/`businessKey`). Cautious, dry-run first.
8. **G2** — recipient-number → tenant map (coordinate with the comms session).
9. **G6** — per-tenant credentials + editions (only when onboarding tenant #2).
10. **G7** — harden `toPrincipal` defaults (fold into G6).

---

## Estimated implementation complexity

Scale: **S** ≤1 day · **M** 2–4 days · **L** 1–2 weeks · **XL** multi-week / external deps.

| ID | Complexity | Notes |
|---|---|---|
| G1 | **M** | New platform-scoped index + write hooks in 4 `[token]` libs; additive, reversible |
| G2 | **M** | Needs a number→tenant registry; touches comms-owned files (coordinate) |
| G3 | **L** | True data migration (name→stable id) + value-embedded map rewrites; dry-run + rollback manifest |
| G4 | **S** | Mechanical — 3 call sites onto the existing helper |
| G5 | **S–M** | Schema field + one filter + incremental actor rollout |
| G6 | **XL** | Stripe Connect, Twilio subaccounts, Resend domains, de-`NEXT_PUBLIC_`; external provisioning |
| G7 | **S** | Guard + tests; fold into G6 |
| Dark-launch / dual-write / cutover | **M** | Tooling exists; this is operational validation, not new code |

---

## Dependencies between phases

```
G1 ─┐
G4 ─┼─► Dark-launch ─► Dual-write+backfill ─► Flag ON (Preview) ─► G3 ─► G2
G5 ─┘                                                               │
                                                                    └─► G6 ─► G7
```

- **G1, G4, G5 are independent** of each other and can land in parallel; all three
  should precede the first flag-on Preview.
- **Dark-launch → dual-write → cutover** is a strict sequence (validate before mirror before flip).
- **G3 (name→id) must follow a green flag-on Preview** so migration parity is observable.
- **G2** depends on a working tenant registry (post-cutover) and coordinates with the comms session.
- **G6/G7** are gated on an actual 2nd-tenant onboarding decision — do not build ahead of demand.

---

## Recommended merge order

1. **This audit branch (`audit/multitenant-foundation`)** — docs + inert diagnostic. Merge first / anytime; zero code risk.
2. **G4, G5** — small, self-contained; merge as ready.
3. **G1** — before enabling any flag.
4. Coordinate **G2** with `feat/customer-communications` (shared `comms/optout.ts` + SMS webhook) — merge after or alongside that branch to avoid conflicts.
5. Keep **AI telemetry / queue-recovery** branches independent — the `ai:*` keyspace is platform-global by design and must not be tenant-prefixed.
6. **G3, G6, G7** — sequence behind a green flag-on Preview; each its own reviewed PR with a rollback point.

---

## References for future sessions

- Full audit: `docs/opspilot-os/tenant-isolation/audits/2026-07-17-multitenant-readiness-audit.md`
- Repeatable check: `node scripts/tenant-readiness-audit.mjs` (report-only, exits 0)
- Foundation internals: `docs/opspilot-os/tenant-isolation/` (key API, chokepoint, dark-launch, migration, rollback)
- Superseded (retain for key inventory only): `docs/opspilot-multi-tenant-roadmap.md`
