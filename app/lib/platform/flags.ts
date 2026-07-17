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
  // Operion Shadow Analytics — the read-only AI-evaluation control center over the existing
  // persisted shadow jobs. Pure analytics + dashboard; enables NO shadow processing and
  // changes NO customer behavior. Safe to enable independently of the VISION_SHADOW_* flags.
  | 'SHADOW_ANALYTICS_ENABLED'

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
  SHADOW_ANALYTICS_ENABLED: false,
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
