// ── Operion managed-target transfer boundary policy (PURE, server-authoritative) ─
//
// The single source of truth for WHICH repository paths may be transferred into WHICH
// kind of business. It exists so a managed target (e.g. Supercharged) can NEVER receive
// Operion control-plane code — even if an update is mislabeled or its source commit
// happens to contain forbidden files. Enforcement is by PATH + resolved business ROLE,
// never by a label. No I/O; fully testable; safe to mirror into the CI apply runner.
//
// Roles (from PlatformBusiness.role):
//   • 'source' / 'source_and_target'  → the CONTROL PLANE (J KISS). May retain control-plane files.
//   • 'target'                        → a MANAGED TARGET. Must reject control-plane paths.
//   • undefined/unknown               → FAIL CLOSED (no cross-repository transfer permitted).

import type { BusinessRole } from '../updates/types'

/** Bump when the policy's wire contract changes. A manifest stamped with an unsupported
 *  version must not be used for a new cross-repository automated transfer. */
export const TARGET_POLICY_VERSION = 1
export const SUPPORTED_POLICY_VERSIONS: readonly number[] = [1]

/** Additive product vocabulary (typed; no broad migration performed here). */
export type ComponentClass =
  | 'operion_control_plane'
  | 'operion_business_runtime'
  | 'industry_pack'
  | 'business_specific'

/** Structured, non-secret blocker reasons — safe to surface in the Release Center. */
export type TransferBlockerCode =
  | 'CONTROL_PLANE_PATH_FORBIDDEN'
  | 'TARGET_CONTEXT_REQUIRED'
  | 'COMPONENT_EXCLUDED'
  | 'MANIFEST_POLICY_VERSION_UNSUPPORTED'

// Control-plane-only path families. Segment-prefix matched (NOT substring), so
// `app/lib/platform/release-notes/…` is NOT caught by `app/lib/platform/release`.
//
// REQUIRED MINIMUM (Stage 2A objective):
//   app/admin/operations/release  app/api/admin/release
//   app/lib/platform/release      app/lib/platform/automation
// ADDITIONAL — demonstrably control-plane-only, and NOT part of the minimal
// signed-callback / workflow / apply integration a managed target needs (that
// integration is `scripts/operion-apply.mjs` + `.github/workflows/operion-update.yml`,
// both OUTSIDE `app/**`, so untouched by this list):
//   app/api/automation      (M2M callback/manifest endpoints — hosted by the control plane)
//   app/lib/platform/updates (Operion update-center system-of-record)
//   app/lib/platform/sync    (control-plane reconciliation)
export const CONTROL_PLANE_PATH_PREFIXES: readonly string[] = [
  'app/admin/operations/release',
  'app/api/admin/release',
  'app/lib/platform/release',
  'app/lib/platform/automation',
  'app/api/automation',
  'app/lib/platform/updates',
  'app/lib/platform/sync',
]

function toSegments(p: string): string[] {
  return String(p).split('/').filter(Boolean)
}
/** True when `pathSegs` begins with every segment of `prefixSegs` (segment-aware). */
function hasSegmentPrefix(pathSegs: string[], prefixSegs: string[]): boolean {
  if (pathSegs.length < prefixSegs.length) return false
  for (let i = 0; i < prefixSegs.length; i++) if (pathSegs[i] !== prefixSegs[i]) return false
  return true
}

const CONTROL_PLANE_SEGS = CONTROL_PLANE_PATH_PREFIXES.map(toSegments)

/** Is this repo-relative path part of an Operion control-plane family? Segment-aware. */
export function isControlPlanePath(path: string): boolean {
  const segs = toSegments(path)
  return CONTROL_PLANE_SEGS.some(pre => hasSegmentPrefix(segs, pre))
}

/** Best-effort component classification. Only the control-plane distinction is
 *  enforcement-relevant; the other classes are reserved (additive, no migration). */
export function classifyComponent(path: string): ComponentClass {
  return isControlPlanePath(path) ? 'operion_control_plane' : 'operion_business_runtime'
}

export const KNOWN_ROLES: readonly BusinessRole[] = ['source', 'target', 'source_and_target']
export function isManagedTargetRole(role?: BusinessRole): boolean {
  return role === 'target'
}

/** Server-resolved target context. NEVER populated from browser input — the caller
 *  resolves role/edition/exclusions from the registered business/compat records. */
export type TargetContext = {
  businessId?: string
  role?: BusinessRole
  edition?: string
  componentsToExclude?: string[]
}
/** Provenance stamped onto a manifest (informational + runner defense-in-depth). */
export type ManifestTargetMeta = { businessId: string; role: BusinessRole; edition?: string }

export type TransferViolation = { path: string; code: TransferBlockerCode; message: string }
export type TransferEvaluation = { ok: boolean; role: BusinessRole | 'unknown'; violations: TransferViolation[] }

// componentsToExclude semantics:
//   • Each entry is a repo-relative path: an exact file, a directory prefix, or `dir/**`.
//   • Matching is segment-aware (a directory prefix matches the dir and everything under it).
//   • An entry containing a wildcard other than a trailing `/**`, any `..`, an absolute/home
//     prefix, a backslash, or a NUL is UNSAFE → it fails the whole transfer closed
//     (COMPONENT_EXCLUDED) rather than being silently ignored.
//   • If any manifest path matches an exclusion, the WHOLE manifest is rejected
//     (COMPONENT_EXCLUDED) — we never silently drop a file and transfer the rest.
type ParsedExclusion = { segs: string[] } | { invalid: true; raw: string }
function parseExclusion(raw: unknown): ParsedExclusion {
  if (typeof raw !== 'string') return { invalid: true, raw: String(raw) }
  let pat = raw.trim()
  if (pat.endsWith('/**')) pat = pat.slice(0, -3)
  if (
    !pat || pat.includes('*') || pat.includes('..') || pat.startsWith('/') ||
    pat.startsWith('~') || /^[A-Za-z]:/.test(pat) || pat.includes('\\') || pat.includes('\0')
  ) return { invalid: true, raw }
  const segs = toSegments(pat)
  if (!segs.length || segs.some(s => s === '.' || s === '..')) return { invalid: true, raw }
  return { segs }
}

/** Evaluate a set of repo-relative paths against a resolved target context. Fails closed. */
export function evaluateTransfer(paths: string[], ctx: TargetContext): TransferEvaluation {
  // Fail closed when the target role/context is missing or not a known role.
  if (!ctx || !KNOWN_ROLES.includes(ctx.role as BusinessRole)) {
    return {
      ok: false,
      role: 'unknown',
      violations: [{ path: '(target-context)', code: 'TARGET_CONTEXT_REQUIRED', message: 'a resolved target business role is required for a cross-repository transfer' }],
    }
  }
  const violations: TransferViolation[] = []
  const managed = isManagedTargetRole(ctx.role)

  // Parse exclusions once; any unsafe pattern fails the transfer closed.
  const parsed = (ctx.componentsToExclude ?? []).map(parseExclusion)
  for (const p of parsed) {
    if ('invalid' in p) {
      violations.push({ path: `(exclusion:${p.raw})`, code: 'COMPONENT_EXCLUDED', message: `invalid or unsafe componentsToExclude pattern: ${p.raw}` })
    }
  }
  const validExclusions = parsed.filter((p): p is { segs: string[] } => !('invalid' in p))

  for (const path of paths) {
    const segs = toSegments(path)
    if (managed && isControlPlanePath(path)) {
      violations.push({ path, code: 'CONTROL_PLANE_PATH_FORBIDDEN', message: `control-plane path may not be transferred to a managed target: ${path}` })
    }
    for (const ex of validExclusions) {
      if (hasSegmentPrefix(segs, ex.segs)) {
        violations.push({ path, code: 'COMPONENT_EXCLUDED', message: `path is excluded by componentsToExclude: ${path}` })
        break
      }
    }
  }
  // ctx.role is guaranteed to be a known BusinessRole by the guard above.
  return { ok: violations.length === 0, role: ctx.role as BusinessRole, violations }
}

/** Full manifest-level enforcement: policy version + target-aware paths. Fails closed.
 *  `requirePolicyVersion` is set by cross-repository callers (manifest delivery, CI runner)
 *  so a legacy manifest lacking target identity/version cannot drive a new transfer. */
export function enforceManifestPolicy(input: {
  paths: string[]
  policyVersion?: number
  target: TargetContext
  requirePolicyVersion?: boolean
}): TransferEvaluation {
  const { paths, policyVersion, target, requirePolicyVersion } = input
  const role: BusinessRole | 'unknown' = target?.role ?? 'unknown'
  if (policyVersion !== undefined && !SUPPORTED_POLICY_VERSIONS.includes(policyVersion)) {
    return { ok: false, role, violations: [{ path: '(policy)', code: 'MANIFEST_POLICY_VERSION_UNSUPPORTED', message: `unsupported manifest policy version: ${policyVersion}` }] }
  }
  if (requirePolicyVersion && policyVersion === undefined) {
    return { ok: false, role, violations: [{ path: '(policy)', code: 'MANIFEST_POLICY_VERSION_UNSUPPORTED', message: 'manifest is missing a policy version and cannot be used for a new cross-repository transfer' }] }
  }
  return evaluateTransfer(paths, target)
}
