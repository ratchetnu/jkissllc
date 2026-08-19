import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireCrew } from '../_lib/crew'
import { getStaff, parseStaffAddress, saveStaff } from '../../../lib/staff'
import { getUser } from '../../../lib/users'
import { recordAudit } from '../../../lib/audit'

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
      address: staff.address ?? null,
      onboarding: !!staff.onboarding,
    },
    lastLogin,
  })
})

// Crew may update only their own mailing address. The target id always comes from
// the signed session; any id/staffId in the request body is deliberately ignored.
export const PATCH = withTenantRoute(async (req: NextRequest) => {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who
  const staff = await getStaff(who.staffId)
  if (!staff) return NextResponse.json({ error: 'not_a_crew_account' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  if (!Object.prototype.hasOwnProperty.call(body, 'address')) {
    return NextResponse.json({ error: 'Address is required.' }, { status: 400 })
  }
  const parsed = parseStaffAddress(body.address)
  if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const changed = JSON.stringify(staff.address) !== JSON.stringify(parsed.address)
  staff.address = parsed.address
  staff.w9 = { ...(staff.w9 ?? { status: 'not_collected' }), addressComplete: !!parsed.address }
  await saveStaff(staff)
  if (changed) {
    await recordAudit({
      actor: who.sub, actorRole: who.role, action: 'staff.address_updated',
      entity: 'crew', entityId: who.staffId,
      summary: `${staff.name} ${parsed.address ? 'updated' : 'cleared'} their mailing address.`,
      meta: { via: 'crew_portal' },
    })
  }
  return NextResponse.json({ ok: true, address: staff.address ?? null })
})
