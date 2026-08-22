// ── Tenant capability profile — persistence, authorization, audit ────────────
//
// TENANT-SAFE BOUNDARY, same shape as tenant-settings/branding-store.ts: this
// module is the ONLY place capability selections are read or written, and every
// access runs inside `runWithTenant({ tenantId })` so the live Redis chokepoint
// (app/lib/redis.ts → scopeKey) namespaces the key:
//   • TENANCY_ENABLED=false → `settings:capabilities`
//   • TENANCY_ENABLED=true  → `t:{tenantId}:settings:capabilities`
// The tenant id is ALWAYS server-resolved. A write additionally passes through
// `assertMembership` and an RBAC `settings:manage` check, so a client-supplied
// tenant id is never trusted and a cross-tenant read/write is denied.
//
// NO SECRET EVER REACHES THIS STORE. The record holds selections, a non-secret
// credential REFERENCE, a note, and attribution. Credentials live in the
// deployment's own environment — which is exactly why J KISS and Supercharged can
// share code and share nothing else.

import { redis } from '../../redis'
import { runWithTenant, currentTenantId } from '../tenancy/context'
import { normalizeTenantId } from '../tenancy/keys'
import { can } from '../../rbac'
import type { Role } from '../../rbac'
import { getTenant } from '../tenancy/tenant-registry'
import { assertMembership, TenantAccessDeniedError, type ResolveOpts } from '../tenancy/membership'
import { recordAudit } from '../../audit'
import { INDUSTRY_PACK_REGISTRY } from '../industry-packs/registry'
import type { CapabilityId, ProviderId, Tier } from './types'
import { CAPABILITY_REGISTRY } from './registry'
import {
  CAPABILITY_PROFILE_VERSION, emptyProfile, parseStoredProfile, resolveCapabilityProfile,
  resolveSelection, sanitizeCredentialRef, validateSelections, providerEnablement,
  type CapabilityProfileEntry, type CapabilitySelection, type ProfileChangeError,
  type ResolvedCapability, type TenantCapabilityProfile,
} from './tenant-profile'
import {
  applyBackfillPlan, planCapabilityBackfill, type BackfillPlan,
} from './capability-backfill'
import { recordMigrationCompleted } from '../tenancy/migration-markers'

/** The tenant-owned Redis key (scoped by the chokepoint when tenancy is on). */
const CAPABILITY_KEY = 'settings:capabilities'
const SET_PROFILE_IF_UNCHANGED = `-- CAPABILITY_PROFILE_CAS
local current = redis.call('get', KEYS[1])
if ARGV[1] == 'absent' then
  if current then return 0 end
elseif current ~= ARGV[2] then
  return 0
end
redis.call('set', KEYS[1], ARGV[3])
return 1`

export type CapabilityActor = { sub: string; role: Role }

export class CapabilityConfigError extends Error {
  readonly errors: ProfileChangeError[]
  constructor(errors: ProfileChangeError[]) {
    super(errors.map((e) => e.message).join('; ') || 'invalid capability configuration')
    this.name = 'CapabilityConfigError'
    this.errors = errors
  }
}

/** The capability ids this tenant's product/industry pack offers (undefined = all). */
async function packCapabilitiesFor(tenantId: string): Promise<readonly CapabilityId[] | undefined> {
  try {
    const record = await getTenant(tenantId)
    const packId = record?.industryPackId
    if (!packId) return undefined
    return INDUSTRY_PACK_REGISTRY[packId]?.supportedCapabilities
  } catch {
    // A registry hiccup must never silently narrow what a tenant may use.
    return undefined
  }
}

export type CapabilityProfileRead = {
  profile: TenantCapabilityProfile
  fellBackToDefaults: boolean
  warnings: string[]
}

/**
 * Read the raw stored profile for a SERVER-RESOLVED tenant id. Does not gate on
 * membership: callers pass a tenant id the server already owns. For a caller acting
 * on behalf of a user, use `readCapabilityProfileFor`.
 */
export async function getCapabilityProfile(tenantId: string): Promise<CapabilityProfileRead> {
  const tid = normalizeTenantId(tenantId)
  const raw = await runWithTenant({ tenantId: tid }, () => redis.get(CAPABILITY_KEY))
  return parseStoredProfile(tid, raw as string | null)
}

export type ResolvedCapabilityProfile = {
  tenantId: string
  profile: TenantCapabilityProfile
  capabilities: Record<CapabilityId, ResolvedCapability>
  providers: Record<ProviderId, boolean>
  fellBackToDefaults: boolean
  /**
   * False until `backfillCapabilityProfile` has recorded this tenant's choices.
   * While false, provider adapters fall back to legacy credential inference — a
   * transitional state that is surfaced everywhere rather than hidden, because
   * somebody has to close it.
   */
  initialized: boolean
  warnings: string[]
}

/**
 * The resolved view every other surface consumes. Fail-soft by construction: a
 * store outage yields registry defaults with a warning rather than an exception,
 * because a capability lookup that throws would take down the very routes it is
 * supposed to be describing.
 */
export async function resolveTenantCapabilities(
  tenantId: string,
  opts: { env?: Record<string, string | undefined>; observedFailures?: Partial<Record<ProviderId, boolean>> } = {},
): Promise<ResolvedCapabilityProfile> {
  const tid = normalizeTenantId(tenantId)
  const env = opts.env ?? process.env
  let read: CapabilityProfileRead
  try {
    read = await getCapabilityProfile(tid)
  } catch (err) {
    read = {
      profile: emptyProfile(tid),
      fellBackToDefaults: true,
      warnings: [`capability profile unavailable (${err instanceof Error ? err.name : 'error'}) — using registry defaults`],
    }
  }
  const packCapabilities = await packCapabilitiesFor(tid)
  const plan = await planForTenant(tid)
  const capabilities = resolveCapabilityProfile(read.profile, { env, packCapabilities, plan, observedFailures: opts.observedFailures })
  const initialized = typeof read.profile.initializedAt === 'number' && read.profile.initializedAt > 0
  const warnings = [...read.warnings]
  if (!initialized) {
    warnings.push('this business has not recorded its capability choices yet — payments, texts and email are still being inferred from which credentials exist. Run the capability backfill to replace that with a real record.')
  }
  return {
    tenantId: tid,
    profile: read.profile,
    capabilities,
    providers: providerEnablement(capabilities),
    fellBackToDefaults: read.fellBackToDefaults,
    initialized,
    warnings,
  }
}

/** The tenant's subscription plan, when one is recorded. Absent ⇒ not enforced. */
async function planForTenant(tenantId: string): Promise<Tier | null> {
  try {
    return (await getTenant(tenantId))?.plan ?? null
  } catch {
    // A registry hiccup must never narrow what a tenant may use.
    return null
  }
}

export type BackfillResult = {
  tenantId: string
  dryRun: boolean
  plan: BackfillPlan
  /** True when the profile was already initialized and nothing was written. */
  alreadyInitialized: boolean
  written: boolean
  warnings: string[]
}

/**
 * Record this tenant's effective capability configuration as real choices.
 *
 * IDEMPOTENT: an already-initialized profile is left untouched, so a re-run cannot
 * reset a choice somebody made afterwards. NON-DESTRUCTIVE: it only adds entries,
 * and never removes a credential reference, a note, or an existing explicit choice.
 * A DRY RUN writes nothing at all — not the entries and not the marker, because a
 * plan that recorded itself would be indistinguishable from a run.
 */
export async function backfillCapabilityProfile(
  tenantId: string,
  opts: { dryRun?: boolean; actor?: string; env?: Record<string, string | undefined>; at?: number } = {},
): Promise<BackfillResult> {
  const tid = normalizeTenantId(tenantId)
  const dryRun = opts.dryRun ?? true   // safe by default: an unqualified call plans, it does not write
  const env = opts.env ?? process.env
  const at = opts.at ?? Date.now()
  const actor = opts.actor ?? 'system'

  const raw = await runWithTenant({ tenantId: tid }, () => redis.get(CAPABILITY_KEY)) as string | null
  const current = parseStoredProfile(tid, raw)
  const plan = planCapabilityBackfill({
    tenantId: tid,
    profile: current.profile,
    env,
    packCapabilities: await packCapabilitiesFor(tid),
    plan: await planForTenant(tid),
  })

  if (plan.alreadyInitialized || dryRun) {
    return { tenantId: tid, dryRun, plan, alreadyInitialized: plan.alreadyInitialized, written: false, warnings: current.warnings }
  }
  if (current.fellBackToDefaults) {
    throw new Error(`capability profile is unreadable; backfill made no changes: ${current.warnings.join('; ')}`)
  }

  const next = applyBackfillPlan(current.profile, plan, { at, actor })
  const changed = await runWithTenant({ tenantId: tid }, () => redis.eval(
    SET_PROFILE_IF_UNCHANGED,
    [CAPABILITY_KEY],
    [raw === null ? 'absent' : 'present', raw ?? '', JSON.stringify(next)],
  ))
  if (changed !== 1 && changed !== '1') {
    throw new Error('capability profile changed while the backfill was running; nothing was overwritten, review and retry')
  }

  await runWithTenant({ tenantId: tid }, () => recordMigrationCompleted({
    id: 'capability-profile-backfill',
    tenantId: tid,
    completedAt: at,
    actor,
    counts: {
      recorded: plan.entries.length,
      enabled: plan.entries.filter((e) => e.selection === 'enabled').length,
      disabled: plan.entries.filter((e) => e.selection === 'disabled').length,
      leftUnstated: plan.skipped.length,
    },
  }))

  await runWithTenant({ tenantId: tid }, () => recordAudit({
    tenantId: tid, actor, actorRole: 'system',
    action: 'capability.selection_changed', entity: 'capability',
    outcome: 'success',
    summary: `capability profile initialized — ${plan.entries.length} choice(s) recorded, no behavior changed`,
    meta: { recorded: plan.entries.map((e) => e.capability) },
  }))

  return { tenantId: tid, dryRun: false, plan, alreadyInitialized: false, written: true, warnings: current.warnings }
}

/** Read on behalf of `actor`, enforcing active membership first. */
export async function readCapabilityProfileFor(
  actor: CapabilityActor,
  tenantId: string,
  opts?: ResolveOpts,
): Promise<ResolvedCapabilityProfile> {
  await assertMembership(actor.sub, tenantId, opts)
  return resolveTenantCapabilities(tenantId)
}

export type CapabilityPatchEntry = {
  selection: CapabilitySelection
  credentialRef?: string
  note?: string
}

export type CapabilityPatch = Partial<Record<CapabilityId, CapabilityPatchEntry>>

/**
 * Change a tenant's capability selections. The full boundary:
 *   1. `assertMembership` — the actor must be an active member of `tenantId`.
 *   2. RBAC — the actor's role must hold `settings:manage`.
 *   3. Validation — dependency closure and mandatory capabilities, evaluated
 *      against the state AFTER the whole patch applies.
 *   4. The write is scoped through the chokepoint inside `runWithTenant`.
 *   5. One audit line per capability that actually CHANGED.
 *
 * A denied attempt is audited too — a rejected cross-tenant or under-privileged
 * write is exactly the event a security review needs to see.
 */
export async function setCapabilitySelections(
  actor: CapabilityActor,
  tenantId: string,
  patch: CapabilityPatch,
  opts: ResolveOpts & { env?: Record<string, string | undefined>; at?: number } = {},
): Promise<ResolvedCapabilityProfile> {
  try {
    await assertMembership(actor.sub, tenantId, opts)
  } catch (err) {
    await auditDenied(actor, tenantId, 'cross_tenant_or_not_a_member')
    throw err
  }
  if (!can(actor.role, 'settings:manage')) {
    await auditDenied(actor, tenantId, 'permission_denied')
    throw new TenantAccessDeniedError('permission denied: settings:manage required')
  }

  const tid = normalizeTenantId(tenantId)
  const env = opts.env ?? process.env
  const at = opts.at ?? Date.now()
  const current = await getCapabilityProfile(tid)
  const packCapabilities = await packCapabilitiesFor(tid)

  // Sanitize the incoming patch BEFORE validating or persisting anything.
  const selections: Partial<Record<CapabilityId, CapabilitySelection>> = {}
  const refs: Partial<Record<CapabilityId, string | undefined>> = {}
  const notes: Partial<Record<CapabilityId, string | undefined>> = {}
  const errors: ProfileChangeError[] = []
  for (const [rawId, value] of Object.entries(patch)) {
    const id = rawId as CapabilityId
    if (!CAPABILITY_REGISTRY[id]) { errors.push({ capability: id, code: 'unknown_capability', message: `unknown capability "${id}"` }); continue }
    if (!value || (value.selection !== 'enabled' && value.selection !== 'disabled')) {
      errors.push({ capability: id, code: 'invalid_selection', message: `"${id}" needs selection "enabled" or "disabled"` })
      continue
    }
    selections[id] = value.selection
    if (value.credentialRef !== undefined) {
      const ref = sanitizeCredentialRef(value.credentialRef)
      if (ref === null) {
        // Refused, not truncated: truncating a pasted API key still stores most of it.
        errors.push({ capability: id, code: 'invalid_credential_reference', message: `credentialRef for "${id}" must be a variable name or path, not a value` })
        continue
      }
      refs[id] = ref || undefined
    }
    if (value.note !== undefined) notes[id] = typeof value.note === 'string' ? value.note.slice(0, 300) : undefined
  }

  const effective = (id: CapabilityId): CapabilitySelection =>
    resolveSelection(CAPABILITY_REGISTRY[id], current.profile.entries[id], env).selection

  errors.push(...validateSelections(selections, { effective, packCapabilities }))
  if (errors.length) {
    await auditDenied(actor, tid, 'invalid_configuration', errors.map((e) => e.code))
    throw new CapabilityConfigError(errors)
  }

  // Apply. A capability is "changed" when its EFFECTIVE selection moved, or when the
  // non-secret metadata around it moved — pointing a capability at a different
  // credential source is an operational decision too, and an audit trail that only
  // sees on/off would miss it. Re-submitting an identical selection records nothing,
  // so a UI that saves the whole form does not spam the log.
  const entries: Partial<Record<CapabilityId, CapabilityProfileEntry>> = { ...current.profile.entries }
  const changed: { id: CapabilityId; from: CapabilitySelection; to: CapabilitySelection; fields: string[] }[] = []
  for (const [rawId, selection] of Object.entries(selections)) {
    const id = rawId as CapabilityId
    const before = effective(id)
    const prior = entries[id]
    const nextRef = refs[id] !== undefined ? refs[id] : prior?.credentialRef
    const nextNote = notes[id] !== undefined ? notes[id] : prior?.note
    entries[id] = { selection, credentialRef: nextRef, note: nextNote, updatedAt: at, updatedBy: actor.sub }
    const fields: string[] = []
    if (before !== selection) fields.push('selection')
    if (nextRef !== prior?.credentialRef) fields.push('credentialRef')
    if (nextNote !== prior?.note) fields.push('note')
    if (fields.length) changed.push({ id, from: before, to: selection, fields })
  }

  const next: TenantCapabilityProfile = {
    version: CAPABILITY_PROFILE_VERSION,
    tenantId: tid,
    entries,
    initializedAt: current.profile.initializedAt,
    initializedBy: current.profile.initializedBy,
    updatedAt: at,
    updatedBy: actor.sub,
  }
  await runWithTenant({ tenantId: tid }, () => redis.set(CAPABILITY_KEY, JSON.stringify(next)))

  // The audit log is TENANT-OWNED, so the write needs the tenant scope explicitly —
  // `recordAudit` swallows its own errors, so relying on the caller's ambient context
  // would mean a change silently going unrecorded the moment tenancy is enabled.
  await runWithTenant({ tenantId: tid }, async () => {
    for (const c of changed) {
      await recordAudit({
        tenantId: tid,
        actor: actor.sub,
        actorRole: actor.role,
        action: 'capability.selection_changed',
        entity: 'capability',
        entityId: c.id,
        outcome: 'success',
        summary: c.fields.includes('selection')
          ? `${CAPABILITY_REGISTRY[c.id].displayName} ${c.to === 'enabled' ? 'enabled' : 'disabled'} (was ${c.from})`
          : `${CAPABILITY_REGISTRY[c.id].displayName} configuration updated (${c.fields.join(', ')})`,
        // `credentialRef` is a NAME/path, never a value — see sanitizeCredentialRef.
        meta: { capability: c.id, from: c.from, to: c.to, fields: c.fields },
      })
    }
  })

  return resolveTenantCapabilities(tid, { env })
}

/**
 * Record a refused attempt.
 *
 * WHERE it is filed matters. It is written into the tenant context the request is
 * ALREADY authenticated for — established server-side from the signed session —
 * and never into the tenant that was requested. Two reasons:
 *
 *   • Filing it under the REQUESTED tenant would let anyone who can reach the route
 *     write arbitrary entries into any tenant's audit log just by naming it, which
 *     is a log-pollution channel dressed up as a security feature.
 *   • The actor's own tenant is where an admin reviewing "what did my staff try to
 *     do" actually looks.
 *
 * With no ambient tenant (a background caller with no session) there is no
 * legitimate log to write to, so it is reported to the server log instead of being
 * filed somewhere arbitrary. Either way this NEVER masks the refusal itself.
 */
async function auditDenied(actor: CapabilityActor, tenantId: string, reason: string, codes?: string[]): Promise<void> {
  const actingTenant = currentTenantId()
  if (!actingTenant) {
    console.error('[capabilities] refused change with no tenant context', { actor: actor.sub, reason, codes })
    return
  }
  await recordAudit({
    tenantId: actingTenant,
    actor: actor.sub,
    actorRole: actor.role,
    action: 'capability.selection_changed',
    entity: 'capability',
    outcome: 'denied',
    summary: `capability change refused (${reason})`,
    meta: { requestedTenantId: tenantId, reason, codes },
  }).catch(() => { /* auditing must never mask the refusal */ })
}
