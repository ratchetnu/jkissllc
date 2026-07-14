import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../_lib/session'
import { getUser, saveUser, setUserPassword, deleteUser, toSafeUser } from '../../../../lib/users'
import { isRole } from '../../../../lib/rbac'
import { passwordPolicyError } from '../../../../lib/password'

// Update / deactivate / delete a single user login. Admin-only (users:manage);
// changing a role additionally requires roles:manage — both live on admin, so this
// is effectively admin-only, but the checks stay explicit and matrix-driven.

export const PATCH = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const who = await requirePermission(req, 'users:manage')
  if (who instanceof NextResponse) return who
  const { id } = await params

  const user = await getUser(id)
  if (!user) return NextResponse.json({ ok: false, error: 'User not found.' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const prevEmail = user.email

  // Guard against an admin locking themselves out: you can't demote or suspend the
  // account you're currently signed in as.
  const editingSelf = who.sub === user.id

  if (typeof body.name === 'string' && body.name.trim()) user.name = body.name.trim()

  if (typeof body.email === 'string' && body.email.trim()) {
    if (!/.+@.+\..+/.test(body.email.trim())) {
      return NextResponse.json({ ok: false, error: 'A valid email is required.' }, { status: 400 })
    }
    user.email = body.email.trim()
  }

  if (body.role !== undefined) {
    if (!isRole(body.role)) return NextResponse.json({ ok: false, error: 'Invalid role.' }, { status: 400 })
    const rolePerm = await requirePermission(req, 'roles:manage')
    if (rolePerm instanceof NextResponse) return rolePerm
    if (editingSelf && body.role !== 'admin') {
      return NextResponse.json({ ok: false, error: "You can't change your own role." }, { status: 400 })
    }
    user.role = body.role
    if (body.role !== 'crew') user.staffId = undefined
  }

  if (body.staffId !== undefined) user.staffId = body.staffId ? String(body.staffId) : undefined

  if (body.active !== undefined) {
    if (editingSelf && body.active === false) {
      return NextResponse.json({ ok: false, error: "You can't suspend your own account." }, { status: 400 })
    }
    user.active = !!body.active
  }

  await saveUser(user, prevEmail)

  // Optional password reset in the same call.
  if (typeof body.password === 'string' && body.password) {
    const pwErr = passwordPolicyError(body.password)
    if (pwErr) return NextResponse.json({ ok: false, error: pwErr }, { status: 400 })
    await setUserPassword(user.id, body.password)
  }

  const fresh = await getUser(user.id)
  return NextResponse.json({ ok: true, user: fresh ? toSafeUser(fresh) : toSafeUser(user) })
})

export const DELETE = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const who = await requirePermission(req, 'users:manage')
  if (who instanceof NextResponse) return who
  const { id } = await params
  if (who.sub === id) {
    return NextResponse.json({ ok: false, error: "You can't delete your own account." }, { status: 400 })
  }
  await deleteUser(id)
  return NextResponse.json({ ok: true })
})
