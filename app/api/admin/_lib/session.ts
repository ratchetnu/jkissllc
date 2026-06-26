import { NextRequest, NextResponse } from 'next/server'

export const COOKIE_NAME = 'jk_admin_session'
const SESSION_TTL_MS = 2 * 60 * 60 * 1000 // 2 hours — absolute cap, never slides
const IDLE_TTL_MS = 10 * 60 * 1000 // 10 minutes of inactivity — slides forward on activity

type SessionPayload = { iat: number; exp: number; idleExp?: number }

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlToBytes(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function getSecret(): string {
  // Dedicated signing secret only — never fall back to ADMIN_PASSWORD. Sharing
  // them would make the login password and the token-signing key one value:
  // rotating the password would silently break sessions, and anyone who
  // learned the password could forge admin session tokens offline.
  const secret = process.env.ADMIN_SESSION_SECRET
  if (!secret || secret.length < 16) {
    throw new Error('ADMIN_SESSION_SECRET missing or too short (min 16 chars).')
  }
  return secret
}

async function hmac(message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(getSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return b64url(sig)
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function signPayload(payload: SessionPayload): Promise<string> {
  const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)))
  const sig = await hmac(payloadB64)
  return `${payloadB64}.${sig}`
}

// Verify the signature and return the payload, or null if tampered/malformed.
async function parseToken(token: string | undefined | null): Promise<SessionPayload | null> {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payloadB64, sig] = parts
  const expected = await hmac(payloadB64)
  if (!timingSafeEqual(sig, expected)) return null
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64))) as SessionPayload
  } catch {
    return null
  }
}

function isLive(p: SessionPayload, now = Date.now()): boolean {
  if (!p.exp || now > p.exp) return false // absolute 2h cap
  if (p.idleExp && now > p.idleExp) return false // idle timeout (legacy tokens w/o idleExp pass until refreshed)
  return true
}

export async function createSessionToken(): Promise<string> {
  const now = Date.now()
  return signPayload({ iat: now, exp: now + SESSION_TTL_MS, idleExp: now + IDLE_TTL_MS })
}

export async function verifySessionToken(token: string | undefined | null): Promise<boolean> {
  const p = await parseToken(token)
  return !!p && isLive(p)
}

// Given a still-live token, return one with the idle window slid forward (capped
// by the absolute exp). Returns null if the token is invalid or already lapsed —
// callers use this in middleware to keep an active admin session alive.
export async function slideSessionToken(token: string | undefined | null): Promise<string | null> {
  const p = await parseToken(token)
  if (!p || !isLive(p)) return null
  const idleExp = Math.min(p.exp, Date.now() + IDLE_TTL_MS)
  return signPayload({ iat: p.iat, exp: p.exp, idleExp })
}

export function setSessionCookie(res: NextResponse, token: string): void {
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  })
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(COOKIE_NAME, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
}

export async function requireSession(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(COOKIE_NAME)?.value
  return verifySessionToken(token)
}
