# 02 — Environment Matrix

Every environment variable the app reads, by **name and purpose only**. This file
contains **no values**. All rows marked *secret* must never be printed, logged, or
committed.

> **`vercel env pull` caveat.** A pulled `.env` file shows `""` for many production
> values (redaction), notably every `OPERION_*` flag. A blank is **not** the real
> value — verify flag/config state via the Vercel dashboard or the running app, never
> by trusting a pulled blank.

Environments: **Local** (`.env.local`), **Preview** (per-branch Vercel), **Production**.

## Core / auth

| Name | Secret | Purpose | Where set |
|------|:------:|---------|-----------|
| `ADMIN_PASSWORD` | ✅ | Legacy shared owner login password. | All |
| `ADMIN_SESSION_SECRET` | ✅ | HMAC key that signs the admin session cookie. Min 16 chars. Never reuse `ADMIN_PASSWORD`. | All |
| `CRON_SECRET` | ✅ | Authorizes Vercel cron calls into `/api/cron/*`. | Preview/Prod |
| `HEALTH_CHECK_SECRET` | ✅ | Authorizes health-check endpoints. | Preview/Prod |
| `DOC_ENCRYPTION_KEY` | ✅ | Encrypts stored crew/claim documents. | All |
| `PLATFORM_OWNER_SUBS` | – | Comma-separated user ids granted platform-owner tier (beyond legacy `owner`). Absent → owner-only. | Prod |
| `NODE_ENV` | – | Standard Node environment. | All |

## Data / storage

| Name | Secret | Purpose |
|------|:------:|---------|
| `KV_REST_API_URL` | – | Vercel KV / Redis REST endpoint. |
| `KV_REST_API_TOKEN` | ✅ | Vercel KV / Redis REST token. |
| (Blob) | ✅ | Vercel Blob uses the platform-provided token; documents/photos storage. |

## AI (Vercel AI Gateway)

| Name | Secret | Purpose |
|------|:------:|---------|
| `AI_GATEWAY_API_KEY` | ✅ | Auth to the Vercel AI Gateway (all model calls). Locally, an OIDC token can stand in. |
| `AI_MODEL` | – | Default model id (gateway `provider/model` string). |
| `AI_MODEL_OPS_COMMAND` / `AI_MODEL_OPS_INSIGHTS` / `AI_MODEL_OPS_PHOTOESTIMATE` | – | Per-surface model overrides. |
| `AI_CALL_TIMEOUT_MS` / `AI_VISION_TIMEOUT_MS` | – | Per-call timeouts. |
| `AI_JOB_DEADLINE_MS` / `AI_PROCESSING_LEASE_MS` | – | Durable-job graceful deadline + lease window. |
| `AI_DAILY_COST_CAP_USD` | – | Daily spend cap for AI. |
| `AI_JUNK_CRITIC` | – | Toggle for the junk-estimate critic pass. |

## Payments (Stripe)

| Name | Secret | Purpose |
|------|:------:|---------|
| `STRIPE_SECRET_KEY` | ✅ | Stripe API key. |
| `STRIPE_WEBHOOK_SECRET` | ✅ | Verifies inbound Stripe webhooks. |
| `STRIPE_PERCENT_FEE` / `STRIPE_FIXED_FEE_CENTS` | – | Fee model for surcharge math. |

## SMS (Twilio) — see doc 10 & `docs/twilio-a2p-sms.md`

| Name | Secret | Purpose |
|------|:------:|---------|
| `TWILIO_ACCOUNT_SID` | – | Account id. |
| `TWILIO_AUTH_TOKEN` | ✅ | Account auth token. |
| `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET` | ✅ | Scoped API key credentials. |
| `TWILIO_MESSAGING_SERVICE_SID` | – | Messaging service used to send. |
| `TWILIO_FROM` | – | Sending number. |
| `TWILIO_WEBHOOK_SECRET` | ✅ | Verifies inbound SMS webhooks. |

## Email (Resend)

| Name | Secret | Purpose |
|------|:------:|---------|
| `RESEND_API_KEY` | ✅ | Resend API key (transactional email). |
| `EMAIL_WEBHOOK_SECRET` | ✅ | Verifies inbound email webhooks. |
| `COI_BROKER_EMAIL` | – | Recipient for certificate-of-insurance requests. |

## Notifications / ops contact

| Name | Secret | Purpose |
|------|:------:|---------|
| `OWNER_EMAIL` / `OWNER_SMS` | – | Owner contact for operational notices. |
| `OWNER_ALERT_EMAIL` / `OWNER_ALERT_SMS` | – | Alerting destinations. |
| `ALERT_EMAIL_TO` | – | Fallback alert email. |
| `ALERT_SLACK_WEBHOOK_URL` | ✅ | Slack incoming webhook for alerts. |

## Google

| Name | Secret | Purpose |
|------|:------:|---------|
| `GOOGLE_PLACES_API_KEY` | ✅ | Google Places API (reviews/place data). |
| `GOOGLE_PLACE_ID` / `GOOGLE_REVIEW_URL` | – | The business's place id / review link. |

## Site / URLs

| Name | Secret | Purpose |
|------|:------:|---------|
| `NEXT_PUBLIC_SITE_URL` / `PUBLIC_BASE_URL` | – | Canonical site URL (public + server). |

## Communications & Operion control

| Name | Secret | Purpose |
|------|:------:|---------|
| `COMMS_SEND_MODE` | – | Master send-mode for the comms layer (`suppress` / `test` / `live`). Default-suppressed. See doc 10. |
| `OPERION_CALLBACK_SECRET` | ✅ | Verifies automation callbacks into the platform console. |
| `OPERION_*` (flags) | – | Automation/rollback gates — all default OFF. See doc 15. |

## Tenancy (flag-gated, off in prod)

| Name | Secret | Purpose |
|------|:------:|---------|
| `TENANCY_ENABLED` | – | Master tenancy switch. Off in production. |
| `TENANT_ID` | – | Reference tenant id for background contexts. |
| `TENANT_MIGRATION_CONFIRM` / `TENANT_MIGRATION_PROD_OVERRIDE` | – | Guards for tenancy migration scripts (see doc 07). |

## Vercel build-time (read by the Release Center, doc 16)

| Name | Secret | Purpose |
|------|:------:|---------|
| `VERCEL_ENV` | – | `production` / `preview` / `development`. |
| `VERCEL_GIT_COMMIT_SHA` | – | Commit of the running build. |
| `VERCEL_URL` | – | Deployment URL. |
| `VERCEL_DEPLOYMENT_ID` | – | Deployment id. |
| `VERCEL_OIDC_TOKEN` | ✅ | Short-lived OIDC token (local AI testing). |

> The Release Center reads only the **non-secret** Vercel build vars above and shows a
> short commit + environment label. It never reads or displays any secret var, and it
> never renders a raw env value — only resolved states.

## Local-only debug (scripts / screenshots)

`BASE`, `PUBLIC_BASE_URL`, `LABEL`, `ONLY`, `SHOT_DIR`, `PW_EXE`, `OPERION_APPLY_RESULT`
appear in helper scripts (screenshot/eval/apply tooling), not in the production request
path.
