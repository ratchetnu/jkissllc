import { NextRequest, NextResponse } from 'next/server'
import { createSessionToken, setSessionCookie } from '../_lib/session'

// Rate limiter: max 5 failed attempts per 15 minutes per IP.
// In-memory — resets on cold start, but acceptable for a small admin surface.
const attempts = new Map<string, { count: number; resetAt: number }>()
const MAX_ATTEMPTS = 5
const WINDOW_MS = 15 * 60 * 1000

function getIP(req: NextRequest): string {
  return (
    req.headers.get('x-vercel-forwarded-for')?.split(',')[0].trim() ||
    req.headers.get('x-real-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    'unknown'
  )
}

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = attempts.get(ip)
  if (!entry || now > entry.resetAt) return false
  return entry.count >= MAX_ATTEMPTS
}

function recordFailure(ip: string): void {
  const now = Date.now()
  const entry = attempts.get(ip)
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS })
  } else {
    entry.count++
  }
}

function clearFailures(ip: string): void {
  attempts.delete(ip)
}

export async function POST(req: NextRequest) {
  if (!process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ valid: false, error: 'Admin auth not configured' }, { status: 500 })
  }

  const ip = getIP(req)

  if (isRateLimited(ip)) {
    return NextResponse.json(
      { valid: false, error: 'Too many attempts. Try again in 15 minutes.' },
      { status: 429 },
    )
  }

  const { password } = await req.json()
  if (!password || typeof password !== 'string') {
    return NextResponse.json({ valid: false }, { status: 400 })
  }

  if (password !== process.env.ADMIN_PASSWORD) {
    recordFailure(ip)
    return NextResponse.json({ valid: false }, { status: 401 })
  }

  clearFailures(ip)

  try {
    const token = await createSessionToken()
    const res = NextResponse.json({ valid: true })
    setSessionCookie(res, token)
    return res
  } catch (err) {
    console.error('[admin/auth]', err)
    return NextResponse.json(
      { valid: false, error: 'Server misconfigured (ADMIN_SESSION_SECRET missing).' },
      { status: 500 },
    )
  }
}
