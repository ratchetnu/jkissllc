import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../_lib/session'
import { getUser, saveUser, setUserPassword, deleteUser, toSafeUser } from '../../../../lib/users'
import { isRole } from '../../../../lib/rbac'
import { passwordPolicyError } from '../../../../lib/password'
import { auditAdmin } from '../../../../lib/audit'

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
  const prevRole = user.role
  const prevActive = user.active

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
      await auditAdmin(who, 'user.role_changed', { entity: 'user', entityId: user.id, outcome: 'denied', summary: `Blocked self role change (${prevRole} → ${body.role})`, meta: { from: prevRole, to: body.role } })
      return NextResponse.json({ ok: false, error: "You can't change your own role." }, { status: 400 })
    }
    user.role = body.role
    if (body.role !== 'crew') user.staffId = undefined
  }

  if (body.staffId !== undefined) user.staffId = body.staffId ? String(body.staffId) : undefined

  if (body.active !== undefined) {
    if (editingSelf && body.active === false) {
      await auditAdmin(who, 'user.suspended', { entity: 'user', entityId: user.id, outcome: 'denied', summary: 'Blocked self account suspension' })
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

  // Post-commit, fail-open administrative audit — emit ONLY what actually changed, so
  // an idempotent no-op PATCH records nothing and retries can't duplicate events.
  if (body.role !== undefined && user.role !== prevRole) {
    await auditAdmin(who, 'user.role_changed', { entity: 'user', entityId: user.id, summary: `Changed role ${prevRole} → ${user.role}`, meta: { from: prevRole, to: user.role } })
  }
  if (body.active !== undefined && user.active !== prevActive) {
    await auditAdmin(who, user.active ? 'user.reactivated' : 'user.suspended', { entity: 'user', entityId: user.id, summary: `${user.active ? 'Reactivated' : 'Suspended'} ${user.email}` })
  }
  const updatedFields: string[] = []
  if (typeof body.name === 'string' && body.name.trim()) updatedFields.push('name')
  if (user.email !== prevEmail) updatedFields.push('email')
  if (body.staffId !== undefined) updatedFields.push('staffId')
  if (typeof body.password === 'string' && body.password) updatedFields.push('password')
  if (updatedFields.length) {
    // field NAMES only — never the new email/password VALUES land in the log.
    await auditAdmin(who, 'user.updated', { entity: 'user', entityId: user.id, summary: `Updated ${user.email} (${updatedFields.join(', ')})`, meta: { fields: updatedFields } })
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
