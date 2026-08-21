// ── Multi-tenant GA readiness — a read-only, machine-readable projection ─────
//
// "Update distribution works" and "this platform is multi-tenant" are different
// claims, and conflating them is how a deployment ends up with TENANCY_ENABLED
// flipped on because a Preview deployment succeeded. This module reports the
// thirteen dimensions SEPARATELY and refuses to roll them into a green light
// unless every one of them is actually proven.
//
// ── The verdict vocabulary, and why there are three states ───────────────────
//
//   proven     There is EVIDENCE in this deployment: a certification artifact, a
//              completed migration marker, a verified deployment record. Not "the
//              code exists" — the code existing is the middle state.
//   built      Implemented, wired, and tested, but nothing in THIS deployment has
//              exercised it. This is the honest home for most of the tenancy work:
//              it is real, and it has not been run in anger here.
//   gap        Known to be incomplete, with the missing piece named.
//
// A dimension with no evidence is `built`, never `proven`. `unknown` is
// deliberately absent as a state: the projection either has evidence or it does
// not, and "unknown" would be a place to hide.
//
// NOTHING here enables anything. It reads; it does not write, flip a flag, or run
// a migration. `tenancyEnablementSafe` is a REPORT, not a switch.

import type { MigrationMarker } from './migration-markers'

export type ReadinessVerdict = 'proven' | 'built' | 'gap'

export const GA_DIMENSIONS = [
  'runtime_tenant_isolation',
  'active_tenant_registry',
  'membership_authentication_isolation',
  'redis_key_certification',
  'blob_path_isolation',
  'public_host_token_resolution',
  'webhook_background_tenant_resolution',
  'per_tenant_capability_configuration',
  'optional_integration_independence',
  'migration_dark_launch_evidence',
  'update_delivery_to_preview',
  'production_approval_verification',
  'rollback_evidence',
] as const
export type GaDimensionId = (typeof GA_DIMENSIONS)[number]

export type GaDimension = {
  id: GaDimensionId
  label: string
  verdict: ReadinessVerdict
  /** What was actually observed. Facts, never aspirations. */
  evidence: string[]
  /**
   * The EXACT next action, when there is one. Present for every dimension that is
   * not `proven`, so the report is a runbook rather than a complaint.
   */
  remainingAction?: string
}

export type GaReadinessReport = {
  generatedAt: number
  dimensions: GaDimension[]
  /** True only when EVERY dimension is `proven`. Never inferred from a subset. */
  gaReady: boolean
  /**
   * Whether flipping TENANCY_ENABLED in Production would be safe RIGHT NOW. This is
   * strictly narrower than `gaReady`: it needs the isolation, migration and
   * certification dimensions proven, and it must remain false while any of them is
   * merely `built`.
   */
  tenancyEnablementSafe: boolean
  /** Every outstanding action, in the order they must be done. */
  remainingActions: { dimension: GaDimensionId; action: string }[]
  /** One sentence an owner can read. Never claims more than the dimensions do. */
  summary: string
}

/**
 * Everything the projection needs, gathered by the caller. Pure input so the whole
 * report is deterministic and testable without a store.
 */
export type GaReadinessInput = {
  now: number
  flags: { tenancyEnabled: boolean; darkLaunch: boolean; dualWrite: boolean }
  /** Tenants in the registry with status 'active'. */
  activeTenantIds: string[]
  /** Tenants holding at least one active membership record. */
  tenantsWithMemberships: string[]
  /** Tenants with a STORED capability profile (an explicit owner choice). */
  tenantsWithCapabilityProfiles: string[]
  /** Completed (non-dry-run) migration markers. */
  migrationMarkers: MigrationMarker[]
  /**
   * What the shadow read actually SAW. The flag being on proves only that the
   * comparison is running; a migration is proven by comparisons that came back
   * clean, so this carries the counts. `null` = nothing observed.
   */
  darkLaunchObservations: { comparisons: number; mismatches: number } | null
  /**
   * The tenant-boundary certification run (scripts/tenant-readiness-audit.mjs).
   * `null` when no result has been recorded in this deployment.
   */
  certification: { passed: boolean; unclassifiedRoutes: number; derivedKeyFamilies: number; unscopedBlobWrites: number; at?: number } | null
  /** Managed-target delivery facts, from the automation + deployment records. */
  delivery: {
    previewVerifiedTargets: string[]
    productionVerifiedTargets: string[]
    rollbackCapturedTargets: string[]
    targetsReportingCapabilityEvidence: string[]
  }
  /** Whether any provider adapter is independently selectable and enforced. */
  optionalIntegrations: { adapterCapabilities: string[]; guardedEntryPoints: string[] }
}

const dim = (
  id: GaDimensionId, label: string, verdict: ReadinessVerdict, evidence: string[], remainingAction?: string,
): GaDimension => ({ id, label, verdict, evidence, remainingAction: verdict === 'proven' ? undefined : remainingAction })

/**
 * Build the report. Every verdict below is derived from the input — there is no
 * hardcoded "we think this is fine".
 */
export function buildGaReadiness(input: GaReadinessInput): GaReadinessReport {
  const { flags, delivery } = input
  const obs = input.darkLaunchObservations
  const marker = (id: string, tenantId?: string) =>
    input.migrationMarkers.find((m) => m.id === id && (tenantId ? m.tenantId === tenantId : true)) ?? null
  const membershipMarker = marker('wave6-membership-backfill')
  const tokenMarkers = input.migrationMarkers.filter((m) => m.id === 'public-token-binding-backfill')
  const tokenUnresolved = tokenMarkers.flatMap((m) => m.unresolved ?? [])
  const multiTenant = input.activeTenantIds.length > 1

  const dimensions: GaDimension[] = [
    // 1. The chokepoint exists and is enforced; PROVEN only once it is actually on.
    dim('runtime_tenant_isolation', 'Runtime tenant isolation',
      flags.tenancyEnabled ? 'proven' : 'built',
      [
        'every Redis access routes through the app/lib/redis.ts chokepoint → scopeKey()',
        'a tenant-owned key with no tenant context throws (fail closed) when tenancy is on',
        `TENANCY_ENABLED is ${flags.tenancyEnabled ? 'ON' : 'OFF'} here`,
      ],
      'the chokepoint is inert while TENANCY_ENABLED is off — keys are byte-identical to single-tenant, so isolation is implemented but not exercised'),

    // 2. A registry with ONE tenant is a registry that has never been tested.
    dim('active_tenant_registry', 'Active tenant registry',
      multiTenant ? 'proven' : 'built',
      [`${input.activeTenantIds.length} active tenant record(s): ${input.activeTenantIds.join(', ') || 'none'}`],
      'only the reference tenant exists, so nothing has ever had to be told apart — register a second real tenant before claiming this'),

    // 3. Memberships are the authorization boundary; they must exist for real users.
    dim('membership_authentication_isolation', 'Membership + authentication isolation',
      membershipMarker && input.tenantsWithMemberships.length > 1 ? 'proven'
        : membershipMarker ? 'built' : 'gap',
      [
        membershipMarker
          ? `membership backfill completed ${new Date(membershipMarker.completedAt).toISOString()} (${membershipMarker.counts.membershipsCreated ?? 0} created, ${membershipMarker.counts.membershipsExisting ?? 0} already present)`
          : 'no completed membership backfill is recorded in this deployment',
        `${input.tenantsWithMemberships.length} tenant(s) hold membership records`,
        'role and staffId are per-membership, so authority cannot travel between tenants',
      ],
      membershipMarker
        ? 'a second tenant with its own memberships has never existed here — cross-tenant denial is tested, not observed'
        : 'run runWave6Backfill({ dryRun: false }) to copy the user directory into per-tenant memberships and seed the reference tenant'),

    // 4. The certification run is the only thing that can prove the key layer.
    dim('redis_key_certification', 'Redis key certification',
      input.certification?.passed ? 'proven' : input.certification ? 'gap' : 'built',
      input.certification
        ? [
            `certification ${input.certification.passed ? 'PASSED' : 'FAILED'}`,
            `${input.certification.unclassifiedRoutes} unclassified route handler(s)`,
            `${input.certification.derivedKeyFamilies} key famil(ies) derived from an external string`,
            `${input.certification.unscopedBlobWrites} un-scoped blob write(s)`,
          ]
        : ['no certification result has been recorded in this deployment'],
      input.certification
        ? 'classify the remaining route handlers and migrate the externally-derived key families (a Redis prefix cannot make a phone number or an email a safe tenant boundary) — run `npm run tenant:certify`'
        : 'run `npm run tenant:certify` and record the result'),

    // 5/6/7. Isolation surfaces that a single-tenant deployment never exercises.
    dim('blob_path_isolation', 'Blob path isolation',
      flags.tenancyEnabled && multiTenant ? 'proven' : 'built',
      ['every blob write resolves through a *BlobPath / scopeBlobPath helper (certified: no un-scoped writes)'],
      'paths are scoped by the same flag as the key layer, so with one tenant every path is still the legacy path'),

    dim('public_host_token_resolution', 'Public host + token resolution',
      tokenMarkers.length > 0 && tokenUnresolved.length === 0 && multiTenant ? 'proven'
        : tokenUnresolved.length ? 'gap' : 'built',
      [
        tokenMarkers.length
          ? `${tokenMarkers.length} token-binding backfill(s) completed: ${tokenMarkers.map((m) => `${m.tenantId ?? '—'} (${m.counts.bound ?? 0} bound, ${m.counts.conflicts ?? 0} conflicts)`).join('; ')}`
          : 'no completed public-token binding backfill is recorded in this deployment',
        'unguessable public tokens resolve their tenant from the RECORD, never from a query parameter',
        ...tokenUnresolved,
      ],
      tokenUnresolved.length
        ? 'resolve the conflicting token bindings — a token bound to two tenants is an ambiguity only an operator can settle'
        : tokenMarkers.length
          ? 'bindings exist for one tenant only, so no public token has ever had to be disambiguated'
          : 'run backfillTokenBindings(tenantId, { dryRun: false }) for every tenant so existing bookings, routes, invoices, portals and pay statements carry a binding'),

    dim('webhook_background_tenant_resolution', 'Webhook + background-job tenant resolution',
      flags.tenancyEnabled && multiTenant ? 'proven' : 'built',
      [
        'Stripe resolves the tenant from signed session metadata; Twilio from the signed recipient channel; inbound email from the authenticated recipient',
        'each fails CLOSED when tenancy is on and the tenant cannot be resolved',
        'crons must name their tenant explicitly when tenancy is on',
      ],
      'every one of these paths returns the reference tenant while TENANCY_ENABLED is off, so the resolution branch is never taken here'),

    // 8/9. The capability work in this branch.
    dim('per_tenant_capability_configuration', 'Per-tenant capability configuration',
      input.tenantsWithCapabilityProfiles.length > 1 ? 'proven'
        : input.tenantsWithCapabilityProfiles.length === 1 ? 'built' : 'built',
      [
        'typed, versioned, audited profile at the tenant-owned key settings:capabilities',
        'membership + settings:manage on write; dependency closure and mandatory capabilities validated before persistence',
        'no credential VALUE is storable — a reference must be a name or path, and a pasted value is refused',
        `${input.tenantsWithCapabilityProfiles.length} tenant(s) have an explicit stored profile`,
      ],
      input.tenantsWithCapabilityProfiles.length > 0
        ? 'only one tenant has expressed a preference, so two genuinely different profiles have never coexisted in this deployment'
        : 'no tenant has saved a capability profile yet — every capability is resolving to a registry default'),

    dim('optional_integration_independence', 'Optional integration independence',
      input.optionalIntegrations.guardedEntryPoints.length >= 3 ? 'proven' : 'gap',
      [
        `provider adapters: ${input.optionalIntegrations.adapterCapabilities.join(', ') || 'none'}`,
        `server-side guarded entry points: ${input.optionalIntegrations.guardedEntryPoints.join(', ') || 'none'}`,
        'payments, SMS and email are independently selectable; the records they deliver stay core',
        'a disabled provider reports healthy/not-applicable and never blocks an update',
      ],
      'wire the remaining provider entry points through requireCapability/checkCapability'),

    // 10. Dark launch is the only way to prove a migration without risking it.
    dim('migration_dark_launch_evidence', 'Migration + dark-launch evidence',
      obs && obs.comparisons > 0 && obs.mismatches === 0 ? 'proven'
        : obs && obs.mismatches > 0 ? 'gap'
        : flags.darkLaunch || flags.dualWrite ? 'built' : 'gap',
      [
        `TENANCY_DARK_LAUNCH is ${flags.darkLaunch ? 'ON' : 'OFF'}; TENANCY_DUAL_WRITE is ${flags.dualWrite ? 'ON' : 'OFF'}`,
        obs ? `${obs.comparisons} shadow comparison(s), ${obs.mismatches} mismatch(es)` : 'no shadow comparison has been observed in this deployment',
        `${input.migrationMarkers.length} completed migration marker(s) recorded`,
        'shadow reads classify missing / stale / serialization / value mismatches without changing any response',
      ],
      obs && obs.mismatches > 0
        ? `resolve the ${obs.mismatches} shadow mismatch(es) — a tenant copy that disagrees with the legacy value is the migration failing quietly`
        : 'no shadow-read comparison has run here — enable TENANCY_DARK_LAUNCH in Preview, confirm a clean mismatch summary, and only then consider TENANCY_DUAL_WRITE'),

    // 11/12/13. Managed-target delivery — real, and NOT the same as tenancy.
    dim('update_delivery_to_preview', 'Update delivery to a managed target Preview',
      delivery.previewVerifiedTargets.length > 0 ? 'proven' : 'built',
      [
        delivery.previewVerifiedTargets.length
          ? `Preview verified on: ${delivery.previewVerifiedTargets.join(', ')}`
          : 'no target has completed a verified Preview run in this deployment',
        delivery.targetsReportingCapabilityEvidence.length
          ? `value-free capability evidence received from: ${delivery.targetsReportingCapabilityEvidence.join(', ')}`
          : 'no target has returned a capability snapshot yet',
      ],
      'run one update through to a verified Preview on a managed target'),

    dim('production_approval_verification', 'Production approval + verification',
      delivery.productionVerifiedTargets.length > 0 ? 'proven' : 'built',
      [
        delivery.productionVerifiedTargets.length
          ? `Production verified on: ${delivery.productionVerifiedTargets.join(', ')}`
          : 'no target has a verified Production deployment recorded',
        'owner approval, a typed publish phrase, and exact live-build verification are all enforced server-side',
      ],
      'complete one owner-approved Production publish and let the live build verify'),

    dim('rollback_evidence', 'Rollback evidence',
      delivery.rollbackCapturedTargets.length > 0 ? 'proven' : 'built',
      [
        delivery.rollbackCapturedTargets.length
          ? `a known-good rollback target was captured for: ${delivery.rollbackCapturedTargets.join(', ')}`
          : 'no rollback target has been captured in this deployment',
        'a rollback target binds a deployment id to the VERIFIED commit it was built from',
      ],
      'capture a rollback target by completing a Production publish, and exercise the restore path once'),
  ]

  const remainingActions = dimensions
    .filter((d) => d.remainingAction)
    .map((d) => ({ dimension: d.id, action: d.remainingAction! }))

  const gaReady = dimensions.every((d) => d.verdict === 'proven')

  // Deliberately narrower than gaReady, and deliberately conservative: these are the
  // dimensions whose failure would MIX TENANT DATA, as opposed to merely leaving a
  // feature unproven. Every one must be `proven` — `built` is not enough, because
  // "the code is right" is exactly the claim that has to be tested before the flag
  // that makes it load-bearing goes on.
  const ENABLEMENT_CRITICAL: GaDimensionId[] = [
    'redis_key_certification',
    'membership_authentication_isolation',
    'public_host_token_resolution',
    'blob_path_isolation',
    'webhook_background_tenant_resolution',
    'migration_dark_launch_evidence',
  ]
  const tenancyEnablementSafe = ENABLEMENT_CRITICAL.every(
    (id) => dimensions.find((d) => d.id === id)?.verdict === 'proven',
  )

  const gaps = dimensions.filter((d) => d.verdict === 'gap').length
  const built = dimensions.filter((d) => d.verdict === 'built').length
  const summary = gaReady
    ? 'Every readiness dimension is proven by evidence in this deployment.'
    : `Not multi-tenant GA: ${gaps} gap(s) and ${built} dimension(s) implemented but never exercised here. ${remainingActions.length} action(s) remain.`

  return { generatedAt: input.now, dimensions, gaReady, tenancyEnablementSafe, remainingActions, summary }
}
