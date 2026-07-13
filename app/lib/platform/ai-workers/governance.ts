// ── AI worker governance ─────────────────────────────────────────────────────
//
// The single authorization decision for any AI worker action. Enforced order
// (fail-closed at each step), and audit metadata is ALWAYS produced — even on a
// denial — so no invocation is unlogged.
//
//   1. Kill switch (global or per-tenant) overrides everything.
//   2. AI workforce must be enabled (flag).
//   3. Worker must be enabled for the tenant.
//   4. Worker may only use DECLARED capabilities and tools.
//   5. The human invoker must hold ALL of the worker's required permissions.
//   6. Level-5 / prohibited actions can NEVER execute.
//   7. Level-3 actions require a recorded approval (cannot auto-execute).

import { can, permissionsForRole, type Permission, type Role } from '../../rbac'
import { isEnabled } from '../flags'
import type { CapabilityId } from '../capabilities/types'
import type { AiWorker } from './types'
import type { AutonomyLevel } from './autonomy'
import { isProhibitedAction, requiresApproval } from './autonomy'

export type WorkerActor = {
  sub: string
  role: Role
  tenantId: string
  permissions?: Permission[] // if omitted, derived from role
}

export type KillSwitch = { global?: boolean; tenants?: string[] }

export type WorkerActionRequest = {
  worker: AiWorker
  actor: WorkerActor
  tenant: { id: string }
  autonomyLevel: AutonomyLevel
  capability?: CapabilityId
  tool?: string
  action?: string
  killSwitch?: KillSwitch
  workforceEnabled?: boolean // test override; defaults to the AI_WORKFORCE_ENABLED flag
}

export type WorkerAuditMeta = {
  workerId: string
  actorSub: string
  actorRole: Role
  tenantId: string
  capability?: CapabilityId
  tool?: string
  action?: string
  autonomyLevel: AutonomyLevel
  decision: 'allow' | 'deny'
  reason: string
}

export type WorkerDecision = {
  allowed: boolean
  requiresApproval: boolean
  prohibited: boolean
  mayAutoExecute: boolean
  reason: string
  audit: WorkerAuditMeta
}

function actorHasPermission(actor: WorkerActor, perm: Permission): boolean {
  if (actor.permissions) return actor.permissions.includes(perm)
  return can(actor.role, perm)
}

export function authorizeWorkerAction(req: WorkerActionRequest): WorkerDecision {
  const { worker, actor, tenant, autonomyLevel, capability, tool, action, killSwitch } = req
  const base = {
    workerId: worker.id, actorSub: actor.sub, actorRole: actor.role, tenantId: tenant.id,
    capability, tool, action, autonomyLevel,
  }
  const deny = (reason: string): WorkerDecision => ({
    allowed: false, requiresApproval: false, prohibited: false, mayAutoExecute: false, reason,
    audit: { ...base, decision: 'deny', reason },
  })

  // 1. Kill switch overrides all permissions.
  if (killSwitch?.global) return deny('kill switch: global AI actions disabled')
  if (killSwitch?.tenants?.includes(tenant.id)) return deny(`kill switch: AI disabled for tenant ${tenant.id}`)

  // 2. Workforce must be enabled.
  const workforceOn = req.workforceEnabled ?? isEnabled('AI_WORKFORCE_ENABLED')
  if (!workforceOn) return deny('AI workforce is disabled (AI_WORKFORCE_ENABLED off)')

  // 3. Tenant enablement.
  if (worker.enabledForTenants === 'none') return deny('worker disabled for all tenants')
  if (Array.isArray(worker.enabledForTenants) && !worker.enabledForTenants.includes(tenant.id)) {
    return deny(`worker not enabled for tenant ${tenant.id}`)
  }

  // 4. Declared capability / tool only.
  if (capability && !worker.allowedCapabilities.includes(capability)) {
    return deny(`worker may not use capability "${capability}"`)
  }
  if (tool && !worker.allowedTools.includes(tool)) {
    return deny(`worker may not use tool "${tool}"`)
  }

  // 5. Human invoker must hold every required permission.
  for (const perm of worker.requiredPermissions) {
    if (!actorHasPermission(actor, perm)) return deny(`invoker lacks required permission "${perm}"`)
  }

  // 6. Prohibited / Level-5 can never execute.
  const prohibited = autonomyLevel === 5 || (!!action && isProhibitedAction(action)) ||
    (!!action && worker.prohibitedActions.includes(action))
  if (prohibited) {
    const reason = `prohibited (Level 5 / restricted action${action ? `: ${action}` : ''}) — never autonomously executed`
    return {
      allowed: false, requiresApproval: false, prohibited: true, mayAutoExecute: false, reason,
      audit: { ...base, decision: 'deny', reason },
    }
  }

  // 7. Authorized. Determine execution gating.
  const needsApproval = autonomyLevel >= worker.approvalRequiredAtOrAbove && requiresApproval(autonomyLevel)
  const mayAutoExecute = !needsApproval && autonomyLevel <= 4
  const reason = needsApproval
    ? 'authorized — requires recorded human approval before execution'
    : 'authorized'
  return {
    allowed: true, requiresApproval: needsApproval, prohibited: false, mayAutoExecute, reason,
    audit: { ...base, decision: 'allow', reason },
  }
}

/** Convenience: the permission set an actor effectively holds (role-derived). */
export function effectivePermissions(actor: WorkerActor): Permission[] {
  return actor.permissions ?? permissionsForRole(actor.role)
}
