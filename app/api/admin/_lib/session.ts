import { NextRequest, NextResponse } from 'next/server'
import { can, isRole, isStaffRole, type Permission, type Role } from '../../../lib/rbac'

export const COOKIE_NAME = 'jk_admin_session'
const SESSION_TTL_MS = 2 * 60 * 60 * 1000 // 2 hours — absolute cap, never slides
const IDLE_TTL_MS = 10 * 60 * 1000 // 10 minutes of inactivity — slides forward on activity

// OPSPILOT IDENTITY — THE AUTHORIZATION CHOKEPOINT.
// The token now carries a subject: { sub, role, staffId }. `sub` is the user id
// ('owner' for the legacy shared ADMIN_PASSWORD login), `role` drives RBAC (see
// lib/rbac.ts), and `staffId` (crew only) scopes the portal to one person's data.
// Legacy tokens minted before this change carry no sub/role — resolveToken() below
// treats them as the implicit owner admin, so existing admin sessions keep working.
//
// Everything is HMAC-signed, so the payload is tamper-evident: a crew member cannot
// edit `role` to 'admin' without invalidating the signature.
type SessionPayload = {
  iat: number
  exp: number
  idleExp?: number
  sub?: string       // user id, or 'owner' for the legacy shared-password admin
  role?: Role        // absent on legacy tokens → resolves to 'admin'
  staffId?: string   // crew principals only — the Staff record they may read
}

// The resolved caller. Guards return this instead of a bare boolean so every
// authorization decision routes through the RBAC matrix, not inline string checks.
export type Principal = {
  sub: string
  role: Role
  staffId?: string
}

// Turn a live payload into a principal. Legacy tokens (no role) → owner admin.
function toPrincipal(p: SessionPayload): Principal {
  const role: Role = isRole(p.role) ? p.role : 'admin'
  return { sub: p.sub || 'owner', role, staffId: p.staffId }
}

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

// Legacy shared-password admin (the owner). No subject → resolves to owner admin.
export async function createSessionToken(): Promise<string> {
  const now = Date.now()
  return signPayload({ iat: now, exp: now + SESSION_TTL_MS, idleExp: now + IDLE_TTL_MS })
}

// A named user session (manager / crew / additional admin). Carries the identity
// that RBAC and the crew portal scope on.
export async function createUserSessionToken(user: { id: string; role: Role; staffId?: string }): Promise<string> {
  const now = Date.now()
  return signPayload({
    iat: now,
    exp: now + SESSION_TTL_MS,
    idleExp: now + IDLE_TTL_MS,
    sub: user.id,
    role: user.role,
    staffId: user.staffId,
  })
}

export async function verifySessionToken(token: string | undefined | null): Promise<boolean> {
  const p = await parseToken(token)
  return !!p && isLive(p)
}

// The resolved principal for a request, or null if there is no live session.
// Pure crypto (no Redis) so it is safe to call from middleware.
export async function getPrincipal(req: NextRequest): Promise<Principal | null> {
  const token = req.cookies.get(COOKIE_NAME)?.value
  const p = await parseToken(token)
  if (!p || !isLive(p)) return null
  return toPrincipal(p)
}

export async function getPrincipalFromToken(token: string | undefined | null): Promise<Principal | null> {
  const p = await parseToken(token)
  if (!p || !isLive(p)) return null
  return toPrincipal(p)
}

// Given a still-live token, return one with the idle window slid forward (capped
// by the absolute exp). PRESERVES the subject/role/staffId — dropping them here
// would silently re-grant a manager/crew session full owner-admin rights on the
// next request. Returns null if the token is invalid or already lapsed.
export async function slideSessionToken(token: string | undefined | null): Promise<string | null> {
  const p = await parseToken(token)
  if (!p || !isLive(p)) return null
  const idleExp = Math.min(p.exp, Date.now() + IDLE_TTL_MS)
  return signPayload({ iat: p.iat, exp: p.exp, idleExp, sub: p.sub, role: p.role, staffId: p.staffId })
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

// ── Role / permission guards ─────────────────────────────────────────────────
// Return the resolved Principal on success, or a ready-to-return NextResponse on
// failure (401 no session / 403 forbidden). Usage in a route:
//
//   const who = await requirePermission(req, 'users:manage')
//   if (who instanceof NextResponse) return who
//   // ...who.sub / who.role are now trusted
//
// This keeps every route's authz to two lines and funnels the decision through the
// central RBAC matrix — never an inline role-string comparison.

function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
}
function forbidden(): NextResponse {
  return NextResponse.json({ error: 'forbidden' }, { status: 403 })
}

/** Any live session. Returns the principal (use when you only need identity). */
export async function requirePrincipal(req: NextRequest): Promise<Principal | NextResponse> {
  const who = await getPrincipal(req)
  return who ?? unauthorized()
}

/** Admin or manager (the operations surface). Rejects crew. */
export async function requireStaffSession(req: NextRequest): Promise<Principal | NextResponse> {
  const who = await getPrincipal(req)
  if (!who) return unauthorized()
  if (!isStaffRole(who.role)) return forbidden()
  return who
}

/** Admin only. */
export async function requireAdmin(req: NextRequest): Promise<Principal | NextResponse> {
  const who = await getPrincipal(req)
  if (!who) return unauthorized()
  if (who.role !== 'admin') return forbidden()
  return who
}

/** Gate on a specific permission via the RBAC matrix. */
export async function requirePermission(req: NextRequest, permission: Permission): Promise<Principal | NextResponse> {
  const who = await getPrincipal(req)
  if (!who) return unauthorized()
  if (!can(who.role, permission)) return forbidden()
  return who
}
