import { redis } from './redis'
import { hashPassword } from './password'
import type { Role } from './rbac'

// OpsPilot user accounts — the per-person identity layer that RBAC and the Crew
// Portal sit on. Distinct from `Staff` (the operational crew roster): a crew User
// *links to* a Staff record via `staffId`, so the portal scopes every query to
// that one person's operational data. Admins and managers are Users with no
// staffId (they don't appear on routes).
//
// The legacy shared-password owner is NOT a User row — it authenticates via
// ADMIN_PASSWORD and is treated as an implicit admin principal (see session.ts).
// Everyone else (managers, crew, and any additional named admins) is a User here.

export type User = {
  id: string
  email: string            // normalized lowercase; unique; the login identifier
  name: string
  role: Role
  passwordHash: string     // pbkdf2$... (see lib/password.ts) — never returned to clients
  staffId?: string         // crew: link to the Staff roster record (own-data scope)
  active: boolean          // false = suspended; cannot sign in

  // Per-user Last Login (replaces the account-wide signal for real accounts).
  // Stamped ONLY on a successful authentication, never on refresh.
  currentLoginAt?: number
  currentLoginDevice?: string | null
  previousLoginAt?: number
  previousLoginDevice?: string | null

  invitedBy?: string       // userId or 'owner' of whoever created this account
  createdAt: number
  updatedAt: number
}

// Public shape — the hash never crosses the wire.
export type SafeUser = Omit<User, 'passwordHash'>

const KEY = (id: string) => `user:${id}`
const INDEX = 'user:index'
const EMAIL_KEY = (email: string) => `user:email:${normalizeEmail(email)}`

export function normalizeEmail(email: string): string {
  return (email || '').trim().toLowerCase()
}

export function toSafeUser(u: User): SafeUser {
  const { passwordHash: _passwordHash, ...safe } = u
  return safe
}

export function newUserId(): string {
  return `u_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
}

export async function listUsers(limit = 500): Promise<User[]> {
  const ids = await redis.zrevrange(INDEX, 0, limit - 1)
  if (!ids.length) return []
  const raws = await Promise.all(ids.map(id => redis.get(KEY(id))))
  return raws
    .filter(Boolean)
    .map(r => { try { return JSON.parse(r as string) as User } catch { return null } })
    .filter((x): x is User => x !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function getUser(id: string): Promise<User | null> {
  if (!id) return null
  const raw = await redis.get(KEY(id))
  if (!raw) return null
  try { return JSON.parse(raw as string) as User } catch { return null }
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const norm = normalizeEmail(email)
  if (!norm) return null
  const id = await redis.get(EMAIL_KEY(norm))
  if (!id) return null
  return getUser(id)
}

export async function getUserByStaffId(staffId: string): Promise<User | null> {
  if (!staffId) return null
  // Small roster — a linear scan over the index is fine and avoids a second index
  // to keep consistent. Revisit if user count ever grows large.
  const all = await listUsers(1000)
  return all.find(u => u.staffId === staffId) ?? null
}

async function persist(u: User): Promise<void> {
  u.updatedAt = Date.now()
  await redis.set(KEY(u.id), JSON.stringify(u))
  await redis.zadd(INDEX, u.createdAt, u.id)
  await redis.set(EMAIL_KEY(u.email), u.id)
}

export type CreateUserInput = {
  email: string
  name: string
  role: Role
  password: string
  staffId?: string
  invitedBy?: string
}

// Creates a user, hashing the password. Throws 'EMAIL_TAKEN' if the (normalized)
// email already belongs to another account — the caller surfaces a 409.
export async function createUser(input: CreateUserInput): Promise<User> {
  const email = normalizeEmail(input.email)
  const existing = await getUserByEmail(email)
  if (existing) throw new Error('EMAIL_TAKEN')
  const now = Date.now()
  const u: User = {
    id: newUserId(),
    email,
    name: input.name.trim() || email,
    role: input.role,
    passwordHash: await hashPassword(input.password),
    staffId: input.staffId,
    active: true,
    invitedBy: input.invitedBy,
    createdAt: now,
    updatedAt: now,
  }
  await persist(u)
  return u
}

// Save an existing user. If the email changed, re-point the email index and drop
// the stale pointer so a freed address can be reused.
export async function saveUser(u: User, prevEmail?: string): Promise<void> {
  u.email = normalizeEmail(u.email)
  if (prevEmail && normalizeEmail(prevEmail) !== u.email) {
    await redis.del(EMAIL_KEY(prevEmail))
  }
  await persist(u)
}

export async function setUserPassword(id: string, password: string): Promise<User | null> {
  const u = await getUser(id)
  if (!u) return null
  u.passwordHash = await hashPassword(password)
  await persist(u)
  return u
}

export async function setUserActive(id: string, active: boolean): Promise<User | null> {
  const u = await getUser(id)
  if (!u) return null
  u.active = active
  await persist(u)
  return u
}

// Rotate current→previous and stamp the new current login. Best-effort at the call
// site (a Redis hiccup must never block a valid sign-in).
export async function recordUserLogin(id: string, at: number, device: string | null): Promise<void> {
  const u = await getUser(id)
  if (!u) return
  u.previousLoginAt = u.currentLoginAt
  u.previousLoginDevice = u.currentLoginDevice ?? null
  u.currentLoginAt = at
  u.currentLoginDevice = device
  await persist(u)
}

export async function deleteUser(id: string): Promise<void> {
  const u = await getUser(id)
  await redis.del(KEY(id))
  await redis.zrem(INDEX, id)
  if (u) await redis.del(EMAIL_KEY(u.email))
}
