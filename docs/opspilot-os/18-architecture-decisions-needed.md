# 18 — Architecture Decisions Needed (owner)

> Decisions only the owner can make. Each: the decision, options, the
> recommendation, and what it blocks. Record chosen answers as ADRs in
> `docs/adr/`.

## D1 — Tenant routing model
- **Decision:** how does a request map to a tenant?
- **Options:** (a) subdomain `acme.opspilot.app`; (b) custom domain per tenant;
  (c) both.
- **Recommendation:** **both**, subdomain first (zero DNS friction for onboarding),
  custom domain as an upgrade. Requires dropping the build-time `NEXT_PUBLIC_SITE_URL`
  (`05-...` §6) and generalizing `proxy.ts`'s host handling.
- **Blocks:** Phase 1 tenant resolution, Phase 9 onboarding.

## D2 — Stripe Connect model
- **Decision:** how do tenants collect customer payments while the platform bills
  them, given the Stripe key is shared with ClaimGuard today (`stripe.ts:3`)?
- **Options:** Standard / Express / Custom Connect.
- **Recommendation:** **Express** (fast onboarding, Stripe-hosted, minimal
  liability) with destination charges; platform billing on a separate product.
- **Blocks:** Phase 9 (billing) — a commercialization gate (H1).

## D3 — When to introduce Postgres
- **Decision:** stay Redis-only, or add relational for billing/analytics?
- **Options:** (a) Redis-only indefinitely; (b) hybrid — Redis operational +
  Postgres (Neon) for billing ledger + cross-tenant analytics.
- **Recommendation:** **(b), triggered by the first paying external tenant**, not
  before. Do not move operational data off Redis.
- **Blocks:** nothing near-term; shapes Phase 9–10.

## D4 — Retention & data-residency policy
- **Decision:** retention windows per data class (GPS, messages, applicant docs,
  financial) and any regional constraints.
- **Recommendation:** define now, implement in Phase 10; short TTL on GPS punches,
  policy-driven on messages, hiring-policy on applicant docs.
- **Blocks:** enterprise sales; erasure/export workflows (M4, `09/10`).

## D5 — Second industry pack
- **Decision:** which vertical after `hauling-boxtruck`?
- **Options:** moving/delivery (nearest shape) · cleaning/landscaping (high volume,
  simple) · skilled trades (high value, new concepts).
- **Recommendation:** **moving/delivery** to prove the pack seam cheaply, then a
  trade to stress-test it. Owner's market knowledge should drive this.
- **Blocks:** Phase 4 pack generalization scope.

## D6 — Booking/Route convergence
- **Decision:** unify retail Booking + contract Route into one `Job` aggregate, or
  keep parallel with a reconciling ledger?
- **Recommendation:** **keep parallel, add a `LedgerEntry` reconciliation layer**
  (lower risk; the two flows are deeply built). Revisit convergence post-GA.
- **Blocks:** `04/09` data-model finalization.

## D7 — Product noun taxonomy
- **Decision:** settle the unstable terms (route/operation/assignment/job;
  crew/staff/employee/contractor; business/client/customer).
- **Recommendation:** **Job** (UI) / route (internal) · **Crew member** (UI) /
  contractor (tax) · **Customer** (retail) vs **Client/Account** (B2B).
- **Blocks:** Phase 5 rename; UX consistency (`11-...`).

## D8 — AI autonomy ceiling
- **Decision:** highest AI action level allowed, and for which actions.
- **Recommendation:** **L2 (draft) is today's correct ceiling.** Permit L3
  (approval-gated) only after the approval queue + executor + audit + rollback +
  AI test suite land (Phase 7). Keep money-out/employment/tax/deletion/permissions
  at **L5** (never autonomous). L4 only for bounded low-risk actions with hard
  caps + kill switch.
- **Blocks:** Phases 7–8.

## D9 — CI as a hard deploy gate
- **Decision:** make CI blocking (currently advisory — `ai-regression.yml:6-10`)?
- **Recommendation:** **yes** — enable branch protection; add auth-coverage +
  full test suite + (later) tenant-isolation as required checks.
- **Blocks:** safe execution of the migration (prevents regressions).
