// ── Four questions that are not the same question ───────────────────────────
//
// These were one word — "healthy" — and collapsing them is what let a missing
// Stripe key read as a sick platform and, from there, as a reason to withhold a
// security update from the business that had chosen not to take cards.
//
//   1. PLATFORM HEALTH        Is the application running?
//                             Fails only on a CRITICAL dependency (the store).
//                             An optional provider can never make this unhealthy.
//
//   2. RELEASE COMPATIBILITY  Can this tenant safely receive this update?
//                             Answered by preflight. An optional capability may
//                             make an update dormant here; it may never block it.
//
//   3. CAPABILITY READINESS   Can a given optional feature operate for this tenant?
//                             Per capability, and scoped to that capability alone.
//
//   4. PROVIDER HEALTH        Is Stripe / Twilio / Resend / the AI transport
//                             configured, and is it responding?
//
// The rules that fall out, stated once so nothing has to re-derive them:
//   • (4) failing degrades (3) for the capabilities that use that provider, and
//     NOTHING else. It does not touch (1) and it does not touch (2).
//   • (3) being `disabled` is not a failure of anything. It is a configuration.
//   • Only (1) may take the platform down. Only a required platform dependency or
//     an undecided human question may block (2).
//
// This module is a pure projection over the four sources. It performs no I/O and
// makes no decisions of its own — it exists so that a caller cannot accidentally
// ask one of these questions and read the answer as another.

import type { OverallStatus, HealthComponent } from '../health'
import type { PreflightResult, PreflightVerdict } from './automation/preflight'
import type { ProviderReadiness } from './capabilities/provider-readiness'
import type { CapabilityId, ProviderId } from './capabilities/types'
import type { ResolvedCapability } from './capabilities/tenant-profile'

export type ReadinessDimension = 'platform' | 'release' | 'capability' | 'provider'

/** 1. Is the application running? */
export type PlatformHealthView = {
  dimension: 'platform'
  status: OverallStatus
  /** ONLY components marked critical can move this. */
  criticalComponents: { name: string; status: string; detail: string }[]
  /**
   * Components that are degraded but are NOT the platform's problem — an optional
   * provider a tenant does not use, for instance. Listed so the distinction is
   * visible rather than merely believed.
   */
  nonBlocking: { name: string; status: string; applicable: boolean }[]
  summary: string
}

/** 2. Can this tenant safely receive this update? */
export type ReleaseCompatibilityView = {
  dimension: 'release'
  verdict: PreflightVerdict
  /** True for `ready` AND `ready_optional_unavailable` — both mean "send it". */
  canReceive: boolean
  reasons: string[]
  affectedCapabilities: string[]
  summary: string
}

/** 3. Can a given optional feature operate for this tenant? */
export type CapabilityReadinessView = {
  dimension: 'capability'
  capabilities: {
    id: CapabilityId
    displayName: string
    state: ResolvedCapability['state']
    code: string
    provider?: ProviderId
    /** Variable NAMES only. Never values. */
    missingVars: string[]
  }[]
  /** Enabled but not operational — the actionable set. */
  needsAttention: CapabilityId[]
  /** Deliberately off. Not a problem, and never counted as one. */
  intentionallyOff: CapabilityId[]
  summary: string
}

/** 4. Is each external provider configured and responding? */
export type ProviderHealthView = {
  dimension: 'provider'
  providers: {
    id: ProviderId
    label: string
    state: ProviderReadiness['state']
    code: string
    /** False when this tenant does not use the provider at all. */
    applicable: boolean
    missingVars: string[]
    notes: string[]
  }[]
  summary: string
}

export type ReadinessReport = {
  platform: PlatformHealthView
  capability: CapabilityReadinessView
  provider: ProviderHealthView
  /** Absent when no release is being evaluated — the other three stand alone. */
  release?: ReleaseCompatibilityView
}

// ── 1. Platform health ──────────────────────────────────────────────────────

/**
 * Roll components into platform health.
 *
 * The rule this encodes, and the reason the function exists at all: a non-critical
 * component CANNOT make the platform unhealthy. `summarize` in lib/health.ts still
 * reports `degraded` for one, which is the right answer to "is anything less than
 * perfect" — but it is the wrong answer to "is the application running", and it was
 * being read as the latter.
 */
export function platformHealth(components: HealthComponent[], overall: OverallStatus): PlatformHealthView {
  const critical = components.filter((c) => c.critical)
  const down = critical.filter((c) => c.status === 'down')
  const nonBlocking = components
    .filter((c) => !c.critical && c.status !== 'ok')
    .map((c) => ({ name: c.name, status: c.status, applicable: c.applicable !== false }))

  const status: OverallStatus = down.length ? 'unhealthy' : overall === 'unhealthy' ? 'unhealthy' : overall
  return {
    dimension: 'platform',
    status,
    criticalComponents: critical.map((c) => ({ name: c.name, status: c.status, detail: c.detail })),
    nonBlocking,
    summary: down.length
      ? `The application is not running normally: ${down.map((c) => c.name).join(', ')} is down.`
      : nonBlocking.some((c) => c.applicable)
        ? 'The application is running. Some optional features need attention.'
        : 'The application is running.',
  }
}

// ── 2. Release compatibility ────────────────────────────────────────────────

/**
 * `canReceive` is true for BOTH ready verdicts. "Ready with optional features
 * unavailable" is a description of what the update will do on arrival, not a
 * qualification on whether it may arrive.
 */
export function releaseCompatibility(preflight: PreflightResult): ReleaseCompatibilityView {
  const canReceive = preflight.verdict === 'ready' || preflight.verdict === 'ready_optional_unavailable'
  return {
    dimension: 'release',
    verdict: preflight.verdict,
    canReceive,
    reasons: preflight.reasons,
    affectedCapabilities: preflight.affectedCapabilities,
    summary: preflight.summary,
  }
}

// ── 3. Capability readiness ─────────────────────────────────────────────────

export function capabilityReadiness(resolved: Record<CapabilityId, ResolvedCapability>): CapabilityReadinessView {
  const all = Object.values(resolved)
  // "Needs attention" is exactly: the tenant asked for it, and it cannot run.
  // A disabled capability is never in this set, however unconfigured it is.
  const needsAttention = all.filter((c) => c.state === 'setup_required' || c.state === 'degraded' || c.state === 'blocked')
  const intentionallyOff = all.filter((c) => c.state === 'disabled')

  return {
    dimension: 'capability',
    capabilities: all.map((c) => ({
      id: c.id, displayName: c.displayName, state: c.state, code: c.code,
      provider: c.provider, missingVars: c.missingVars,
    })),
    needsAttention: needsAttention.map((c) => c.id),
    intentionallyOff: intentionallyOff.map((c) => c.id),
    summary: needsAttention.length
      ? `${needsAttention.length} feature(s) are switched on but cannot run yet.`
      : 'Every feature this business uses can run.',
  }
}

// ── 4. Provider health ──────────────────────────────────────────────────────

export function providerHealth(readiness: ProviderReadiness[]): ProviderHealthView {
  const trouble = readiness.filter((r) => r.applicable && r.state !== 'ready')
  return {
    dimension: 'provider',
    providers: readiness.map((r) => ({
      id: r.provider, label: r.label, state: r.state, code: r.code,
      applicable: r.applicable, missingVars: r.missingVars, notes: r.notes,
    })),
    summary: trouble.length
      ? `${trouble.length} provider(s) this business uses need attention: ${trouble.map((r) => r.label).join(', ')}.`
      : 'Every provider this business uses is configured.',
  }
}

/**
 * The invariant, as an assertion rather than a comment: an optional provider must
 * never be the reason the platform is unhealthy or a release is blocked.
 *
 * Returns the violations it finds, by name, so a test can fail loudly and an
 * operator can see WHICH provider leaked into a decision it has no business in.
 */
export function assertOptionalProvidersDoNotBlock(report: ReadinessReport): string[] {
  const violations: string[] = []
  const troubled = report.provider.providers.filter((p) => p.state !== 'ready')

  if (report.platform.status === 'unhealthy') {
    const criticalDown = report.platform.criticalComponents.some((c) => c.status === 'down')
    if (!criticalDown) {
      violations.push('platform reports unhealthy with no critical dependency down — something optional is being counted as critical')
    }
  }
  if (report.release && !report.release.canReceive) {
    for (const p of troubled) {
      // A reason that names a provider is a reason that should not exist: the
      // release path has no business reading provider readiness at all.
      if (report.release.reasons.some((r) => r.toLowerCase().includes(p.id))) {
        violations.push(`release blocked by a reason naming provider "${p.id}"`)
      }
    }
  }
  return violations
}
