// ── Target deployment evidence — validation + applicability (PURE) ───────────
//
// Two jobs, both pure so they are hermetically testable:
//
//   1. VALIDATE the value-free capability snapshot a managed target returns
//      through the signed callback. Strict, bounded, and actively hostile to
//      anything shaped like a secret.
//   2. DECIDE what an update means for a target given that snapshot — the rule
//      that keeps a core update installable on a business that runs no optional
//      integrations at all.
//
// ── Why the validator is paranoid ────────────────────────────────────────────
//
// This is the ONE channel where a managed target sends structured data back into
// the control plane. J KISS and Supercharged deliberately share no storage and no
// secrets; a target that could put an environment VALUE in this payload would
// quietly undo that, and the value would then live in Operion's Redis and in every
// screen that renders the evidence. So the validator does not merely truncate:
// it REFUSES a field that carries the shape of a credential, and drops the entry.

import type {
  PlatformUpdate, TargetCapabilityEvidence, TargetDeploymentEvidence, UpdateActivationRequirement,
} from '../updates/types'

// ── 1. Validation ────────────────────────────────────────────────────────────

const MAX_CAPABILITIES = 100
const MAX_MISSING_VARS = 12
/** Capability ids, state codes and variable names are all short slugs. */
const SLUG_RE = /^[a-z][a-z0-9_-]{0,63}$/
const VAR_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}(?: \+ [A-Z][A-Z0-9_]{0,63})*(?: \(or [A-Z][A-Z0-9_]{0,63}\))?$/
const COMMIT_RE = /^[0-9a-f]{7,40}$/i
/** A build id / version is an identifier, not free text. */
const IDENT_RE = /^[A-Za-z0-9._-]{1,80}$/

export type EvidenceValidation =
  | { ok: true; value: TargetDeploymentEvidence; warnings: string[] }
  | { ok: false; reason: string }

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v.trim() : undefined)

/**
 * Validate the `capabilityEvidence` object from a callback payload.
 *
 * `recordedAt` is supplied by the CALLER from our own clock — deliberately not read
 * from the payload. A target's clock is advisory: accepting it as the record time
 * would let a target backdate or postdate its own evidence.
 */
export function validateTargetEvidence(raw: unknown, recordedAt: number): EvidenceValidation {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'evidence is not an object' }
  const o = raw as Record<string, unknown>
  const warnings: string[] = []

  const commit = str(o.commit)
  if (commit && !COMMIT_RE.test(commit)) return { ok: false, reason: 'commit is not a commit sha' }
  const buildId = str(o.buildId)
  if (buildId && !IDENT_RE.test(buildId)) return { ok: false, reason: 'buildId is not an identifier' }
  const version = str(o.version)
  if (version && !IDENT_RE.test(version)) return { ok: false, reason: 'version is not an identifier' }

  const rawCaps = Array.isArray(o.capabilities) ? o.capabilities : null
  if (!rawCaps) return { ok: false, reason: 'capabilities must be an array' }
  if (rawCaps.length > MAX_CAPABILITIES) return { ok: false, reason: 'too many capability entries' }

  const capabilities: TargetCapabilityEvidence[] = []
  const seen = new Set<string>()
  for (const entry of rawCaps) {
    if (!entry || typeof entry !== 'object') { warnings.push('dropped a malformed capability entry'); continue }
    const e = entry as Record<string, unknown>
    const capability = str(e.capability)
    const state = str(e.state)
    if (!capability || !SLUG_RE.test(capability)) { warnings.push('dropped an entry with a non-slug capability id'); continue }
    if (!state || !SLUG_RE.test(state)) { warnings.push(`dropped "${capability}": state is not a stable code`); continue }
    if (seen.has(capability)) { warnings.push(`dropped a duplicate entry for "${capability}"`); continue }
    if (typeof e.enabled !== 'boolean') { warnings.push(`dropped "${capability}": enabled is not a boolean`); continue }
    if (e.configured !== null && typeof e.configured !== 'boolean') { warnings.push(`dropped "${capability}": configured must be a boolean or null`); continue }

    // Variable NAMES only. Anything that does not look like an env var name is
    // refused outright — a truncated secret is still a secret.
    let missingVars: string[] | undefined
    if (e.missingVars !== undefined) {
      if (!Array.isArray(e.missingVars)) { warnings.push(`dropped "${capability}": missingVars is not an array`); continue }
      if (e.missingVars.length > MAX_MISSING_VARS) { warnings.push(`dropped "${capability}": too many missingVars`); continue }
      const names = e.missingVars.map(str).filter((v): v is string => !!v)
      const bad = names.find((n) => !VAR_NAME_RE.test(n))
      if (bad !== undefined) { warnings.push(`dropped "${capability}": missingVars carried something that is not a variable name`); continue }
      missingVars = names
    }

    seen.add(capability)
    capabilities.push({ capability, state, enabled: e.enabled, configured: e.configured as boolean | null, missingVars })
  }

  const reportedAt = typeof o.reportedAt === 'number' && Number.isFinite(o.reportedAt) ? o.reportedAt : undefined
  const capabilityProfileVersion = typeof o.capabilityProfileVersion === 'number' && Number.isFinite(o.capabilityProfileVersion)
    ? o.capabilityProfileVersion : undefined

  return {
    ok: true,
    warnings,
    value: {
      commit, buildId, version, capabilityProfileVersion, capabilities,
      reportedAt,
      recordedAt,          // OUR clock, always
      authentication: 'hmac-sha256',
    },
  }
}

// ── 2. Applicability ─────────────────────────────────────────────────────────

export type UpdateApplicability = {
  /**
   * ALWAYS true. There is no path through this function that returns "do not
   * install". Installation is gated by code dependencies and deployment
   * requirements — never by which optional channels a business has switched on.
   */
  installs: true
  /** Installed, but with nothing switched on to exercise it yet. */
  dormant: boolean
  affectedCapabilities: string[]
  /** What the owner must do for the shipped behavior to become live. */
  activationRequirements: UpdateActivationRequirement[]
  /** Capability CODE the target is missing. THIS may legitimately block a transfer. */
  missingCapabilityCode: string[]
  /** One plain sentence for the owner review screen. */
  rationale: string
}

/**
 * What an update means for a target, given the target's own capability evidence.
 *
 * The rule this encodes, stated once: a shared or core update is applicable to
 * every compatible target, full stop. An optional capability being disabled makes
 * an update DORMANT, never NOT APPLICABLE — the two look similar on a dashboard and
 * mean opposite things operationally. "Not applicable" removes a target from the
 * rollout, so a security fix in shared code would silently skip the very business
 * that most needed it, and nobody would see a gap.
 */
export function evaluateCapabilityImpact(
  update: Pick<PlatformUpdate, 'scope' | 'type' | 'capabilityImpact'>,
  evidence: TargetDeploymentEvidence | null | undefined,
): UpdateApplicability {
  const impact = update.capabilityImpact ?? {}
  const affects = impact.affects ?? []
  const byId = new Map((evidence?.capabilities ?? []).map((c) => [c.capability, c]))

  // A capability whose CODE the target lacks is a genuine transfer dependency —
  // the same class as requiredModules, and the one thing here that may block.
  const missingCapabilityCode = (impact.requiresCapabilityCode ?? []).filter((id) => {
    const c = byId.get(id)
    // Absent from the report is NOT evidence of absence: an older target that does
    // not report capabilities must not be judged to be missing all of them.
    if (!c) return false
    return c.state === 'capability_not_installed'
  })

  // Activation requirements come from the update, and are enriched with what the
  // target actually reports so the owner sees the real remaining step.
  const activationRequirements: UpdateActivationRequirement[] = [...(impact.activationRequirements ?? [])]
  for (const id of affects) {
    const c = byId.get(id)
    if (!c) continue
    if (!c.enabled) {
      activationRequirements.push({ capability: id, kind: 'tenant_enable', detail: `${id} is switched off on this target — the code installs and stays dormant until it is enabled` })
    } else if (c.configured === false) {
      for (const name of c.missingVars ?? []) {
        activationRequirements.push({ capability: id, kind: 'provider_credential', reference: name, detail: `${id} is enabled but still needs ${name}` })
      }
    }
  }

  // Dormant only when the update touches optional capability code EXCLUSIVELY and
  // every capability it touches is off on this target. A core or shared-module
  // update is never dormant, whatever the optional channels say.
  const isSharedOrCore = update.scope === 'platform_core' || update.scope === 'shared_module'
  const everyAffectedOff = affects.length > 0 && affects.every((id) => byId.get(id)?.enabled === false)
  const dormant = !isSharedOrCore && impact.optionalOnly === true && everyAffectedOff

  return {
    installs: true,
    dormant,
    affectedCapabilities: affects,
    activationRequirements,
    missingCapabilityCode,
    rationale: missingCapabilityCode.length
      ? `This target is missing the code for ${missingCapabilityCode.join(', ')} — send that first.`
      : dormant
        ? 'Installs now and stays dormant: every optional feature it touches is switched off on this target. Turning one on later needs no redeployment.'
        : isSharedOrCore
          ? 'Core/shared change — applies to this target regardless of which optional features it uses.'
          : activationRequirements.length
            ? 'Installs now; some of the new behavior stays off until the steps below are done.'
            : 'Applies to this target and is live on arrival.',
  }
}
