import { NextRequest, NextResponse } from 'next/server'
import { createUserSessionToken, createTenantSelectionToken, setSessionCookie } from '../../admin/_lib/session'
import { listActiveMembershipsForUser } from '../../../lib/platform/tenancy/membership'
import { resolveLogin, toTenantChoices } from '../../../lib/platform/tenancy/login-resolution'
import { isEnabled } from '../../../lib/platform/flags'
import { getUserByEmail, recordUserLogin, normalizeEmail } from '../../../lib/users'
import { verifyPassword } from '../../../lib/password'
import { parseDevice } from '../../../lib/admin-login-log'
import { redis } from '../../../lib/redis'

// Email + password login for named user accounts (admin / manager / crew). The
// legacy owner still signs in through /api/admin/auth with the shared password.
// Same signed cookie (COOKIE_NAME) is used for every role; the token's `role`
// claim — not the endpoint — is what authorization keys on.

const MAX_ATTEMPTS = 8
const WINDOW_MS = 15 * 60 * 1000

function getIP(req: NextRequest): string {
  return (
    req.headers.get('x-vercel-forwarded-for')?.split(',')[0].trim() ||
    req.headers.get('x-real-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    'unknown'
  )
}

// Limit on IP + email so one attacker can't lock out every account from one IP,
// and can't spray one account from many requests behind a shared IP.
const failKey = (ip: string, email: string) => `rl:userfail:${ip}:${email}`

async function isRateLimited(key: string): Promise<boolean> {
  try {
    const raw = await redis.get(key)
    return raw != null && parseInt(raw, 10) >= MAX_ATTEMPTS
  } catch {
    return false
  }
}
async function recordFailure(key: string): Promise<void> {
  try {
    const count = await redis.incr(key)
    if (count === 1) await redis.pexpire(key, WINDOW_MS)
  } catch { /* best-effort */ }
}
async function clearFailures(key: string): Promise<void> {
  try { await redis.del(key) } catch { /* best-effort */ }
}

export async function POST(req: NextRequest) {
  const ip = getIP(req)
  const body = await req.json().catch(() => ({}))
  const email = normalizeEmail(String(body?.email ?? ''))
  const password = String(body?.password ?? '')

  if (!email || !password) {
    return NextResponse.json({ ok: false, error: 'Email and password are required.' }, { status: 400 })
  }

  const rlKey = failKey(ip, email)
  if (await isRateLimited(rlKey)) {
    return NextResponse.json({ ok: false, error: 'Too many attempts. Try again in 15 minutes.' }, { status: 429 })
  }

  const user = await getUserByEmail(email)
  // Always run a verify to keep timing uniform whether or not the account exists.
  const ok = user
    ? await verifyPassword(password, user.passwordHash)
    : await verifyPassword(password, 'pbkdf2$210000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')

  if (!user || !ok) {
    await recordFailure(rlKey)
    return NextResponse.json({ ok: false, error: 'Incorrect email or password.' }, { status: 401 })
  }

  if (!user.active) {
    return NextResponse.json({ ok: false, error: 'This account is suspended. Contact your administrator.' }, { status: 403 })
  }

  await clearFailures(rlKey)

  // Per-user Last Login — real auth only, never on refresh. Best-effort.
  const device = parseDevice(req.headers.get('user-agent'))
  try { await recordUserLogin(user.id, Date.now(), device) } catch { /* non-fatal */ }

  try {
    // ── Wave 6: the session's tenant comes from a VALIDATED MEMBERSHIP ─────────
    // Note what is absent: nothing here reads a tenant id from the request. A
    // forged `tenantId` in the body is not rejected so much as never consulted.
    const memberships = await listActiveMembershipsForUser(user.id)
    const decision = resolveLogin(
      memberships,
      { id: user.id, role: user.role, staffId: user.staffId },
      { tenancyEnabled: isEnabled('TENANCY_ENABLED') },
    )

    if (decision.kind === 'no-membership') {
      // Authenticated but belongs to no tenant. A controlled state — and NOT a
      // credential hint: the password was already verified to reach here.
      return NextResponse.json(
        { ok: false, error: 'This account is not assigned to an organization. Contact your administrator.', code: 'NO_MEMBERSHIP' },
        { status: 403 },
      )
    }

    if (decision.kind === 'select') {
      // Several tenants — the user chooses. The cookie set here is a PENDING token:
      // signed, short-lived, carries no role, and `getPrincipal` refuses it, so it
      // unlocks POST /api/auth/tenant and nothing else.
      const pending = await createTenantSelectionToken(user.id)
      const res = NextResponse.json({
        ok: true,
        needsTenantSelection: true,
        tenants: toTenantChoices(decision.choices),
        redirect: '/login/organization',
      })
      setSessionCookie(res, pending)
      return res
    }

    // Exactly one active membership → straight in.
    const m = decision.membership
    const token = await createUserSessionToken({
      id: user.id,
      role: m.role,                       // the MEMBERSHIP's role, not the global one
      staffId: m.staffId ?? user.staffId, // tenant-specific roster link when present
      tenantId: m.tenantId,
      membershipId: m.id,
    })
    const res = NextResponse.json({
      ok: true,
      role: m.role,
      tenantId: m.tenantId,
      // Where the client should land after login.
      redirect: m.role === 'crew' ? '/portal' : '/admin/operations',
    })
    setSessionCookie(res, token)
    return res
  } catch (err) {
    console.error('[auth/login]', err)
    return NextResponse.json({ ok: false, error: 'Server misconfigured (session secret missing).' }, { status: 500 })
  }
}
