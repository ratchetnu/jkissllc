# 09 — AI Processing Runbook

Covers the Book Now AI pipeline and the shadow vision-estimation subsystem.

## What runs

| Piece | Code | Cron |
|-------|------|------|
| Book Now AI worker (analysis → pricing → quote) | `app/lib/book-now-ai.ts`, `book-now-confirmation.ts` | `/api/cron/ai-jobs` (*/3m) |
| Shadow vision-estimation (non-authoritative) | `app/lib/…` vision shadow | `/api/cron/vision-shadow` (*/10m) |
| Shadow alerting (read-only over shadow jobs) | shadow alerts | `/api/cron/shadow-alerts` (*/15m) |

All model calls go through the **Vercel AI Gateway** (`AI_GATEWAY_API_KEY`). Jobs are
**durable and lease-based**: a job is picked up, leased (`AI_PROCESSING_LEASE_MS`), and
must finish within a graceful deadline (`AI_JOB_DEADLINE_MS`) that sits below the route's
`maxDuration` (300s) so it is never hard-killed mid-run and stranded in "processing".

## Key facts

- **Shadow ≠ authoritative.** Shadow vision runs compute and record results for
  comparison; they never override the live estimate/quote. The old inline shadow path
  (`VISION_ESTIMATION_SHADOW`) is **retired** and must stay OFF (doc 15).
- **Cost cap.** `AI_DAILY_COST_CAP_USD` bounds daily spend. If AI stops working, check
  whether the cap was hit.
- **Timeouts.** `AI_CALL_TIMEOUT_MS`, `AI_VISION_TIMEOUT_MS` bound individual calls.

## Symptom → action

| Symptom | Check |
|---------|-------|
| Booking stuck in "AI processing" | Is `/api/cron/ai-jobs` running? Check its logs; confirm `CRON_SECRET`. A job past its lease is re-picked next tick. |
| All AI failing | AI Gateway status; `AI_GATEWAY_API_KEY` valid; daily cost cap not exhausted. |
| Vision calls 500 | Photo too small/invalid? The gateway rejects tiny images — real full-size photos only. |
| Quotes look wrong | Model override env (`AI_MODEL_OPS_PHOTOESTIMATE`) changed? Compare against shadow results in the AI Command Center. |
| Jobs pile up "queued" | Worker erroring before lease; inspect first failing job's error category. |

## Verifying an AI change

1. `npm run test:ai` and `npm run test:ai:regression` (also in `predeploy`).
2. Locally, refresh `VERCEL_OIDC_TOKEN` (`vercel env pull`) and exercise with a **real**
   photo.
3. On Preview, submit a Book Now with real photos and watch the job advance through
   `ai-jobs` ticks.
4. Compare against shadow output before promoting any model/prompt change; promote only
   after offline eval + shadow metrics clear (`docs/opspilot-os/vision-estimation/`).

## Owner-only surfaces

The **AI Command Center** (`/admin/operations/ai`, owner-only) holds the shadow
analytics, alerts, and learning views. Those are gated by `SHADOW_ANALYTICS_ENABLED` /
`SHADOW_ALERTING_ENABLED` (both OFF by default). This runbook does not change any of it.
