# Observability Verification Harness (Preview-only)

`scripts/observability-verify.mjs` drives **one synthetic Book-Now job** through the
real customer pipeline on a **Preview** deployment and verifies the AI pipeline
observability trace it produces. It is the counterpart to
`scripts/e2e-booking-test.mjs` (which is production-targeted and never touches the AI
pipeline) — **do not modify that script; this is separate.**

## What it does

1. Admin-auths against the Preview deployment.
2. **Preflight:** reads `GET /api/admin/ai/pipeline` and asserts `enabled === true`.
   If the deployment was not built with `AI_PIPELINE_OBSERVABILITY_ENABLED=true`, it
   **fails fast and makes no AI call.**
3. Uploads one real sample photo via `POST /api/upload`.
4. Submits the normal customer quote via `POST /api/quote` (junk-removal, job-based →
   enqueues a durable AI job).
5. Drives the durable worker (`GET /api/cron/ai-jobs` with `CRON_SECRET`, idempotent —
   cron would otherwise do this) and polls the booking until the AI job is terminal.
6. Reads the trace via `GET /api/admin/ai/pipeline?booking=<token>` and the fleet
   aggregate via `GET /api/admin/ai/pipeline`.
7. Deletes the synthetic booking (unless `--keep`).

## What it verifies

- trace created, **trace ID** present, tied to the booking
- every expected pipeline stage recorded (`queue, ai, pricing, database` by default;
  `image_preprocess` / `provider` are sub-stages of `ai`)
- stage timings populated (`totalMs`/`count`)
- end-to-end `durationMs` recorded
- aggregate metrics updated (`enabled === true`, count present)
- **no worker failure** (`aiJob.status !== 'failed'`)
- **no unexpected retries** (`aiJob.attempt === 1`)

## Prerequisite (important)

Vercel bakes env vars **per deployment**. Setting `AI_PIPELINE_OBSERVABILITY_ENABLED`
in the Preview environment only takes effect on a **new Preview build** — existing
previews built before the change do **not** carry it. So:

1. Ensure the flag is set for **Preview** (`vercel env add AI_PIPELINE_OBSERVABILITY_ENABLED preview` → `true`).
2. **Redeploy the target branch to Preview** so the build carries the flag.
3. Point the harness at that new Preview URL.

The preflight guarantees you never spend an AI call against a flag-off deployment.

## Usage

```bash
# minimum: a Preview URL + admin password (from .env.preview.local by default)
PREVIEW_URL=https://<preview>.vercel.app node scripts/observability-verify.mjs

# just prove the flag is active on a deployment (no AI call, no booking)
PREVIEW_URL=https://<preview>.vercel.app node scripts/observability-verify.mjs --preflight-only

# machine-readable (CI / AI-regression)
PREVIEW_URL=https://<preview>.vercel.app node scripts/observability-verify.mjs --json

# keep the synthetic booking for manual dashboard inspection
node scripts/observability-verify.mjs --keep
```

### Configuration (env or `.env.preview.local`; env wins)

| Var | Required | Default | Purpose |
|---|---|---|---|
| `PREVIEW_URL` / `BASE_URL` | ✅ | — | Preview deployment URL. **Refuses `jkissllc.com` / `www.jkissllc.com`.** |
| `ADMIN_PASSWORD` | ✅ | — | Admin login (read pipeline API, poll job) |
| `CRON_SECRET` | recommended | — | Bearer to kick `/api/cron/ai-jobs`; without it, waits for cron |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | ✅ (protected previews) | — | Bypasses Vercel Deployment Protection (SSO). Preview URLs 302 to `vercel.com/sso` without it. Set via Project → Settings → Deployment Protection → **Protection Bypass for Automation**. |
| `SAMPLE_PHOTO` | | `public/images/junk-yard-debris.jpg` | Real full-size photo (tiny images are rejected by the gateway) |
| `ENV_FILE` | | `.env.preview.local` | Env file to load |
| `POLL_TIMEOUT_MS` | | `150000` | Job wait budget |
| `POLL_INTERVAL_MS` | | `4000` | Poll cadence |
| `EXPECTED_STAGES` | | `queue,ai,pricing,database` | Stages that must appear |

### Exit codes

- `0` — all checks passed
- `1` — ran, but one or more verifications failed
- `2` — harness/config error (bad URL, missing creds, upload/quote failure)
- `3` — preflight failed: flag not active on the target deployment (no AI call made)

## Safety / guardrails

- **Preview-only:** hard-refuses production hosts; base URL must be provided (never defaulted to prod).
- **No production env changes, no promotion, no Release Center action.**
- Fail-fast preflight → **no AI spend** against a flag-off deployment.
- Cleans up its synthetic booking by default.

## Extending for AI regression

Add assertions inside the run block via `check(name, pass, detail)` — they roll into
the `--json` summary (`passed`/`failed`, `results`). Natural future checks: latency
budget per stage, token/cost deltas (image-optimization A/B), critic-mode selection
(latency Phase 2), and stage presence for other traced features. The harness is
deployment-agnostic (`PREVIEW_URL`) so it can run against any preview in CI.
