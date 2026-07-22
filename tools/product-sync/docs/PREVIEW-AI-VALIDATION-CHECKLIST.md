# Preview AI Validation Checklist (PREPARED — do not execute until the gateway blocker clears)

**Target:** Supercharged Preview. **Blocked by:** AI Gateway entitlement (owner action). Do not fabricate a successful-provider result.

## Preview infrastructure audit (findings on `ef618c6`)
| Component | State |
|---|---|
| Redis / KV | ✅ `KV_REST_API_URL/TOKEN` present in Preview |
| Blob | ✅ `BLOB_READ_WRITE_TOKEN` present |
| Admin/doc secrets | ✅ present |
| **AI Gateway entitlement** | ⛔ unconfirmed — provider is called via runtime OIDC; a `VERCEL_OIDC_TOKEN` *is* pullable, but whether the gateway **accepts** it (team entitlement) is an account-owner check |
| **Preview `CRON_SECRET`** | ⚠️ absent (production-only) — worker can't auto-trigger; needs a Preview-scoped secret or manual bearer |
| Observability flag in Preview | OFF — must be set ON (Preview only) to record traces |

## Owner actions required to unblock (exact steps)
1. **Enable AI Gateway** for the Vercel team → Vercel dashboard → **AI** (or **AI Gateway**) → enable for project `supercharged` (org `team_PweAjOAlPynWqOYT9BdImlMA`). Expected: deployed Preview runtimes can call `provider/model` via injected OIDC.
2. **Add a Preview-only `CRON_SECRET`** → Project → Settings → Environment Variables → add `CRON_SECRET` (Preview scope only). Expected: `/api/cron/ai-jobs` accepts the bearer in Preview.
3. **Enable observability in Preview only** → add `AI_PIPELINE_OBSERVABILITY_ENABLED=1` (Preview scope). Expected: pipeline traces recorded + visible on the OBS-003 dashboard.
4. Confirm Deployment Protection allows the automation-bypass token for synthetic requests.

## Validation run (execute only after 1–4)
Baseline flags: Observability **ON**; IMAGE_OPTIMIZATION / CRITIC_JSON / EVENT_ENQUEUE / DUE_INDEX / PROGRESS_UX all **OFF**.

1. Fresh Preview deployment; confirm the intended Preview-only settings are present in the deployed env.
2. One controlled **synthetic** booking, one approved test photo (real, full-size — tiny images fail the gateway).
3. Exercise: upload → booking creation → image preprocessing → provider → AI → deterministic pricing → persistence → worker (manual trigger) → notification (if applicable) → dashboard/read API → cleanup.

### Verify
Exactly one synthetic booking · no Production records · no duplicate AI job · trace id created · every stage recorded (queue/preprocess/provider/ai/pricing/database/notification) · non-negative timings · aggregate metrics updated · no worker crash · no unexpected retries · valid terminal state · dashboard shows the run · Progress UX unchanged (flag OFF).

### Capture (only real values — never fabricate)
Preview URL · deployment commit · booking/test id · trace id · full stage waterfall · total/provider/queue/preprocess/pricing/database/notification latency · retry count · model/provider · image size · token usage (if available) · est. cost (if instrumented) · raw trace JSON · authenticated dashboard screenshots (if available).

### Clean up
Delete the synthetic booking, test customer data, test photo/blob (if safe), and temp local files. **Do not** delete shared Preview infrastructure.

**If the provider still fails:** preserve the truthful trace, STOP, and report — do not fabricate a baseline.
