import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireCrew } from '../_lib/crew'
import { getStaff } from '../../../lib/staff'
import { getUser } from '../../../lib/users'

// The signed-in crew member's own identity + profile. Nothing here is another
// person's data: staff is fetched by the token's staffId, user by its sub.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who

  const [staff, user] = await Promise.all([getStaff(who.staffId), getUser(who.sub)])
  if (!staff) {
    // Login is valid but the crew record was removed — treat as no access.
    return NextResponse.json({ error: 'not_a_crew_account' }, { status: 403 })
  }

  const lastLogin = user?.previousLoginAt
    ? { at: user.previousLoginAt, device: user.previousLoginDevice ?? null }
    : null

  return NextResponse.json({
    ok: true,
    crew: {
      id: staff.id,
      name: staff.name,
      email: staff.email ?? user?.email ?? null,
      phone: staff.phone ?? null,
      role: staff.role ?? null,
      photoUrl: staff.photoUrl ?? null,
      onboarding: !!staff.onboarding,
    },
    lastLogin,
  })
})
