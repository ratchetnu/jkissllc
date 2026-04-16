import { NextResponse } from 'next/server'
import { clearSessionCookie } from '../_lib/session'

export async function POST() {
  const res = NextResponse.json({ ok: true })
  clearSessionCookie(res)
  return res
}
