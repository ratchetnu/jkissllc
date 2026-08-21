// ── Tenant capability profile — the PURE model ───────────────────────────────
//
// What a specific business has turned on. This is the third of the five axes in
// capabilities/types.ts, and it is the one that had no implementation: enablement
// used to be a single registry boolean that answered for tenant zero and returned
// "disabled" for everybody else.
//
// This file is pure — no Redis, no session, no environment reads other than the
// map a caller hands it. Persistence, authorization and audit live in
// tenant-profile-store.ts, so every rule below is testable without a store.
//
// ── What is stored, and what is deliberately NOT ─────────────────────────────
//
// Stored: a selection per capability, a NON-SECRET credential reference, a note,
// and who changed it when. Never stored: an API key, a token, a signing secret, a
// phone number, an account id, or anything else whose disclosure would matter.
// Credentials stay in the deployment's environment, which is per-target and never
// shared between J KISS and Supercharged.
//
// ── Versioning ───────────────────────────────────────────────────────────────
//
// A record from a FUTURE version is not silently reinterpreted. An older build
// cannot know what a newer field means, and guessing would change live behavior
// from a record the operator believes is authoritative. Such a record is reported
// as unreadable and the deployment falls back to registry defaults, loudly.

import type { Capability, CapabilityId, ProviderId, Tier } from './types'
import { CAPABILITY_IDS } from './types'
import { CAPABILITY_REGISTRY, allCapabilities, getCapability } from './registry'
import { PROVIDER_SPECS, type Env } from './provider-readiness'

/** Bumped only for a change an older build could MISREAD, never for additive data. */
export const CAPABILITY_PROFILE_VERSION = 1

export type CapabilitySelection = 'enabled' | 'disabled'

export type CapabilityProfileEntry = {
  selection: CapabilitySelection
  /**
   * WHERE the credential lives — never the credential. An environment variable
   * name, a Vercel project id, a secret-manager path. Bounded and sanitized on
   * write so a key pasted into the wrong box cannot be persisted.
   */
  credentialRef?: string
  note?: string
  updatedAt: number
  updatedBy: string
}

export type TenantCapabilityProfile = {
  version: number
  tenantId: string
  entries: Partial<Record<CapabilityId, CapabilityProfileEntry>>
  /**
   * When this tenant's profile was INITIALIZED — i.e. when the backfill recorded
   * its effective configuration as a set of real choices.
   *
   * This is the switch between two resolution regimes, and it exists so that
   * removing environment inference cannot silently change a live deployment:
   *
   *   set    → registry defaults apply to anything unstated. Defaults are
   *            conservative, so an unstated paid capability is OFF.
   *   absent → LEGACY COMPATIBILITY. A provider adapter falls back to "in use iff
   *            its credentials are present", which is exactly what the code did
   *            before capabilities existed. Reported as `legacy-uninitialized`
   *            everywhere it is surfaced, because it is a transitional state that
   *            somebody has to close, not a configuration anybody chose.
   *
   * Inferring enablement from an environment variable is wrong as a steady state:
   * the presence of a key is evidence that somebody once configured something, not
   * that this business wants the feature on. It is retained ONLY to keep an
   * un-migrated tenant working until `backfillCapabilityProfile` runs.
   */
  initializedAt?: number
  initializedBy?: string
  updatedAt: number
  updatedBy: string
}

/** Why a capability ended up in the state it is in — shown to the owner, and
 *  recorded in deployment evidence so "it defaulted" is never mistaken for a choice. */
export type SelectionSource =
  | 'explicit'              // the owner chose it
  | 'registry-default'      // no choice expressed; the shipped (conservative) default
  | 'legacy-uninitialized'  // profile never initialized; inferred from credentials
  | 'mandatory'             // not tenant-configurable
  | 'plan'                  // the tenant's plan does not include it

export type CapabilityState =
  | 'not_installed'         // the code is not in this build at all
  | 'not_in_pack'           // installed, but this product/industry pack does not offer it
  | 'unavailable_on_plan'   // offered, but the tenant's plan does not include it
  | 'disabled'              // installed and offered; the tenant declined it
  | 'blocked'               // enabled, but a hard prerequisite is off
  | 'setup_required'        // enabled; its provider has no credentials here
  | 'ready'
  | 'degraded'              // enabled + configured; the last real call failed

/** Stable, non-secret codes. Safe in an API response, a log, and signed evidence. */
export const CAPABILITY_STATE_CODES = {
  not_installed: 'capability_not_installed',
  not_in_pack: 'capability_not_in_pack',
  unavailable_on_plan: 'capability_unavailable_on_plan',
  disabled: 'capability_disabled',
  blocked: 'capability_prerequisite_disabled',
  setup_required: 'capability_setup_required',
  ready: 'capability_ready',
  degraded: 'capability_degraded',
} as const satisfies Record<CapabilityState, string>

export type ResolvedCapability = {
  id: CapabilityId
  displayName: string
  kind: Capability['kind']
  provider?: ProviderId
  // ── the five axes, kept separate on purpose ──
  codeInstalled: boolean
  packAvailable: boolean
  /** False only when a plan is being enforced and does not include this capability. */
  planAvailable: boolean
  tenantEnabled: boolean
  providerConfigured: boolean | null // null = needs no provider
  operational: boolean
  // ── derived ──
  state: CapabilityState
  code: string
  selectionSource: SelectionSource
  /** Hard prerequisites that are off. Non-empty only in the `blocked` state. */
  blockedBy: CapabilityId[]
  /** Variable NAMES still needed. Never values. */
  missingVars: string[]
}

export type ResolveOptions = {
  env: Env
  /** Capability ids this product/industry pack offers. Omit = everything is offered. */
  packCapabilities?: readonly CapabilityId[]
  /** Observed provider failures, by provider. Fail-soft: omit and nothing changes. */
  observedFailures?: Partial<Record<ProviderId, boolean>>
  /**
   * The tenant's subscription plan, when plans are being enforced. `null` or absent
   * means NOT ENFORCED — a tenant that predates plans keeps everything its pack
   * offers, so introducing the model cannot retroactively take a capability away.
   */
  plan?: Tier | null
  /**
   * The capability set to resolve against. Defaults to the live registry.
   *
   * Injectable for the same reason `validateCapabilityRegistry` is: some rules can
   * only be exercised by data the shipped registry does not currently contain. Every
   * capability today declares all three tiers, so plan enforcement is inert in
   * production — and a test that could only assert against that data would be
   * asserting nothing. Overriding the set lets the RULE be tested now, so it is
   * already proven on the day somebody first restricts a tier.
   */
  capabilities?: readonly Capability[]
}

// ── Reading a stored record ──────────────────────────────────────────────────

export type ProfileReadResult = {
  profile: TenantCapabilityProfile
  /** True when a stored record could not be trusted and defaults were used. */
  fellBackToDefaults: boolean
  warnings: string[]
}

const MAX_REF = 120
const MAX_NOTE = 300
/** A credential REFERENCE is a name/path, never a secret. Anything that does not
 *  look like one is refused rather than truncated — truncating a pasted API key
 *  would still persist most of it. */
const CREDENTIAL_REF_RE = /^[A-Za-z0-9_./:-]{1,120}$/

export function emptyProfile(tenantId: string, at = 0): TenantCapabilityProfile {
  return { version: CAPABILITY_PROFILE_VERSION, tenantId, entries: {}, updatedAt: at, updatedBy: 'system' }
}

const KNOWN = new Set<string>(CAPABILITY_IDS)

/**
 * Parse a stored blob into a profile. Never throws: an unreadable or future-version
 * record yields registry defaults plus a warning, because a capability surface that
 * crashes on bad data is worse than one that reports it.
 */
export function parseStoredProfile(tenantId: string, raw: string | null | undefined): ProfileReadResult {
  if (!raw) return { profile: emptyProfile(tenantId), fellBackToDefaults: false, warnings: [] }

  let obj: unknown
  try { obj = JSON.parse(raw) } catch {
    return { profile: emptyProfile(tenantId), fellBackToDefaults: true, warnings: ['stored capability profile is not valid JSON — using registry defaults'] }
  }
  if (!obj || typeof obj !== 'object') {
    return { profile: emptyProfile(tenantId), fellBackToDefaults: true, warnings: ['stored capability profile is not an object — using registry defaults'] }
  }
  const o = obj as Record<string, unknown>
  const version = typeof o.version === 'number' && Number.isFinite(o.version) ? o.version : 0

  // A record written by a NEWER build may encode selections this build would
  // misread. Fall back loudly rather than act on a guess.
  if (version > CAPABILITY_PROFILE_VERSION) {
    return {
      profile: emptyProfile(tenantId),
      fellBackToDefaults: true,
      warnings: [`stored capability profile is version ${version}; this build understands ${CAPABILITY_PROFILE_VERSION} — using registry defaults and changing nothing`],
    }
  }

  const warnings: string[] = []
  const entries: Partial<Record<CapabilityId, CapabilityProfileEntry>> = {}
  const rawEntries = o.entries && typeof o.entries === 'object' ? (o.entries as Record<string, unknown>) : {}
  for (const [key, value] of Object.entries(rawEntries)) {
    if (!KNOWN.has(key)) { warnings.push(`stored profile references unknown capability "${key}" — ignored`); continue }
    if (!value || typeof value !== 'object') { warnings.push(`stored entry for "${key}" is malformed — ignored`); continue }
    const e = value as Record<string, unknown>
    if (e.selection !== 'enabled' && e.selection !== 'disabled') { warnings.push(`stored entry for "${key}" has no valid selection — ignored`); continue }
    const ref = typeof e.credentialRef === 'string' && CREDENTIAL_REF_RE.test(e.credentialRef.trim()) ? e.credentialRef.trim() : undefined
    entries[key as CapabilityId] = {
      selection: e.selection,
      credentialRef: ref,
      note: typeof e.note === 'string' ? e.note.slice(0, MAX_NOTE) : undefined,
      updatedAt: typeof e.updatedAt === 'number' && Number.isFinite(e.updatedAt) ? e.updatedAt : 0,
      updatedBy: typeof e.updatedBy === 'string' ? e.updatedBy.slice(0, 120) : 'unknown',
    }
  }

  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)
  return {
    profile: {
      version: CAPABILITY_PROFILE_VERSION,
      tenantId,
      entries,
      // Carried through explicitly. Losing it would silently put an already-migrated
      // tenant back on the legacy credential fallback — which is worse than never
      // having migrated, because the record would say one thing and the runtime
      // another.
      initializedAt: num(o.initializedAt),
      initializedBy: typeof o.initializedBy === 'string' ? o.initializedBy.slice(0, 120) : undefined,
      updatedAt: typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt) ? o.updatedAt : 0,
      updatedBy: typeof o.updatedBy === 'string' ? o.updatedBy.slice(0, 120) : 'unknown',
    },
    fellBackToDefaults: false,
    warnings,
  }
}

/** Sanitize a caller-supplied credential reference. Returns null when it must be refused. */
export function sanitizeCredentialRef(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t) return ''
  if (t.length > MAX_REF) return null
  return CREDENTIAL_REF_RE.test(t) ? t : null
}

// ── Resolution ───────────────────────────────────────────────────────────────

/** Whether the code for a capability is present in THIS build. */
export function codeInstalled(c: Capability): boolean {
  return c.status !== 'planned'
}

function packOffers(c: Capability, pack: readonly CapabilityId[] | undefined): boolean {
  if (!pack) return true
  // Core is the platform, not the vertical — a pack never removes it.
  if (c.kind === 'core') return true
  return pack.includes(c.id)
}

/**
 * The tenant's effective selection for one capability, and WHY.
 *
 * Precedence: mandatory → explicit choice → registry default → legacy fallback.
 *
 * An explicit choice always wins, which is what keeps "the owner turned SMS on and
 * it isn't configured" visible instead of quietly re-inferring it off.
 *
 * The environment is consulted in exactly ONE case: a provider adapter, on a tenant
 * whose profile has never been initialized. That is a transitional compatibility
 * path, not a rule — see `TenantCapabilityProfile.initializedAt`. Once the backfill
 * has run, the environment has no bearing on whether a capability is switched on;
 * it only decides whether a switched-on capability is CONFIGURED.
 */
export function resolveSelection(
  c: Capability,
  entry: CapabilityProfileEntry | undefined,
  env: Env,
  opts: { initialized?: boolean } = {},
): { selection: CapabilitySelection; source: SelectionSource } {
  if (!c.tenantConfigurable) return { selection: 'enabled', source: 'mandatory' }
  if (entry) return { selection: entry.selection, source: 'explicit' }
  if (opts.initialized === false && c.provider) {
    const configured = PROVIDER_SPECS[c.provider].configured(env)
    return { selection: configured ? 'enabled' : 'disabled', source: 'legacy-uninitialized' }
  }
  return { selection: c.defaultSelection === 'enabled' ? 'enabled' : 'disabled', source: 'registry-default' }
}

/**
 * Whether the tenant's plan includes a capability.
 *
 * Not enforced until a plan is actually recorded: a tenant that predates plans is
 * not on the free tier, it is on no tier, and treating "unknown" as "the cheapest"
 * would silently remove working features from every existing business the day the
 * model shipped.
 */
export function planIncludes(c: Capability, plan: Tier | null | undefined): boolean {
  if (!plan) return true
  return c.tiers.includes(plan)
}

/**
 * Resolve every capability for a tenant. The result is the value every other
 * surface reads: health, the settings UI, the runtime guards, and the value-free
 * snapshot returned to Operion after a deployment.
 */
export function resolveCapabilityProfile(
  profile: TenantCapabilityProfile,
  opts: ResolveOptions,
): Record<CapabilityId, ResolvedCapability> {
  const out = {} as Record<CapabilityId, ResolvedCapability>

  // Pass 1: per-capability facts, independent of other capabilities.
  const initialized = typeof profile.initializedAt === 'number' && profile.initializedAt > 0
  const registry = opts.capabilities ?? allCapabilities()
  const selections = new Map<CapabilityId, CapabilitySelection>()
  for (const c of registry) {
    const onPlan = planIncludes(c, opts.plan)
    const resolved = resolveSelection(c, profile.entries[c.id], opts.env, { initialized })
    // A plan that does not include a capability overrides the selection outright:
    // a stored "enabled" from a richer plan must not survive a downgrade.
    const selection = onPlan ? resolved.selection : 'disabled'
    const source = onPlan ? resolved.source : 'plan'
    selections.set(c.id, selection)
    const installed = codeInstalled(c)
    const offered = packOffers(c, opts.packCapabilities)
    const spec = c.provider ? PROVIDER_SPECS[c.provider] : null
    const providerConfigured = spec ? spec.configured(opts.env) : null
    out[c.id] = {
      id: c.id,
      displayName: c.displayName,
      kind: c.kind,
      provider: c.provider,
      codeInstalled: installed,
      packAvailable: offered,
      planAvailable: onPlan,
      tenantEnabled: selection === 'enabled',
      providerConfigured,
      operational: false, // filled in below
      state: 'disabled',
      code: CAPABILITY_STATE_CODES.disabled,
      selectionSource: source,
      blockedBy: [],
      missingVars: spec ? spec.missing(opts.env) : [],
    }
  }

  // Pass 2: derive state, which needs the other capabilities' selections.
  for (const c of registry) {
    const r = out[c.id]
    const blockedBy = c.dependencies.filter((d) => selections.get(d) === 'disabled')

    let state: CapabilityState
    if (!r.codeInstalled) state = 'not_installed'
    else if (!r.packAvailable) state = 'not_in_pack'
    else if (!r.planAvailable) state = 'unavailable_on_plan'
    else if (!r.tenantEnabled) state = 'disabled'
    else if (blockedBy.length) state = 'blocked'
    else if (r.providerConfigured === false) state = 'setup_required'
    else if (c.provider && opts.observedFailures?.[c.provider]) state = 'degraded'
    else state = 'ready'

    r.state = state
    r.code = CAPABILITY_STATE_CODES[state]
    r.blockedBy = blockedBy
    r.operational = state === 'ready'
    // `missingVars` is the answer to "what do you still need from me?", so it is
    // meaningful ONLY when the tenant has asked for the capability and it cannot yet
    // run. A disabled capability needs nothing: listing variables beside it invites
    // somebody to go and set them, which is precisely the wrong action.
    if (state !== 'setup_required') r.missingVars = []
  }

  return out
}

/**
 * Which providers this business INTENDS to use. Feeds provider-readiness, and
 * through it health.
 *
 * "Intends to use" is narrower than the raw selection: a capability the pack does
 * not offer, or whose code is not in this build, is not in use no matter what the
 * selection says — and reporting it as enabled would degrade health over a channel
 * the deployment cannot run at all. It is deliberately WIDER than `operational`,
 * because "enabled but unconfigured" must stay visible rather than resolving itself
 * back to off.
 */
export function providerEnablement(resolved: Record<CapabilityId, ResolvedCapability>): Record<ProviderId, boolean> {
  const out = { stripe: false, twilio: false, resend: false, ai: false } as Record<ProviderId, boolean>
  for (const spec of Object.values(PROVIDER_SPECS)) {
    const r = resolved[spec.capability]
    out[spec.id] = !!r && r.tenantEnabled && r.packAvailable && r.planAvailable && r.codeInstalled
  }
  return out
}

// ── Change validation ────────────────────────────────────────────────────────

export type ProfileChangeError = { capability: CapabilityId; code: string; message: string }

/**
 * Validate a PROPOSED set of selections against the registry. Rejects the
 * configurations that cannot exist, so an impossible profile is never persisted:
 *
 *   • turning off something that is not tenant-configurable;
 *   • enabling a capability whose hard prerequisite is off (dependency closure);
 *   • disabling a capability that an enabled one hard-depends on (the same rule
 *     from the other side — otherwise you can reach a blocked state by editing
 *     the parent instead of the child);
 *   • touching a capability whose code is not in this build, or that this
 *     product/industry pack does not offer.
 */
export function validateSelections(
  next: Partial<Record<CapabilityId, CapabilitySelection>>,
  opts: { effective: (id: CapabilityId) => CapabilitySelection; packCapabilities?: readonly CapabilityId[] },
): ProfileChangeError[] {
  const errors: ProfileChangeError[] = []
  const after = (id: CapabilityId): CapabilitySelection => next[id] ?? opts.effective(id)

  for (const [rawId, selection] of Object.entries(next)) {
    const id = rawId as CapabilityId
    const c = CAPABILITY_REGISTRY[id]
    if (!c) { errors.push({ capability: id, code: 'unknown_capability', message: `unknown capability "${id}"` }); continue }
    if (!c.tenantConfigurable && selection === 'disabled') {
      errors.push({ capability: id, code: 'capability_mandatory', message: `${c.displayName} is required by the platform and cannot be turned off` })
    }
    if (selection === 'enabled' && !codeInstalled(c)) {
      errors.push({ capability: id, code: 'capability_not_installed', message: `${c.displayName} is not implemented in this build yet` })
    }
    if (selection === 'enabled' && !packOffers(c, opts.packCapabilities)) {
      errors.push({ capability: id, code: 'capability_not_in_pack', message: `${c.displayName} is not offered by this product pack` })
    }
  }

  // Dependency closure, evaluated against the state AFTER the whole patch applies,
  // so enabling a parent and a child in one request is legal.
  for (const c of allCapabilities()) {
    if (after(c.id) !== 'enabled') continue
    const missing = c.dependencies.filter((d) => after(d) !== 'enabled')
    if (missing.length && next[c.id] !== undefined) {
      errors.push({
        capability: c.id,
        code: 'capability_prerequisite_disabled',
        message: `${c.displayName} needs ${missing.map((m) => getCapability(m).displayName).join(', ')} to be on`,
      })
    }
    if (missing.length && next[c.id] === undefined) {
      // The patch turned a prerequisite OFF underneath an already-enabled capability.
      for (const m of missing) {
        errors.push({
          capability: m,
          code: 'capability_required_by',
          message: `${getCapability(m).displayName} cannot be turned off while ${c.displayName} is on`,
        })
      }
    }
  }

  return errors
}
