# Customer & Dispatch Communications — Phase 1 Audit

Branch: `feat/customer-communications` (isolated git worktree, branched from stable `main` @ `63d116e`).
Date: 2026-07-17.

## TL;DR — source of truth

The app already has a **mature, production communications stack**. This sprint therefore
**reuses** it and adds a **thin, decoupled event/adapter layer** on top (`app/lib/comms/`)
plus the events that have no sender yet. **No second SMS/email provider is introduced.**

| Concern | Source of truth (reuse — do not duplicate) |
| --- | --- |
| SMS transport | `app/lib/sms.ts` — Twilio via direct `fetch` (no SDK). `sendSmsDetailed()` / `sendSms()`. |
| Email transport | `app/lib/booking-emails.ts` — Resend v6. Generic sender `emailRaw({to,subject,html,replyTo})`. |
| Message ledger / history | `app/lib/messages.ts` — Redis, one JSON blob per `msg:{id}` + indexes; dedupes by `msg:pid:{providerId}`. |
| SMS opt-out | Redis flag `sms:optout:{e164}` (set on STOP, cleared on START) — `app/api/webhooks/twilio/sms/route.ts`. |
| SMS delivery status | `app/lib/sms-status.ts` (`smsdlv:{sid}`) + `app/api/webhooks/twilio/status/route.ts`. |
| Customer-facing dispatch (today) | `app/lib/notify.ts` — **booking-coupled** functions (`notifyBookingConfirmed`, …). |
| Crew / internal dispatch (today) | `app/lib/reminder-engine.ts` + `reminder-templates.ts` + `crew-notify.ts` — complete. |
| Branding | `app/lib/company.ts` (`COMPANY`). |
| Customer identity | `app/lib/customers.ts` (`cust:{id}`); address/contact denormalized on `Booking`. |
| Bookings / quotes / invoices | `app/lib/bookings.ts` (a quote **is** a booking; invoice embedded). `app/lib/route-invoices.ts` for B2B. |
| Routes / dispatch | `app/lib/routes.ts` (no ETA field — `reportTime` + clock-in stamps). |
| Consumer tracking | `app/lib/shipments.ts` (`ship:{BOL}`, powers `/track`). |
| Storage | Upstash Redis via `app/lib/redis.ts` (tenant-scoped `scopeKey`). No SQL/ORM. |
| Auth / RBAC | `app/api/admin/_lib/session.ts` guards + `app/lib/rbac.ts` matrix (admin/manager/crew). |
| Crons | `vercel.json`: `daily` (14:00 UTC), `reminders` (*/5). Auth via `CRON_SECRET` bearer, fail-closed. |

## Providers found

- **Twilio (SMS)** — direct REST, no SDK. Env: `TWILIO_ACCOUNT_SID`, (`TWILIO_API_KEY_SID`+`TWILIO_API_KEY_SECRET` **or** `TWILIO_AUTH_TOKEN`), (`TWILIO_FROM` **or** `TWILIO_MESSAGING_SERVICE_SID`), `TWILIO_WEBHOOK_SECRET`, `PUBLIC_BASE_URL`/`NEXT_PUBLIC_SITE_URL`.
- **Resend (email)** — v6 `^6.10.0`. Env: `RESEND_API_KEY`. From: `COMPANY.emailFrom` (`info@jkissllc.com`).
- Owner routing: `OWNER_SMS`, `OWNER_EMAIL`, `OWNER_ALERT_SMS`, `OWNER_ALERT_EMAIL`.

**Conclusion: a provider exists on both channels → no new provider is added.**

## Existing routes / APIs (customer + crew comms)

- `app/api/admin/comms/{send,audit,analytics}` — crew immediate-send + comms analytics.
- `app/api/admin/messages/{route,count,reply}` — inbox + reply.
- `app/api/admin/reminders/**` — crew reminder rules + templates.
- `app/api/webhooks/twilio/{sms,status}` — inbound + delivery status.
- `app/api/webhooks/email` — inbound email.
- `app/admin/operations/messages/*` — the existing Communication Center UI (Inbox, Compose, RemindersManager, DispatchMode, CommsAnalytics, CrewDirectory).

## Templates (today)

- Customer email templates: `app/lib/booking-emails.ts` (confirmation, confirmed, completed, paid-in-full, reminders, review, reschedule, cancel, …).
- Customer SMS copy: inline in `app/lib/notify.ts`.
- Crew reminder templates: `app/lib/reminder-templates.ts` (`TEMPLATES`, `DISPATCH_ACTIONS`).

## Opt-out / retry / delivery / idempotency (today)

- **Opt-out:** SMS `sms:optout:{e164}` (checked inside `sendSmsDetailed`). **Email: no unsubscribe store — GAP.**
- **Suppression:** `withSmsSuppressed()` AsyncLocalStorage kill-switch (daily cron uses it).
- **Idempotency:** provider-id dedup `msg:pid:{id}`; payment dedup by Stripe session; reminder occurrence keys `rsend:occ:{k}`; `Booking.reminders.*SentAt` stamps.
- **Delivery status:** `sms-status.ts` + status webhook; `setMessageDeliveryStatus` idempotent.
- **Reply-aware:** `Booking.automationPaused` / `lastCustomerReplyAt` pause reminders after a customer replies.

## Environment variables (messaging)

`RESEND_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`,
`TWILIO_FROM`, `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_WEBHOOK_SECRET`, `OWNER_SMS`, `OWNER_EMAIL`,
`OWNER_ALERT_SMS`, `OWNER_ALERT_EMAIL`, `NEXT_PUBLIC_SITE_URL`, `PUBLIC_BASE_URL`, `CRON_SECRET`,
`KV_REST_API_URL`, `KV_REST_API_TOKEN`. **New (this sprint):** `COMMS_SEND_MODE` (`off`|`test`|`live`, default `off`).

## Current cost posture

No usage/cost meter is wired into these vars in-repo. Twilio SMS ≈ $0.0079/segment + carrier fees; Resend free ≤ 3k/mo then usage-based. The new console surfaces a **volume-based estimate** from the message ledger (segments × unit price) — clearly labeled an estimate, not billing truth.

## Event coverage vs. this sprint's event list

| Event | Covered today | Gap this sprint fills |
| --- | --- | --- |
| BOOKING_RECEIVED | partial (`sendConfirmationLink`) | unified event def |
| QUOTE_SENT | ❌ | **new template** |
| QUOTE_REMINDER | ❌ | **new template + rule** |
| BOOKING_CONFIRMED | ✅ `notifyBookingConfirmed` | wrapped as event |
| APPOINTMENT_REMINDER | ✅ `notifyJobTomorrow`/`notifyBookingReminder` | wrapped |
| CREW_DISPATCHED | ✅ (crew engine) | internal event def |
| ON_THE_WAY | ❌ | **new template (adapter-driven)** |
| ETA_UPDATED | ❌ | **new template (adapter-driven)** |
| ARRIVED | ❌ | **new template (adapter-driven)** |
| JOB_COMPLETED | ✅ `notifyJobCompleted` | wrapped |
| INVOICE_SENT | ❌ | **new template** |
| INVOICE_REMINDER | ✅ `notifyPaymentReminder` | wrapped + rule |
| PAYMENT_RECEIVED | ✅ `notifyPaidInFull` | wrapped |
| REVIEW_REQUEST | ✅ `notifyReviewRequest` | wrapped + rule |
| JOB_CANCELLED | ✅ `notifyCancelledByCustomer` | wrapped |
| JOB_RESCHEDULED | ✅ `notifyRescheduled` | wrapped |
| INTERNAL_DISPATCH | ✅ (crew engine) | internal event def |

## Design decision

Build `app/lib/comms/` as a **decoupled event → adapter → template → dispatch** layer:
core files import **no** business schema (only `company`, `redis`, `sms`, `messages`, `emailRaw`);
an optional `adapters.ts` bridges `Booking`/`RouteInvoice` into a plain `CommContext`.
Adds email opt-out, idempotency keys, quiet hours, retry limits, and a **default-suppressed**
send mode (`off` in Preview/dev). Ships a calm read-only admin console; does **not** replace the
existing inbox or crew engine.
</content>
</invoke>
