import { NextRequest, NextResponse } from 'next/server'
import { createSessionToken, setSessionCookie } from '../_lib/session'
import { redis } from '../../../lib/redis'
import { recordLogin } from '../../../lib/admin-login-log'

// Failed-login limiter: max 5 failed attempts per 15 minutes per IP.
// Backed by Upstash Redis so the count is shared across all serverless
// instances — an in-memory Map is per-instance and is trivially bypassed by an
// attacker spreading requests across instances or waiting out cold starts.
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

const failKey = (ip: string) => `rl:adminfail:${ip}`

// All three helpers fail open on a Redis error: a cache hiccup must neither
// lock the admin out nor hard-fail the login.
async function isRateLimited(ip: string): Promise<boolean> {
  try {
    const raw = await redis.get(failKey(ip))
    return raw != null && parseInt(raw, 10) >= MAX_ATTEMPTS
  } catch {
    return false
  }
}

async function recordFailure(ip: string): Promise<void> {
  try {
    const count = await redis.incr(failKey(ip))
    if (count === 1) await redis.pexpire(failKey(ip), WINDOW_MS)
  } catch {
    /* best-effort limiter */
  }
}

async function clearFailures(ip: string): Promise<void> {
  try {
    await redis.del(failKey(ip))
  } catch {
    /* best-effort limiter */
  }
}

/**
 * Compare two secrets without leaking anything through timing.
 *
 * A plain `!==` bails at the first differing byte, so response time tracks how many
 * leading characters an attacker guessed correctly. We hash both sides first: the
 * digests are always 32 bytes, so the comparison below is fixed-length and the
 * loop never short-circuits — which also means the PASSWORD'S LENGTH doesn't leak
 * (a plain length check would be its own oracle).
 *
 * The `timingSafeEqual` in _lib/session.ts compares HMAC signatures, which are
 * already fixed-length, so its early length return is fine there and wrong here.
 */
async function secretsMatch(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder()
  const [x, y] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ])
  const ax = new Uint8Array(x)
  const by = new Uint8Array(y)
  let diff = 0
  for (let i = 0; i < ax.length; i++) diff |= ax[i] ^ by[i]
  return diff === 0
}

export async function POST(req: NextRequest) {
  if (!process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ valid: false, error: 'Admin auth not configured' }, { status: 500 })
  }

  const ip = getIP(req)

  if (await isRateLimited(ip)) {
    return NextResponse.json(
      { valid: false, error: 'Too many attempts. Try again in 15 minutes.' },
      { status: 429 },
    )
  }

  const { password } = await req.json()
  if (!password || typeof password !== 'string') {
    return NextResponse.json({ valid: false }, { status: 400 })
  }

  if (!(await secretsMatch(password, process.env.ADMIN_PASSWORD))) {
    await recordFailure(ip)
    return NextResponse.json({ valid: false }, { status: 401 })
  }

  await clearFailures(ip)

  // Stamp the login history for the "Last Login" signal. Best-effort: never let a
  // Redis hiccup block a valid sign-in. Runs only here (real auth), never on refresh.
  try { await recordLogin(req.headers.get('user-agent'), Date.now()) } catch { /* non-fatal */ }

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
