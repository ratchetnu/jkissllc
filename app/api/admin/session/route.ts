import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../_lib/session'
import { getLastLogin } from '../../../lib/admin-login-log'

export async function GET(req: NextRequest) {
  const authed = await requireSession(req)
  // Surface the previous login (what "Last Login" shows) only to an authed session —
  // never leak it to an anonymous caller.
  const lastLogin = authed ? await getLastLogin() : null
  return NextResponse.json({ authed, lastLogin })
}
