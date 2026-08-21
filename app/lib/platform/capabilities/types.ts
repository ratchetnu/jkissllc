// ── Platform capability types ────────────────────────────────────────────────
//
// A capability is a first-class, named unit of platform functionality. The
// registry (registry.ts) is the single typed source of truth for what exists,
// what it depends on, who may use it, and how AI may act on it.
//
// ── The five axes, deliberately kept separate ────────────────────────────────
//
// Collapsing any two of these is how "Supercharged has no Stripe key" turned into
// "Supercharged cannot receive a security fix". They are answered by different
// systems and must never be inferred from one another:
//
//   1. code installed        Does the deployment CONTAIN the implementation?
//                            → the registry (`status`) + the release/update record.
//   2. available in the pack Does this product/industry pack OFFER it?
//                            → registry `kind` + industry-pack membership.
//   3. enabled by the tenant Has THIS business turned it on?
//                            → the tenant capability profile (tenant-profile.ts).
//   4. provider configured   Are the adapter's credentials present?
//                            → provider-readiness.ts, from the ENVIRONMENT only.
//   5. operational           Is it actually working right now?
//                            → readiness + observed provider outcomes.
//
// Installing code (1) and activating a capability (3) are separate events. A core
// update installs regardless of (3) and (4); it simply lands dormant.

import type { Permission, Role } from '../../rbac'
import type { FeatureFlag } from '../flags'
import type { AutonomyLevel } from '../ai-workers/autonomy'

/** Stable capability identifiers — the vocabulary the platform reasons about. */
export const CAPABILITY_IDS = [
  'identity', 'organizations', 'memberships', 'roles', 'permissions',
  'customers', 'businesses', 'leads', 'quotes', 'pricing', 'bookings', 'jobs', 'routes',
  'scheduling', 'workforce', 'crew-reliability', 'hiring', 'availability', 'time-off',
  'time-tracking', 'gps-verification', 'compliance-photos', 'equipment', 'fleet',
  'messaging', 'notifications', 'documents', 'invoicing', 'payments',
  // ── Optional external provider ADAPTERS ──
  // Each is a thin delivery/collection channel over a core record type. The record
  // (a payment, a message, a notification) is core and always works; only the
  // external provider leg is optional and independently selectable.
  'payments-stripe', 'sms-delivery', 'email-delivery',
  // ── Optional SURFACES over a core record ──
  // Same decomposition, applied to things that are not provider adapters. The
  // booking RECORD is the spine of scheduling, invoicing, dispatch and pay, so it
  // is core; the public self-service intake that creates one is a product choice a
  // B2B-only business can decline without losing the record model.
  'booking-intake',
  // AI photo estimation is a paid, external-provider capability distinct from the
  // governed AI service itself: `ai-intelligence` is the runAiTask chokepoint and
  // its governance, while this is the customer-facing estimate that spends money on
  // vision calls. A tenant can want the former's guardrails and decline the latter.
  'photo-estimation',
  'contractor-compensation', 'claims', 'expenses', 'reporting', 'analytics',
  'automations', 'ai-intelligence', 'approvals', 'audit-logs', 'customer-portal',
  'crew-portal', 'management-workspace',
] as const

export type CapabilityId = (typeof CAPABILITY_IDS)[number]

/** External providers the platform can adapt to. One id per credential family. */
export const PROVIDER_IDS = ['stripe', 'twilio', 'resend', 'ai'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

/** Implementation status (mirrors docs/opspilot-os/03-capability-matrix.md). */
export type CapabilityStatus = 'full' | 'partial' | 'backend-only' | 'planned' | 'duplicated'

export type CapabilityKind = 'core' | 'optional' | 'industry-specific'

export type Tier = 'free' | 'starter' | 'pro'

/**
 * Whether subscription plans are being ENFORCED for a tenant.
 *
 * A tenant with no plan recorded is not on a plan — it is a tenant that predates
 * plans, and every capability its pack offers stays available. Enforcement begins
 * only when a plan is actually recorded on the tenant, so introducing the model
 * cannot retroactively take a capability away from anyone.
 */
export type PlanEnforcement = { plan: Tier } | { plan: null }

export type CapabilityAiAction = { id: string; level: AutonomyLevel }

export type Capability = {
  id: CapabilityId
  displayName: string
  description: string
  domain: string // the owning domain (04-domain-model.md)
  /**
   * HARD prerequisites. A capability cannot function while any of these is
   * disabled, so the profile validator refuses a configuration that enables this
   * one with a dependency turned off. Keep this list to genuine prerequisites —
   * see `softDependencies` for "works better with".
   */
  dependencies: CapabilityId[]
  /**
   * Enhances-but-never-requires. Invoicing is the canonical case: an invoice is a
   * record, and it exists, renders, sends and gets marked paid with no card
   * processor at all. Declaring Stripe a hard dependency of invoicing was the bug
   * that made a payment integration a prerequisite for billing.
   */
  softDependencies: CapabilityId[]
  status: CapabilityStatus
  kind: CapabilityKind
  /** The external provider this capability adapts, when it is a provider adapter. */
  provider?: ProviderId
  /**
   * Human-readable, non-technical: what stops working if this is switched off.
   * Rendered verbatim on the owner's settings screen, so it must be a sentence a
   * business owner can act on — not a module name.
   */
  disabledConsequence?: string
  /**
   * Why a capability cannot be switched off, when `tenantConfigurable` is false.
   * Stating the reason is the difference between a control that is missing and one
   * that is deliberately absent.
   */
  mandatoryReason?: string
  requiredPermissions: Permission[] // permissions a user needs to exercise it
  requiredFlags: FeatureFlag[] // flags that must be on for it to be active
  supportedRoles: Role[] // internal roles that can access it (customer surfaces = [])
  aiActions: CapabilityAiAction[] // AI actions the capability supports + their level
  /**
   * The selection a tenant gets when it has expressed no preference. Generalizes
   * the former `enabledForJkiss`: the reference tenant is unchanged (its stored
   * profile is empty, so every capability resolves to this default), and a NEW
   * tenant now gets a sane starting profile instead of the old "everything
   * disabled" that made the registry useless for anyone but J KISS.
   *
   * CONSERVATIVE BY CONSTRUCTION. Every paid or external-provider capability
   * defaults to `'disabled'`: a tenant that has expressed no preference must never
   * find itself spending money, texting customers, or emailing them because a
   * variable happened to be present in the environment.
   *
   * The environment is NOT consulted here, and an earlier draft of this file that
   * did consult it ("in use iff the credentials exist") was wrong for exactly that
   * reason — presence of a key is evidence that somebody once configured something,
   * not that this business wants the feature on. Existing tenants keep their
   * behavior through an explicit, idempotent backfill (capability-backfill.ts)
   * rather than through inference; until that backfill runs, an uninitialized
   * profile falls back to legacy compatibility, which is reported as such.
   */
  defaultSelection: 'enabled' | 'disabled'
  /**
   * Whether a tenant may change the selection at all. Identity, roles and the
   * audit trail are load-bearing: a profile that turns them off is not a product
   * configuration, it is a broken deployment, so the validator refuses it.
   */
  tenantConfigurable: boolean
  tiers: Tier[] // future subscription-tier eligibility
}
