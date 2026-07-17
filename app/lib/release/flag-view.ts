// ── Release Center — redaction-safe feature-flag view ────────────────────────
//
// Turns the resolved flag booleans (app/lib/platform/flags.ts) into a display model
// with STATIC descriptions/categories. It exposes ONLY: flag name, a human label, a
// static description, a category, and two booleans (resolved state + default). It
// NEVER reads or returns the underlying env-var string — a flag's raw value is never
// surfaced. Keep descriptions aligned with docs/operations/15-feature-flags.md.

import { ALL_FLAGS, FLAG_DEFAULTS, allFlags, type FeatureFlag } from '../platform/flags'

export type FlagCategory =
  | 'Tenancy'
  | 'AI & Vision'
  | 'Book Now / Intake'
  | 'Release Automation'
  | 'Shadow Analytics'
  | 'Platform'

export type FlagView = {
  name: FeatureFlag
  label: string
  description: string
  category: FlagCategory
  enabled: boolean
  defaultEnabled: boolean
  overridden: boolean   // resolved state differs from the built-in default
  retired: boolean
}

type FlagMeta = { label: string; description: string; category: FlagCategory; retired?: boolean }

// Static metadata. Any flag missing here still renders (with a generic label) so a new
// flag can never crash this surface — it just shows without a hand-written description.
const META: Partial<Record<FeatureFlag, FlagMeta>> = {
  TENANCY_ENABLED: { label: 'Tenancy', description: 'Master multi-tenant switch. Off in production (single-tenant today).', category: 'Tenancy' },
  TENANCY_DARK_LAUNCH: { label: 'Tenancy dark launch', description: 'Shadow-read tenant-scoped keys and report mismatches; no live change. Preview only.', category: 'Tenancy' },
  TENANCY_DUAL_WRITE: { label: 'Tenancy dual-write', description: 'Mirror writes to tenant-scoped keys. Never on in prod without an approved rollout.', category: 'Tenancy' },
  AI_WORKFORCE_ENABLED: { label: 'AI workforce', description: 'AI workforce subsystem eligibility.', category: 'AI & Vision' },
  CAPABILITY_REGISTRY_ENABLED: { label: 'Capability registry', description: 'Inert registry data nothing live reads — enabling it changes no behavior (the sole default-ON flag).', category: 'Platform' },
  APPROVAL_QUEUE_ENABLED: { label: 'Approval queue', description: 'Approval-queue subsystem eligibility.', category: 'Platform' },
  INDUSTRY_PACKS_ENABLED: { label: 'Industry packs', description: 'Industry module packs.', category: 'Platform' },
  INSIGHTS_UI_ENABLED: { label: 'Insights UI', description: 'Insights UI surface.', category: 'Platform' },
  DESIGN_SYSTEM_REFERENCE_ENABLED: { label: 'Design-system reference', description: 'Design-system reference surface.', category: 'Platform' },
  INTAKE_WORKFLOW_ENABLED: { label: 'Governed intake', description: 'Governed Book Now intake (events/projection/approval). OFF = byte-identical to legacy booking.', category: 'Book Now / Intake' },
  VISION_ESTIMATION_SHADOW: { label: 'Vision shadow (retired)', description: 'RETIRED inline shadow path — wires nothing now and must stay OFF.', category: 'AI & Vision', retired: true },
  VISION_SHADOW_QUEUE_ENABLED: { label: 'Vision shadow queue', description: 'Allow enqueueing V2 shadow jobs after the authoritative terminal.', category: 'AI & Vision' },
  VISION_SHADOW_AUTO_ENQUEUE: { label: 'Vision shadow auto-enqueue', description: 'Auto-enqueue all eligible bookings (off ⇒ selected-only).', category: 'AI & Vision' },
  VISION_SHADOW_SELECTED_ONLY: { label: 'Vision shadow selected-only', description: 'Only owner-selected bookings are shadow-eligible (safe calibration default).', category: 'AI & Vision' },
  VISION_SHADOW_WORKER_ENABLED: { label: 'Vision shadow worker', description: 'The independent shadow cron actually processes jobs.', category: 'AI & Vision' },
  OPERION_AUTOMATION_ENABLED: { label: 'Automation master', description: 'Master switch for any release-automation orchestration.', category: 'Release Automation' },
  OPERION_GITHUB_ACTIONS_ENABLED: { label: 'GitHub Actions dispatch', description: 'Allow dispatching the target GitHub Actions workflow.', category: 'Release Automation' },
  OPERION_PREVIEW_AUTOMATION_ENABLED: { label: 'Preview automation', description: 'Allow automated preview prep (branch → tests → preview).', category: 'Release Automation' },
  OPERION_PRODUCTION_PROMOTION_ENABLED: { label: 'Production promotion', description: 'Allow owner-approved production promotion.', category: 'Release Automation' },
  OPERION_AI_ADAPTATION_ENABLED: { label: 'AI adaptation', description: 'Allow the AI-assisted source→target adaptation strategy.', category: 'Release Automation' },
  OPERION_AUTOMATIC_ROLLBACK_ENABLED: { label: 'Automatic rollback', description: 'Allow automatic rollback where a verified path exists.', category: 'Release Automation' },
  SHADOW_ANALYTICS_ENABLED: { label: 'Shadow analytics', description: 'Read-only AI-evaluation dashboards over persisted shadow jobs. Enables no shadow processing.', category: 'Shadow Analytics' },
  SHADOW_ALERTING_ENABLED: { label: 'Shadow alerting', description: 'Read-only alert evaluation over the same shadow jobs. Sends no customer anything.', category: 'Shadow Analytics' },
}

const humanize = (name: string) =>
  name.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

export const CATEGORY_ORDER: FlagCategory[] = [
  'Release Automation', 'AI & Vision', 'Book Now / Intake', 'Tenancy', 'Shadow Analytics', 'Platform',
]

/**
 * Build the redaction-safe flag view from resolved states. Accepts an env override so
 * it is deterministically testable without mutating process.env. Booleans + static
 * strings only — no raw env value ever leaves this function.
 */
export function buildFlagViews(env: Record<string, string | undefined> = process.env): FlagView[] {
  const resolved = allFlags(env)
  return ALL_FLAGS.map((name) => {
    const meta = META[name]
    const enabled = resolved[name]
    const defaultEnabled = FLAG_DEFAULTS[name]
    return {
      name,
      label: meta?.label ?? humanize(name),
      description: meta?.description ?? 'No description on record.',
      category: meta?.category ?? 'Platform',
      enabled,
      defaultEnabled,
      overridden: enabled !== defaultEnabled,
      retired: meta?.retired ?? false,
    }
  })
}

export function flagSummary(views: FlagView[]): { total: number; enabled: number; disabled: number; overridden: number } {
  return {
    total: views.length,
    enabled: views.filter((v) => v.enabled).length,
    disabled: views.filter((v) => !v.enabled).length,
    overridden: views.filter((v) => v.overridden).length,
  }
}
