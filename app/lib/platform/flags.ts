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
