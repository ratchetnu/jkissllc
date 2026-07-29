// ── Tenant selection + switching (Wave 6) ────────────────────────────────────
//
// GET  — the organizations the CURRENT caller belongs to. Never a directory: the
//        answer is derived from their own membership index, so a tenant they are not
//        a member of cannot appear, and no tenant id from the request is consulted.
// POST — bind a session to one of them.
//
// Reachable in two states, both of which prove identity first:
//   • a PENDING token (multi-membership login, before a choice) — signed, roleless,
//     refused by getPrincipal, so it can do nothing except complete this step;
//   • a live session (switching organizations mid-visit).
//
// The security property: the submitted tenantId is a NOMINATION, never an
// authorization. It is honoured only after `resolveMembership` confirms, server-side,
// an ACTIVE membership for THIS user in THAT tenant. A tampered id finds no
// membership and is refused with a generic 403 that never reveals whether the tenant
// exists.

import { NextRequest, NextResponse } from 'next/server'
import {
  getPrincipal,
  getPendingUserId,
  createUserSessionToken,
  setSessionCookie,
} from '../../admin/_lib/session'
import {
  listActiveMembershipsForUser,
  resolveMembership,
} from '../../../lib/platform/tenancy/membership'
import { toTenantChoices } from '../../../lib/platform/tenancy/login-resolution'
import { getTenant } from '../../../lib/platform/tenancy/tenant-registry'
import { isEnabled } from '../../../lib/platform/flags'
import { recordTenantEvent } from '../../../lib/platform/observability/tenant-telemetry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The caller's user id from EITHER a pending selection token or a live session. */
async function callerUserId(req: NextRequest): Promise<string | null> {
  const pending = await getPendingUserId(req)
  if (pending) return pending
  const who = await getPrincipal(req)
  // The legacy shared-password owner has no User row and no memberships, so it has
  // nothing to switch between; treat it as not applicable rather than erroring.
  if (!who || who.sub === 'owner') return null
  return who.sub
}

export async function GET(req: NextRequest) {
  const userId = await callerUserId(req)
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const memberships = await listActiveMembershipsForUser(userId)
  return NextResponse.json({ tenants: toTenantChoices(memberships) })
}

export async function POST(req: NextRequest) {
  const userId = await callerUserId(req)
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const requested = typeof body.tenantId === 'string' ? body.tenantId : ''
  if (!requested) return NextResponse.json({ error: 'tenantId required' }, { status: 400 })

  // THE gate. Not "is this a real tenant" — "is this user an active member of it".
  const membership = await resolveMembership(userId, requested)
  if (!membership || membership.status !== 'active') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  if (isEnabled('TENANCY_ENABLED')) {
    const tenant = await getTenant(membership.tenantId)
    if (!tenant || tenant.status === 'suspended') {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
  }

  // A fresh session bound to the chosen tenant. Role and staff link come from the
  // MEMBERSHIP: carrying the previous tenant's role — or its Staff id — across the
  // switch is exactly the cross-tenant leak this endpoint exists to prevent.
  const token = await createUserSessionToken({
    id: userId,
    role: membership.role,
    staffId: membership.staffId,
    tenantId: membership.tenantId,
    membershipId: membership.id,
  })

  // Auditable via tenancy telemetry rather than the Release Center audit log: this
  // event spans two tenants, so it belongs to neither tenant's log, and the platform
  // audit vocabulary is scoped to release actions. Only the membership id and the
  // destination are recorded — never the tenant the caller came FROM, which would put
  // one tenant's identifier into another's trail.
  recordTenantEvent('session-tenant-bound', {
    tenantId: membership.tenantId,
    detail: `membership ${membership.id}`,
  })

  const res = NextResponse.json({
    ok: true,
    tenantId: membership.tenantId,
    role: membership.role,
    redirect: membership.role === 'crew' ? '/portal' : '/admin/operations',
  })
  setSessionCookie(res, token)
  return res
}
