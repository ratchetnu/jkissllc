# 08 — Incident Response Runbook

For when production is degraded or down. Goal: restore service, then learn.

## Severity

| Sev | Meaning | Examples |
|-----|---------|----------|
| **1** | Customer-facing outage / data corruption / wrong money or messages | Booking or payment broken; wrong SMS sent; records corrupting. |
| **2** | Major feature degraded, workaround exists | AI queue stalled; one admin surface erroring. |
| **3** | Minor / cosmetic | A non-critical panel misrenders. |

## First 5 minutes (Sev 1/2)

1. **Acknowledge.** Note start time and symptom.
2. **Stabilize before diagnosing.** If it started right after a deploy → roll back
   (doc 06). If it started right after a flag flip → flip it off.
3. **Scope it.** One flow or everything? One tenant/business or all? Public site or
   admin only?
4. **Check the obvious:**
   - Vercel deployment status + build logs.
   - Runtime logs / errors (Vercel dashboard or `vercel logs`).
   - Alerts already fired (`OWNER_ALERT_*`, Slack webhook).
   - External providers: Stripe, Twilio, Resend, Google, and the **AI Gateway** status.

## Triage by symptom

| Symptom | Likely area | Go to |
|---------|-------------|-------|
| Book Now stuck / no quote | AI worker / gateway | doc 09 |
| Customers not getting SMS/email (or getting duplicates/wrong ones) | Comms layer / send mode | doc 10 |
| Online bookings not appearing / mis-stated | Book Now intake | doc 11 |
| Crew can't clock in / portal access | Crew portal | doc 12 |
| Cron not advancing work | `CRON_SECRET` / worker error | doc 09, this doc |
| 401/403 storms on admin | Session secret / RBAC | doc 13 |

## Cron / worker incidents

- Crons are declared in `vercel.json` and authorized by `CRON_SECRET`. If workers stop
  advancing: confirm the secret is set, check the route's logs, and confirm jobs aren't
  all stuck in a lease. Jobs are lease-based and idempotent — a single failed tick
  self-heals on the next run; a persistent failure is a real bug.
- Manually exercise a cron route (with the secret header) to reproduce.

## Communication during an incident

- Keep the owner informed (`OWNER_EMAIL` / `OWNER_SMS`).
- Do **not** send customer-facing "we're down" blasts from this system during an
  incident unless deliberately decided — the comms layer is default-suppressed for a
  reason (doc 10).

## After service is restored

- [ ] Confirm the fix holds across a couple of cron ticks / real transactions.
- [ ] Write the incident record: timeline, trigger commit/flag, blast radius, fix,
      follow-ups.
- [ ] File the root-cause follow-up before re-attempting the original change.
- [ ] Update the release note (doc 16) if a deploy/rollback was involved.

## Escalation contacts

Use the configured owner alert destinations (doc 02). External provider dashboards
(Vercel, Stripe, Twilio, Resend, Google Cloud) are the second line for provider-side
outages.
