# 17 — Open Questions (needs verification)

> Things this assessment could not fully confirm read-only, or that depend on
> facts outside the repo. Each notes how to resolve it.

## Verification needed (repo/runtime)

- **Q1 — Prod env completeness.** Several fail-open paths (Twilio/email webhooks,
  cron) are safe only if their secret env vars are set in prod. This assessment
  read env var **names** only (never values). *Resolve:* confirm in Vercel that
  `TWILIO_AUTH_TOKEN`/`TWILIO_WEBHOOK_SECRET`, `EMAIL_WEBHOOK_SECRET`, and
  `CRON_SECRET` are set for Production. (Fixing fail-closed removes the dependency.)
- **Q2 — Backup/recovery reality.** Durability is assumed from Upstash + Vercel
  Blob defaults; no backup/restore was tested. *Resolve:* confirm Upstash
  persistence tier + any point-in-time recovery; test a Blob restore.
- **Q3 — Empty admin shells.** `app/admin/finance/` and `app/admin/pay-statements/`
  top-level dirs appear empty vs the live `operations/*` variants. *Resolve:* confirm
  they're dead and can be removed, or wired.
- **Q4 — Per-tenant static generation.** `cities.ts` drives `generateStaticParams`
  for `/box-truck-delivery/[city]`. Multi-tenant service areas make build-time
  static generation per tenant infeasible. *Resolve (design):* move to on-demand
  ISR or a tenant-scoped dynamic segment. Real Next.js architecture decision.
- **Q5 — Estimate vs Quote route.** `app/api/estimate/route.ts` internals not
  fully read; assumed a lighter `/api/quote` variant. *Resolve:* confirm before
  unifying into a persisted `Quote`.
- **Q6 — Runtime UX behaviors.** Silent-catch-as-empty, modal focus-trap absence,
  and narrow-viewport overflow on dense pages are inferred from code. *Resolve:*
  device/browser test the heavy pages (`quote` 969, `employees` 682,
  `businesses` 621) and the crew portal.
- **Q7 — ClaimGuard coupling scope.** Claims + shared Stripe key tie OpsPilot to
  ClaimGuard. *Resolve:* confirm whether ClaimGuard remains co-resident long-term
  or separates — it affects the Stripe Connect and claims-boundary design.
- **Q8 — Actual tenant count trajectory.** The Redis-first / Postgres-later
  recommendation assumes modest near-term tenant scale. *Resolve:* the owner's
  target (how many tenants in year 1?) validates the scaling choices in `14-...`.

## Product/strategy questions (feed `18-...`)

- **Q9 — Retail Booking vs contract Route convergence.** Should these two money
  domains unify into one `Job` aggregate, or stay parallel with a reconciling
  ledger? (`04-...`, decision D6.)
- **Q10 — Second industry pack.** Which vertical after `hauling-boxtruck`?
  (`06-...`, decision D5.)
- **Q11 — How autonomous should AI get?** The Level 0–5 model caps money/employment/
  tax/deletion at L5. Confirm the owner's risk appetite for L4 policy-bounded
  automations. (`07-...`.)
- **Q12 — Data residency / retention policy.** Required before enterprise buyers;
  values (retention windows, regions) are a business/legal decision. (`09/10`.)
