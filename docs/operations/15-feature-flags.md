# 15 — Feature-Flag Inventory

**Source of truth:** `app/lib/platform/flags.ts` (`FLAG_DEFAULTS`, `isEnabled`,
`allFlags`). This doc is the human-readable mirror. The read-only **Release Center**
(`/admin/operations/release`) shows each flag's **resolved state** at runtime —
booleans only, never the underlying env value.

## How flags work

- Env-driven and deterministic: `isEnabled(FLAG, env?)` parses the env var
  (`true/1/on/yes` → on, `false/0/off/no` → off, anything else → the default).
- **A flag being ON only makes its subsystem *eligible*.** It never, by itself, wires
  anything into a production path — production wiring is always a separate, explicit change.
- New flags must default **OFF** (the one intentional exception is noted below).

## Inventory

| Flag | Default | What it gates |
|------|:-------:|---------------|
| `TENANCY_ENABLED` | OFF | Master multi-tenant switch. Off in prod (single-tenant today). |
| `TENANCY_DARK_LAUNCH` | OFF | Shadow-read the tenant-scoped key alongside legacy + report mismatches; no live change. Preview only. |
| `TENANCY_DUAL_WRITE` | OFF | Mirror writes to tenant-scoped keys. Never on in prod without an approved rollout. |
| `AI_WORKFORCE_ENABLED` | OFF | AI workforce subsystem eligibility. |
| `CAPABILITY_REGISTRY_ENABLED` | **ON** | Registry is inert data nothing live reads — enabling it alters no behavior (the sole default-ON flag). |
| `APPROVAL_QUEUE_ENABLED` | OFF | Approval-queue subsystem. |
| `INDUSTRY_PACKS_ENABLED` | OFF | Industry module packs. |
| `INSIGHTS_UI_ENABLED` | OFF | Insights UI. |
| `DESIGN_SYSTEM_REFERENCE_ENABLED` | OFF | Design-system reference surface. |
| `INTAKE_WORKFLOW_ENABLED` | OFF | Governed Book Now intake (events/projection/approval). OFF = byte-identical to legacy booking. |
| `VISION_ESTIMATION_SHADOW` | OFF | **RETIRED.** Old inline shadow path (caused double-analysis timeouts). Wires nothing now — must stay OFF. |
| `VISION_SHADOW_QUEUE_ENABLED` | OFF | Allow enqueueing V2 shadow jobs after the authoritative terminal. |
| `VISION_SHADOW_AUTO_ENQUEUE` | OFF | Auto-enqueue all eligible bookings (off ⇒ selected-only). |
| `VISION_SHADOW_SELECTED_ONLY` | **ON** | Only owner-selected bookings are shadow-eligible (safe calibration default). |
| `VISION_SHADOW_WORKER_ENABLED` | OFF | The independent shadow cron actually processes jobs. |
| `OPERION_AUTOMATION_ENABLED` | OFF | Master switch for any release-automation orchestration. |
| `OPERION_GITHUB_ACTIONS_ENABLED` | OFF | Allow dispatching the target GitHub Actions workflow. |
| `OPERION_PREVIEW_AUTOMATION_ENABLED` | OFF | Allow automated preview prep (branch → tests → preview). |
| `OPERION_PRODUCTION_PROMOTION_ENABLED` | OFF | Allow owner-approved production promotion. |
| `OPERION_AI_ADAPTATION_ENABLED` | OFF | Allow the AI-assisted source→target adaptation strategy. |
| `OPERION_AUTOMATIC_ROLLBACK_ENABLED` | OFF | Allow automatic rollback where a verified path exists. |
| `OPERION_SYNC_STATUS_ENABLED` | OFF | Read-only GitHub/Vercel reconciliation for registered products. |
| `OPERION_SANDBOX_REPAIR_ENABLED` | OFF | Owner-only Preview diagnostics/repair for the disposable sandbox; never enable in Production. |
| `OPERION_APPROVAL_GATE_ENABLED` | OFF | Single-use owner approval and typed confirmation for controlled publish/rollback. Records intent; does not execute by itself. |
| `SHADOW_ANALYTICS_ENABLED` | OFF | Read-only AI-evaluation dashboards over persisted shadow jobs. Enables no shadow processing. |
| `SHADOW_ALERTING_ENABLED` | OFF | Read-only alert evaluation over the same shadow jobs. Sends no customer anything. |

> **Two independent notes.** (1) `VISION_SHADOW_SELECTED_ONLY` defaulting ON is *safe* —
> it narrows eligibility. (2) All `OPERION_*` automation flags are OFF and the control
> plane ships inert; live GitHub/Vercel execution additionally requires the owner to
> provision external setup (GitHub App, Vercel token, target workflow). This
> Activation Readiness tab evaluates those prerequisites without exposing secrets or
> changing flags. A green readiness result is evidence that a staged flag change may be
> considered; it is not permission to enable every stage at once.

## Production reality caveat

`vercel env pull` shows `""` for every `OPERION_*` flag in production — that is
redaction, not "off by value". The **resolved** state is what matters; read it from the
Release Center or the dashboard, not from a pulled blank (doc 02).

## Adding a flag

1. Add the name to the `FeatureFlag` union and a default (**OFF**) to `FLAG_DEFAULTS`.
2. Gate the subsystem with `isEnabled(...)`; keep production wiring a separate change.
3. Add a row here and a one-line description to the Release Center flag map
   (`app/lib/release/`) so it renders with context.
4. Confirm `scripts/platform-flags.test.ts` still passes.
