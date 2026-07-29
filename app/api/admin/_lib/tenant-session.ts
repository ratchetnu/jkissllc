// ── Membership-revalidating session guard (Wave 6) ───────────────────────────
//
// `session.ts` stays PURE CRYPTO on purpose — it is called from middleware on the
// Edge runtime, so it must never import the Redis client. That makes it structurally
// unable to answer "is this session's membership still active?", because a signed
// token keeps asserting whatever was true when it was minted.
//
// This module is the store-backed half. It is a separate file precisely so the
// Edge-safety of session.ts is preserved; anything importing THIS is a Node route.
//
// What it rejects that a signature check cannot:
//   • a membership that was suspended or deleted after the token was issued
//   • a role that was changed in the membership after the token was issued
//     (the token's role claim is stale and must not out-rank the store)
//   • a tenant that was deleted or suspended
//   • a forged/foreign tenant id — the membership lookup is by (user, tenant), so a
//     tampered `tid` simply finds no membership (and the signature would break first)
//
// The legacy shared-password owner (`sub === 'owner'`) is deliberately exempt from
// the membership requirement: it has no User row by design (see users.ts), and
// gating it here would lock the only Production administrator out of their own
// system the moment tenancy is enabled. Its authority is unchanged and still
// bounded by requirePlatformOwner / requireAdmin.

import { NextRequest, NextResponse } from 'next/server'
import { getPrincipal, type Principal } from './session'
import { resolveMembership } from '../../../lib/platform/tenancy/membership'
import { getTenant } from '../../../lib/platform/tenancy/tenant-registry'
import { isEnabled } from '../../../lib/platform/flags'

function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
}
function forbidden(): NextResponse {
  // Deliberately generic: never name the tenant or say whether it exists.
  return NextResponse.json({ error: 'forbidden' }, { status: 403 })
}

export type MemberPrincipal = Principal & { membershipVerified: boolean }

/**
 * A live session whose tenant membership is re-checked against the store on THIS
 * request. Returns the principal with the role taken from the MEMBERSHIP (the store
 * wins over the token claim), or a ready-to-return 401/403.
 */
export async function requireMemberSession(req: NextRequest): Promise<MemberPrincipal | NextResponse> {
  const who = await getPrincipal(req)
  if (!who) return unauthorized()

  // Legacy owner — no User row, no membership. Unchanged authority.
  if (who.sub === 'owner') return { ...who, membershipVerified: false }

  const membership = await resolveMembership(who.sub, who.tenantId)
  if (!membership) return forbidden()

  // A tenant that has been deleted or suspended cannot be acted in. Only meaningful
  // once tenancy is on; while off there is exactly one tenant and no registry record
  // is required for continuity.
  if (isEnabled('TENANCY_ENABLED')) {
    const tenant = await getTenant(membership.tenantId)
    if (!tenant || tenant.status === 'suspended') return forbidden()
  }

  // The STORE is authoritative for role. A token minted before a demotion must not
  // keep its old authority for the rest of its 2-hour life.
  return {
    ...who,
    role: membership.role,
    staffId: membership.staffId ?? who.staffId,
    membershipId: membership.id,
    membershipVerified: true,
  }
}
