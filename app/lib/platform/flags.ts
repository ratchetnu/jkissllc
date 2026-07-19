// ── Platform feature flags ───────────────────────────────────────────────────
//
// A single typed source of truth for the platform-foundation flags. Every flag is
// OFF by default except CAPABILITY_REGISTRY_ENABLED — the registry is pure data
// that nothing live reads, so exposing it changes no behavior (see
// docs/opspilot-os/platform-foundation/02-capability-registry.md).
//
// Design notes:
//  • Env-driven, deterministic, no side effects — safe to import anywhere.
//  • `isEnabled(flag, env?)` accepts an override map so tests never mutate the
//    real process.env.
//  • A flag being "on" only means its subsystem is ELIGIBLE to run; it never, by
//    itself, wires anything into a production path. Production wiring is always a
//    separate, explicit change.

export type FeatureFlag =
  | 'TENANCY_ENABLED'
  | 'TENANCY_DARK_LAUNCH'
  | 'TENANCY_DUAL_WRITE'
  | 'AI_WORKFORCE_ENABLED'
  | 'CAPABILITY_REGISTRY_ENABLED'
  | 'APPROVAL_QUEUE_ENABLED'
  | 'INDUSTRY_PACKS_ENABLED'
  | 'INSIGHTS_UI_ENABLED'
  | 'DESIGN_SYSTEM_REFERENCE_ENABLED'
  | 'INTAKE_WORKFLOW_ENABLED'
  | 'VISION_ESTIMATION_SHADOW'
  // Independent V2 shadow subsystem (separate queue/worker/cron — replaces the old
  // inline VISION_ESTIMATION_SHADOW execution, which is retired permanently):
  | 'VISION_SHADOW_QUEUE_ENABLED'   // allow enqueueing shadow jobs after authoritative terminal
  | 'VISION_SHADOW_AUTO_ENQUEUE'    // auto-enqueue ALL eligible bookings (off ⇒ selected-only)
  | 'VISION_SHADOW_SELECTED_ONLY'   // only owner-selected bookings are eligible (safe default ON)
  | 'VISION_SHADOW_WORKER_ENABLED'
  // Operion Update Center automation (controlled release orchestration). ALL default
  // OFF — the control plane deploys inert; live GitHub/Vercel execution needs the owner
  // to provision the GitHub App + Vercel token + add the target-repo workflow first.
  | 'OPERION_AUTOMATION_ENABLED'          // master switch for any automation orchestration
  | 'OPERION_GITHUB_ACTIONS_ENABLED'      // allow dispatching the target GitHub Actions workflow
  | 'OPERION_PREVIEW_AUTOMATION_ENABLED'  // allow automated preview prep (branch→tests→preview)
  | 'OPERION_PRODUCTION_PROMOTION_ENABLED'// allow owner-approved production promotion
  | 'OPERION_AI_ADAPTATION_ENABLED'       // allow the AI-assisted source→target adaptation strategy
  | 'OPERION_AUTOMATIC_ROLLBACK_ENABLED'  // allow automatic rollback (only where a verified path exists)  // the independent shadow cron actually processes jobs
  // Operion Sync Status — the read-only, multi-product reconciliation surface in the
  // Update Center. Reconciles each registered product's Platform Sync Status (vs its
  // configured source platform's baseline) and Deployment Status (live deploy vs its own
  // repo main) by READING GitHub + Vercel. Writes nothing to any repo or deployment and
  // enables no automation. OFF = the surface + its cron are inert (byte-identical today).
  | 'OPERION_SYNC_STATUS_ENABLED'
  // Operion Shadow Analytics — the read-only AI-evaluation control center over the existing
  // persisted shadow jobs. Pure analytics + dashboard; enables NO shadow processing and
  // changes NO customer behavior. Safe to enable independently of the VISION_SHADOW_* flags.
  | 'SHADOW_ANALYTICS_ENABLED'
  // Operion Shadow Alerting — proactive owner notification over the SAME persisted shadow
  // jobs the analytics dashboard reads. Gates the scheduled alert evaluation + the Alerts
  // surface. Observes only: promotes no model, enables no shadow traffic, sends no customer
  // anything. Email delivery is a separate flag (added with the transport in Increment 3).
  | 'SHADOW_ALERTING_ENABLED'
  // Operion Sandbox repair — gates the owner-only, PREVIEW-ONLY diagnostics + repair of the
  // disposable operion-sandbox KV records (its seed landed in the wrong store). Writes ONLY
  // operion-sandbox keys, never a live business, never in Production. Must be set in Preview
  // ONLY — never add it to the Production environment. OFF = the routes 404 and the UI hides.
  | 'OPERION_SANDBOX_REPAIR_ENABLED'
  // Operion Release Center — owner approval + typed-confirmation GATE (Increment 3B.3).
  // Gates ONLY the read/write of pre-publish approval records: the owner types the exact
  // release phrase to record a single-use, short-lived, release-bound approval. It records
  // INTENT — it NEVER publishes, merges, deploys, rolls back, or mutates a business. OFF
  // (incl. Production) = the approval routes 404 and no approval can be created. The actual
  // publish execution stays gated by OPERION_PRODUCTION_PROMOTION_ENABLED in a later phase.
  | 'OPERION_APPROVAL_GATE_ENABLED'

export const FLAG_DEFAULTS: Record<FeatureFlag, boolean> = {
  TENANCY_ENABLED: false,
  // Dark-launch: shadow-read the tenant-scoped key alongside the legacy key and
  // report mismatches, WITHOUT changing the live response. Preview only.
  TENANCY_DARK_LAUNCH: false,
  // Migration validation: mirror writes to the tenant-scoped key as well as the
  // legacy key. Never on in production without an approved rollout stage.
  TENANCY_DUAL_WRITE: false,
  AI_WORKFORCE_ENABLED: false,
  CAPABILITY_REGISTRY_ENABLED: true, // registry is inert data; enabling it alters no behavior
  APPROVAL_QUEUE_ENABLED: false,
  INDUSTRY_PACKS_ENABLED: false,
  INSIGHTS_UI_ENABLED: false,
  DESIGN_SYSTEM_REFERENCE_ENABLED: false,
  // Governed "Book Now" intake workflow: publish business events, project CRM
  // entities, and run the approval/AI-worker/timeline wiring as fail-soft
  // side-effects of the existing booking flow. OFF = byte-identical to today.
  INTAKE_WORKFLOW_ENABLED: false,
  // Vision-estimation enhancements (photo-quality gate, richer inventory/version
  // stamping, calibration signals) run in SHADOW: computed + recorded for admin
  // comparison, NEVER authoritative over the live estimate/quote. OFF = byte-identical
  // to today. Promote only after offline eval + shadow metrics clear (see
  // docs/opspilot-os/vision-estimation/).
  // DEPRECATED / RETIRED: the old inline shadow path (a 2nd vision call inside the
  // authoritative worker) caused the double-analysis timeouts. It is permanently
  // removed from the worker; this flag no longer wires anything and must stay false.
  VISION_ESTIMATION_SHADOW: false,
  // Independent V2 shadow subsystem. QUEUE gates enqueue-on-terminal; WORKER gates the
  // separate cron actually running jobs; AUTO_ENQUEUE off + SELECTED_ONLY on = only
  // owner-selected bookings are ever shadow-analyzed (the safe default for calibration).
  VISION_SHADOW_QUEUE_ENABLED: false,
  VISION_SHADOW_AUTO_ENQUEUE: false,
  VISION_SHADOW_SELECTED_ONLY: true,
  VISION_SHADOW_WORKER_ENABLED: false,
  // Operion automation — every switch OFF. The foundation is inert until the owner
  // completes external setup (GitHub App, Vercel token, target workflow) and flips these.
  OPERION_AUTOMATION_ENABLED: false,
  OPERION_GITHUB_ACTIONS_ENABLED: false,
  OPERION_PREVIEW_AUTOMATION_ENABLED: false,
  OPERION_PRODUCTION_PROMOTION_ENABLED: false,
  OPERION_AI_ADAPTATION_ENABLED: false,
  OPERION_AUTOMATIC_ROLLBACK_ENABLED: false,
  // Read-only multi-product reconciliation surface. OFF = the Sync Status dashboard + its
  // cron are inert; providers are never called. Enabling it only turns on READ reconciliation.
  OPERION_SYNC_STATUS_ENABLED: false,
  SHADOW_ANALYTICS_ENABLED: false,
  // Read-only alert evaluation over the persisted shadow jobs. Safe to enable independently
  // of the VISION_SHADOW_* flags: with the shadow worker off it simply finds nothing new.
  SHADOW_ALERTING_ENABLED: false,
  // Sandbox repair — OFF everywhere by default. Enabled in PREVIEW ONLY when the owner needs
  // to reseed the operion-sandbox test records into the Preview store. Never set in Production.
  OPERION_SANDBOX_REPAIR_ENABLED: false,
  // Approval gate — OFF everywhere by default (incl. Production). Enabled in PREVIEW ONLY to
  // exercise the owner approval + typed-confirmation workflow. Records intent only; no publish.
  OPERION_APPROVAL_GATE_ENABLED: false,
}

export const ALL_FLAGS = Object.keys(FLAG_DEFAULTS) as FeatureFlag[]

type EnvLike = Record<string, string | undefined>

// "true"/"1"/"on"/"yes" → true; "false"/"0"/"off"/"no" → false; anything else → default.
function parseBool(raw: string | undefined, dflt: boolean): boolean {
  if (raw == null) return dflt
  const v = raw.trim().toLowerCase()
  if (v === 'true' || v === '1' || v === 'on' || v === 'yes') return true
  if (v === 'false' || v === '0' || v === 'off' || v === 'no') return false
  return dflt
}

export function isEnabled(flag: FeatureFlag, env: EnvLike = process.env): boolean {
  return parseBool(env[flag], FLAG_DEFAULTS[flag])
}

export function allFlags(env: EnvLike = process.env): Record<FeatureFlag, boolean> {
  const out = {} as Record<FeatureFlag, boolean>
  for (const f of ALL_FLAGS) out[f] = isEnabled(f, env)
  return out
}
