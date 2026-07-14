import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import { createUser, listUsers, toSafeUser } from '../../../lib/users'
import { getStaff } from '../../../lib/staff'
import { isRole } from '../../../lib/rbac'
import { passwordPolicyError } from '../../../lib/password'

// Team & Access — manage the manager and crew logins. Admin-only end to end
// (users:manage). Passwords are hashed in createUser; the hash never leaves here.

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'users:manage')
  if (who instanceof NextResponse) return who
  const users = await listUsers()
  return NextResponse.json({ ok: true, users: users.map(toSafeUser) })
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'users:manage')
  if (who instanceof NextResponse) return who

  const body = await req.json().catch(() => ({}))
  const email = String(body?.email ?? '').trim()
  const name = String(body?.name ?? '').trim()
  const role = body?.role
  const password = String(body?.password ?? '')
  const staffId = body?.staffId ? String(body.staffId) : undefined

  if (!email || !/.+@.+\..+/.test(email)) {
    return NextResponse.json({ ok: false, error: 'A valid email is required.' }, { status: 400 })
  }
  if (!isRole(role)) {
    return NextResponse.json({ ok: false, error: 'Invalid role.' }, { status: 400 })
  }
  const pwErr = passwordPolicyError(password)
  if (pwErr) return NextResponse.json({ ok: false, error: pwErr }, { status: 400 })

  // A crew login must be tied to a real Staff record so the portal can scope its
  // data. Managers/admins carry no staffId.
  if (role === 'crew') {
    if (!staffId) return NextResponse.json({ ok: false, error: 'Select the crew member this login belongs to.' }, { status: 400 })
    const staff = await getStaff(staffId)
    if (!staff) return NextResponse.json({ ok: false, error: 'That crew member no longer exists.' }, { status: 400 })
  }

  try {
    const user = await createUser({
      email, name: name || email, role,
      password,
      staffId: role === 'crew' ? staffId : undefined,
      invitedBy: who.sub,
    })
    return NextResponse.json({ ok: true, user: toSafeUser(user) })
  } catch (err) {
    if (err instanceof Error && err.message === 'EMAIL_TAKEN') {
      return NextResponse.json({ ok: false, error: 'That email is already in use.' }, { status: 409 })
    }
    console.error('[admin/users POST]', err)
    return NextResponse.json({ ok: false, error: 'Could not create the account.' }, { status: 500 })
  }
})
