// ── Capability profile backfill — replacing inference with a record ──────────
//
// Enablement used to be inferred from the environment: an adapter was "in use" if
// its credentials happened to be present. That is wrong as a steady state — the
// presence of a key is evidence that somebody once configured something, not that
// this business wants the feature on — but it IS what the code did, so it cannot
// simply be deleted from under a running deployment.
//
// This backfill closes that gap. It reads each tenant's CURRENT EFFECTIVE state and
// writes it down as a set of real choices, then stamps `initializedAt`. From that
// moment the environment no longer decides whether anything is switched ON; it only
// decides whether a switched-on capability is CONFIGURED.
//
// ── Rules it obeys ──────────────────────────────────────────────────────────
//
//  1. BEHAVIOR-PRESERVING. Every entry records what the tenant is doing today. A
//     capability that is live stays live; one that is not stays off.
//  2. It never turns anything ON that is currently off. Recording an integration
//     that is already sending or charging is not enabling it — but flipping a dark
//     one on because a key exists would be, and that is exactly what this replaces.
//  3. IDEMPOTENT. A tenant whose profile is already initialized is left alone, so a
//     re-run is a no-op rather than a reset of somebody's later choices.
//  4. NON-DESTRUCTIVE. It only adds entries. It never removes a credential
//     reference, a note, or an existing explicit choice.
//  5. A dry run writes NOTHING — not the entries, not the marker. A plan that
//     recorded itself would be indistinguishable from a run.
//
// Pure planning is separated from the write so the exact set of changes can be
// reviewed, tested and shown to an operator before anything is persisted.

import type { CapabilityId, Tier } from './types'
import { allCapabilities } from './registry'
import { PROVIDER_SPECS, type Env } from './provider-readiness'
import {
  planIncludes, resolveSelection,
  type CapabilityProfileEntry, type CapabilitySelection, type TenantCapabilityProfile,
} from './tenant-profile'

export type BackfillEntryPlan = {
  capability: CapabilityId
  selection: CapabilitySelection
  /** Why this value — in the operator's words, not the model's. */
  reason: string
  /**
   * True when writing this entry changes nothing about what the tenant experiences.
   * Every entry a backfill writes must be true here; the field exists so a plan can
   * be checked rather than trusted.
   */
  preservesBehavior: boolean
}

export type BackfillPlan = {
  tenantId: string
  /** Already initialized: nothing to do, and nothing will be written. */
  alreadyInitialized: boolean
  entries: BackfillEntryPlan[]
  /** Capabilities deliberately left unstated, and why. */
  skipped: { capability: CapabilityId; reason: string }[]
}

export type BackfillPlanInput = {
  tenantId: string
  profile: TenantCapabilityProfile
  env: Env
  packCapabilities?: readonly CapabilityId[]
  plan?: Tier | null
}

/**
 * Work out exactly what would be recorded, without touching anything.
 *
 * The value written for each capability is the value `resolveSelection` returns for
 * an UNINITIALIZED profile — i.e. precisely what the tenant is experiencing right
 * now, including the legacy credential inference. Writing that down is what makes
 * the inference removable.
 */
export function planCapabilityBackfill(input: BackfillPlanInput): BackfillPlan {
  const initialized = typeof input.profile.initializedAt === 'number' && input.profile.initializedAt > 0
  if (initialized) {
    return { tenantId: input.tenantId, alreadyInitialized: true, entries: [], skipped: [] }
  }

  const entries: BackfillEntryPlan[] = []
  const skipped: { capability: CapabilityId; reason: string }[] = []

  for (const c of allCapabilities()) {
    if (!c.tenantConfigurable) {
      skipped.push({ capability: c.id, reason: 'required by the platform — it has no switch to record' })
      continue
    }
    if (input.profile.entries[c.id]) {
      // An explicit choice already exists. Never overwrite it: the tenant said this.
      skipped.push({ capability: c.id, reason: 'already chosen explicitly — left exactly as it is' })
      continue
    }
    if (c.status === 'planned') {
      skipped.push({ capability: c.id, reason: 'not implemented in this build — nothing to record' })
      continue
    }
    if (input.packCapabilities && c.kind !== 'core' && !input.packCapabilities.includes(c.id)) {
      skipped.push({ capability: c.id, reason: 'not offered by this product pack' })
      continue
    }
    if (!planIncludes(c, input.plan)) {
      skipped.push({ capability: c.id, reason: 'not included in this tenant’s plan' })
      continue
    }

    // The value the tenant is living with RIGHT NOW, legacy inference included.
    const current = resolveSelection(c, undefined, input.env, { initialized: false })

    let reason: string
    if (current.source === 'legacy-uninitialized') {
      reason = current.selection === 'enabled'
        ? `${c.displayName} is in use today (its provider is configured here) — recorded as on so nothing changes`
        : `${c.displayName} is not in use today (its provider is not configured here) — recorded as off`
    } else {
      reason = current.selection === 'enabled'
        ? `${c.displayName} is on by default and is on today — recorded as on`
        : `${c.displayName} is off by default and is off today — recorded as off`
    }

    entries.push({ capability: c.id, selection: current.selection, reason, preservesBehavior: true })
  }

  return { tenantId: input.tenantId, alreadyInitialized: false, entries, skipped }
}

/**
 * Apply a plan to a profile. PURE — the caller persists.
 *
 * Only adds. An existing entry is never replaced, so a plan computed against a
 * slightly older read cannot clobber a choice made in between.
 */
export function applyBackfillPlan(
  profile: TenantCapabilityProfile,
  plan: BackfillPlan,
  opts: { at: number; actor: string },
): TenantCapabilityProfile {
  const entries: Partial<Record<CapabilityId, CapabilityProfileEntry>> = { ...profile.entries }
  for (const e of plan.entries) {
    if (entries[e.capability]) continue
    entries[e.capability] = { selection: e.selection, note: e.reason, updatedAt: opts.at, updatedBy: opts.actor }
  }
  return {
    ...profile,
    entries,
    initializedAt: opts.at,
    initializedBy: opts.actor,
    updatedAt: opts.at,
    updatedBy: opts.actor,
  }
}

/**
 * A human-readable summary of what a plan would do, for the operator who has to
 * approve it. Counts and names only — a credential value could not reach here even
 * if one existed, because a plan holds selections and prose, never configuration.
 */
export function describeBackfillPlan(plan: BackfillPlan): string {
  if (plan.alreadyInitialized) return `${plan.tenantId}: already initialized — nothing to do.`
  const on = plan.entries.filter((e) => e.selection === 'enabled').map((e) => e.capability)
  const off = plan.entries.filter((e) => e.selection === 'disabled').map((e) => e.capability)
  return [
    `${plan.tenantId}: record ${plan.entries.length} choice(s), change nothing.`,
    on.length ? `  on  (already in use): ${on.join(', ')}` : '  on  (already in use): none',
    off.length ? `  off (not in use)   : ${off.join(', ')}` : '  off (not in use)   : none',
    `  left unstated      : ${plan.skipped.length}`,
  ].join('\n')
}

/** Provider ids whose credentials are present here. NAMES only — never values. */
export function configuredProviders(env: Env): string[] {
  return Object.values(PROVIDER_SPECS).filter((s) => s.configured(env)).map((s) => s.id)
}
