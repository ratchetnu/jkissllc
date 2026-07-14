import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireCrew } from '../_lib/crew'
import { getUser, setUserPassword } from '../../../lib/users'
import { verifyPassword, passwordPolicyError } from '../../../lib/password'

// Crew changes their OWN password. Requires the current password (so a borrowed,
// still-open session can't silently reset it). Never touches pay, rates, or role.
export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who

  const body = await req.json().catch(() => ({}))
  const current = String(body?.current ?? '')
  const next = String(body?.next ?? '')

  const user = await getUser(who.sub)
  if (!user) return NextResponse.json({ ok: false, error: 'Account not found.' }, { status: 404 })

  if (!(await verifyPassword(current, user.passwordHash))) {
    return NextResponse.json({ ok: false, error: 'Current password is incorrect.' }, { status: 400 })
  }
  const pwErr = passwordPolicyError(next)
  if (pwErr) return NextResponse.json({ ok: false, error: pwErr }, { status: 400 })

  await setUserPassword(user.id, next)
  return NextResponse.json({ ok: true })
})
