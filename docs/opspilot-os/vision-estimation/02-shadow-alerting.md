# Shadow Alerting — Increment 1: policy model, evaluator, store

Operion can already *measure* the V2 shadow model (agreement, confidence, disagreements,
readiness). It could not *tell the owner* when something important happened. This increment
adds the deterministic engine that decides what is worth telling.

**Scope discipline:** alerting is an OBSERVER. It promotes no model, enables no shadow
traffic, changes no customer-facing behavior, and touches no `VISION_SHADOW_*` flag.

## Architecture

| Module | Role | Pure? |
|---|---|---|
| `app/lib/estimation/shadow-alert-types.ts` | Policy + alert + signal vocabulary | types only |
| `app/lib/estimation/shadow-alert-policies.ts` | The 15 shipped policies and their defaults | data only |
| `app/lib/estimation/shadow-alert-engine.ts` | `evaluateShadowAlerts()` + `reconcileAlerts()` | **yes** — no I/O, no clock |
| `app/lib/estimation/shadow-alert-store.ts` | Redis persistence + `runShadowAlertEvaluation()` | I/O only |

**The cardinal rule: the engine derives no metric of its own.** Every number it compares comes
out of the existing engines — `computeShadowAnalytics`, `computeShadowMetrics`,
`detectDisagreements`, `modelScorecards`, `readinessScore`. The only arithmetic in the alerting
layer is cost-per-evaluation (`totalEstCostUsd ÷ evaluated`), a division of two published
numbers rather than a re-derivation. If a metric definition changes, it changes in the
analytics engine and alerting follows automatically.

### Why almost no new history was needed

Every `V2ShadowJob` carries `completedAt`, so a "previous baseline" is derivable by running the
*existing* functions over a prior time window of the *same* job set. 13 of the 15 policies need
zero persisted history.

The two exceptions are the readiness **transition** policies: a snapshot cannot tell you what
changed. They read one persisted record, `shadow:alert:readiness`, written at the end of every
run. On the first-ever run it is absent, and a transition alert is correctly impossible —
inventing a baseline would fabricate an event.

### Storage (tenant-scoped `shadow:*` family, same isolation as the jobs)

```
shadow:alert:{id}        → JSON ShadowAlert            (SAL-{n})
shadow:alert:index       → zset (score=lastDetectedAt) — bounded at 2000, never trims an active alert
shadow:alert:counter     → id sequence
shadow:alert:readiness   → JSON ReadinessSnapshot      — the transition baseline
shadow:alert:lock        → run lock (setNxPx + Lua compare-and-delete)
shadow:alert:run         → JSON AlertRunSummary of the last run
```

## The 15 policies

`per_item` policies emit one alert per offending evaluation (each is its own event).
`aggregate` policies emit one alert per scope and auto-resolve when the condition clears.

| Policy | Kind | Severity | Rule | Window | Min sample |
|---|---|---|---|---|---|
| `critical_false_negative` | per_item | CRITICAL | any FN (V2 auto-quoted where V1 reviewed) | 7d | 1 |
| `readiness_milestone_lost` | aggregate | CRITICAL | readiness tier moved down | 30d | 30 |
| `high_severity_disagreement` | per_item | WARNING | any high-severity disagreement (excl. FN) | 7d | 1 |
| `agreement_rate_drop` | aggregate | WARNING | −10pp vs prior window | 7d vs 7d | 30 |
| `manual_review_spike` | aggregate | WARNING | +15pp vs prior window | 7d vs 7d | 30 |
| `confidence_drop` | aggregate | WARNING | −0.10 score vs prior window | 7d vs 7d | 30 |
| `evaluation_failure_spike` | aggregate | WARNING | +20pp failure rate | 24h vs 7d | 10 |
| `latency_regression` | aggregate | WARNING | ≥1.5× prior average | 7d vs 7d | 20 |
| `model_prompt_regression` | aggregate | WARNING | −10pp vs the best peer deployment | 30d | 30 |
| `queue_backlog` | aggregate | WARNING | >25 queued jobs | live | 0 |
| `auto_quote_rate_drop` | aggregate | INFO | −15pp vs prior window | 7d vs 7d | 30 |
| `cost_per_evaluation_spike` | aggregate | INFO | ≥1.5× prior average | 7d vs 7d | 20 |
| `readiness_milestone_reached` | aggregate | INFO | readiness tier moved up | 30d | 30 |
| `stale_shadow_telemetry` | aggregate | WARNING | no evaluation in >3d | live | 0 |
| `insufficient_sample_volume` | aggregate | INFO | <30 evaluated (**disabled by default**) | 30d | 0 |

Threshold units: rates are **percentage points**; confidence is **score points** (0–1); latency
and cost are **ratio multipliers**; backlog and volume are **counts**; staleness is **milliseconds**.

`insufficient_sample_volume` ships disabled: it is true today and not actionable, so it would
nag until shadow traffic expands. Owner opt-in.

### Why the defaults are conservative

The shadow worker processes at most **1 job per tenant per 10-minute tick** — a ceiling of
roughly 6 evaluations/hour. At that throughput a chatty policy produces noise, not signal. Every
comparative policy therefore requires a real sample on **both** sides of the comparison and
genuine history predating the current window before it may fire.

## Guards against false alarms

- **Minimum sample size** — a 100%→0% collapse across 3 evaluations is real and meaningless. Both
  the current and the baseline window must clear the floor.
- **Incomplete window** — if no job history predates the current window, the policy skips. Day one
  of shadow traffic must not read as a catastrophic regression from nothing. ("How much history is
  enough" is the sample floor's job, kept separate so each rule stays explainable.)
- **Zero-baseline ratio guard** — 0 → anything is not a "1.5× regression".
- **No double-alerting** — `detectDisagreements` ranks a false negative as high severity, so
  `high_severity_disagreement` explicitly excludes FNs; the CRITICAL policy owns them.
- **Failure rate uses terminal jobs as its denominator** — a failed job never produces a
  comparison, so measuring against `evaluated` would make a total outage read as 0% failure.
- **Every skip is recorded** with a reason. A policy that never fires must be explainable.

## Lifecycle

```
OPEN ──acknowledge──> ACKNOWLEDGED ──resolve──> RESOLVED
  │                        │
  ├──mute──> MUTED ────────┘
  └──(aggregate condition clears)──> RESOLVED   (resolvedBy: 'system')
  └──(no fresh detection past expireAfterMs)──> EXPIRED
```

- **Dedup** — a signal matching an OPEN/ACKNOWLEDGED alert refreshes it (`occurrences++`,
  `lastDetectedAt`, latest reading) rather than opening a second one. `firstDetectedAt` is preserved.
- **Recovery** — only `aggregate` policies with `requiresAck: false` auto-resolve. A per-item
  safety alert that scrolled out of the window has **aged, not healed**, and waits for a human.
- **Cooldown** — a resolved aggregate condition cannot re-open until `cooldownMs` elapses.
- **`already_handled`** — a per-item dedup key names an immutable event (a specific booking's false
  negative). Once the owner closes it, re-detecting the same evidence forever is not news, so it is
  suppressed permanently rather than on a cooldown.
- **Mute** — bounded at 30 days. A permanent mute must be an explicit policy change.
- **Escalation** — an OPEN, unacknowledged alert past `escalateAfterMs` is stamped once with
  `escalatedAt`. No transport yet (Increment 3).

## Concurrency and retry safety

`runShadowAlertEvaluation()` is idempotent. Re-running re-derives the same signals, and the
reconciler refreshes rather than duplicates. A run lock (`setNxPx` + Lua compare-and-delete, 120s
TTL) makes a concurrent or overlapping run a no-op (`skipped: 'locked'`) instead of a race, so an
overlapping cron tick cannot double-alert. Id blocks are reserved in one round trip; suppressed
signals leave gaps in the sequence, which is fine — ids are opaque handles, not a count.

## Feature flags

| Flag | Default | Effect |
|---|---|---|
| `SHADOW_ALERTING_ENABLED` | **false** | Gates scheduled alert evaluation and the Alerts surface. Safe to enable independently of `VISION_SHADOW_*`: with the shadow worker off it simply finds nothing new. |

`SHADOW_ALERT_EMAIL_ENABLED` and `SHADOW_ALERT_SUMMARIES_ENABLED` arrive in Increment 3 with the
transports they gate — a flag that reads nothing is dead config.

## Known limitations (deliberate)

- **Business scope is inert.** `V2ShadowJob` has no `businessId` (single-tenant), so `jobBusiness()`
  is always null and a business-scoped policy matches nothing. The dimension is carried end-to-end
  so it lights up when jobs are tenant-tagged. A test pins this reality rather than hiding it.
- **No event-based evaluation.** At ~6 evaluations/hour a scheduled pass gives detection latency
  comparable to the job production rate, and keeps the shadow worker path untouched.
- **Probable cause is not inferred.** `model_prompt_regression` labels its conclusion a hypothesis
  and says so in the alert text: the data shows the gap, not its cause.

## Tests

`scripts/shadow-alerts.test.ts` — 55 tests, all against the pure engine (no Redis, no clock):
threshold operators, sample floors, incomplete windows, empty/degenerate datasets, stale
telemetry, per-item safety policies, readiness transitions, multi-model and multi-deployment
isolation, business-scope inertness, determinism, dedup, idempotency, recovery, expiry, cooldown,
`already_handled`, mute, escalation, bucket disjointness, and every owner transition.

---

# Increment 2: API, notification center, background execution

## APIs

| Route | Method | Auth | Gate |
|---|---|---|---|
| `/api/admin/shadow-alerts` | GET | `requirePlatformOwner` | `SHADOW_ALERTING_ENABLED` → `{enabled:false}` 200 |
| `/api/admin/shadow-alerts?format=csv` | GET | `requirePlatformOwner` | same — exports the current filtered view |
| `/api/admin/shadow-alerts/[id]` | GET | `requirePlatformOwner` | same |
| `/api/admin/shadow-alerts/[id]` | POST | `requirePlatformOwner` | flag off → **403** (a write is refused, never silently no-op'd) |
| `/api/cron/shadow-alerts` | GET | `CRON_SECRET` bearer, fail-closed | flag off → cheap no-op, no I/O |

Authorization always runs **before** the flag check — a 401 on an alerting-enabled route proves
the flag is not what protects it. Non-owners (including a non-owner `admin`) get **403**, not a
hidden nav item: hiding is never the control.

The list route is **read-only** — it renders what the evaluator already decided and never
evaluates a policy, so opening the page cannot create an alert. Badge/severity counts come from
the **full** set, not the filtered slice, so filtering to WARNING can never hide an open CRITICAL.

`app/lib/estimation/shadow-alert-filters.ts` (pure) owns filtering, facets, summary, sort, and
CSV export — mirroring `shadow-facets.ts`. Invalid query values are dropped rather than 500-ing.
The CSV carries evidence *about the model* and references evaluations by id; it never inlines raw
model output about a customer's property.

## UI

`/admin/operations/ai/alerts` (owner-only nav entry, `group: 'platform'`) — the notification
center: open/unread/critical/escalated counts, readiness card, status tabs, severity/policy/
model/deployment/business facets, search, date range, CSV export. Deep-links to
`/admin/operations/ai/alerts/[id]`.

The detail page shows the plain-language summary, the measurement (observed / threshold /
previous baseline / sample / occurrences), first + most-recent detection, readiness at detection,
related evaluations (read **live**, so they reflect the owner's latest classification rather than
a stale copy), notes, the full audit timeline, and a deterministic **recommended owner action**
per policy type. Any cause is labelled a **hypothesis** — the data shows the gap, not its cause.

Both pages render the API and re-derive nothing. Relative times use the **fetch timestamp**, never
`Date.now()` during render, and loading is *derived* from the request key rather than set inside an
effect — so a stale response can never be mistaken for the current one.

## Owner actions (all audited)

`acknowledge` · `resolve` (with reason) · `mute` (**presets only** — 1h/24h/7d/30d; a free-form
duration is how a "temporary" mute becomes permanent) · `unmute` · `note` · `mark_read`.

Every action writes a `PlatformAuditEvent` with the real action name — `shadow_alert.*` members
were **added to the union** rather than cast through `as never`, so the trail is type-checked.
Events carry `alertId`, prior→new status, and the policy/severity/scope in `meta`. An owner
silencing a CRITICAL safety alert must be explainable months later.

## Background execution

`/api/cron/shadow-alerts`, `*/15`, `maxDuration: 60`, per-tenant fan-out via
`withBackgroundTenant` — the same shape as `/api/cron/vision-shadow`, on its own budget.

Scheduled rather than event-based **on purpose**: the shadow worker emits at most 1 job per tenant
per 10-minute tick, so a 15-minute pass detects a condition about as fast as one can arise, and the
shadow worker path stays untouched. A run holds the Increment 1 lock, so an overlapping tick is a
no-op (`skipped: 'locked'`) rather than a double-alert; retries are safe because evaluation is
idempotent. Failures raise `shadow_alert_eval_failed` (WARNING) — deliberately distinct from both
the authoritative-AI and shadow-worker health signals.

**In-app delivery**: an opened alert IS delivered the moment it is persisted — the Alerts page
reads the store, so there is no separate transport to fail. `deliveredChannels: ['in_app']` is
stamped so the record is honest, and gives Increment 3's email transport a list to append to.

**Scheduler health** is surfaced on the page from `shadow:alert:run`. An empty Alerts page means
"nothing is wrong" only if the last run actually succeeded — so the page says which it is.

## Tests

`scripts/shadow-alert-api.test.ts` — 25 tests: every filter dimension, minSeverity as a floor,
search, unread, date bounds, sort order, facets, summary (incl. the badge number and the empty
set), query parsing of garbage, CSV escaping and header stability, the no-raw-output export
invariant, audit-action union coverage, nav owner-gating, the `isPlatformOwner` matrix, real-route
401 (unauthenticated), real-route 403 for live admin/manager/crew sessions, owner-reaches-but-flag-
dormant for GET and POST, cron fail-closed, cron dormancy without touching Redis, and the cron
schedule registration.

## Next

- **Increment 3** — email via `emailRaw` to the owner-alerts recipient, owner preferences,
  daily/weekly summaries, observability surface.
