import { NextRequest, NextResponse } from 'next/server'
import { getPrincipal } from '../_lib/session'
import { getLastLogin } from '../../../lib/admin-login-log'
import { getUser } from '../../../lib/users'

export async function GET(req: NextRequest) {
  const who = await getPrincipal(req)
  if (!who) return NextResponse.json({ authed: false, lastLogin: null })

  // Per-user Last Login for named accounts; the account-wide signal for the legacy
  // owner. Surface the PREVIOUS login (what "Last Login" means) only to an authed
  // caller — never leak it anonymously.
  let lastLogin: { at: number; device: string | null } | null = null
  let name: string | null = null
  if (who.sub && who.sub !== 'owner') {
    const u = await getUser(who.sub)
    name = u?.name ?? null
    lastLogin = u?.previousLoginAt ? { at: u.previousLoginAt, device: u.previousLoginDevice ?? null } : null
  } else {
    lastLogin = await getLastLogin()
  }

  return NextResponse.json({ authed: true, role: who.role, name, lastLogin })
}
