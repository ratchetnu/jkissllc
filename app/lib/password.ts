// Password hashing for OpsPilot user accounts (admin / manager / crew logins).
//
// Dependency-free by design: the rest of the app runs on the Web Crypto API
// (see app/api/admin/_lib/session.ts), so we hash with PBKDF2-SHA256 via
// crypto.subtle rather than pulling in bcrypt/argon2 (native deps that don't run
// on the serverless/edge runtimes this project targets).
//
// Format stored on the user record: `pbkdf2$<iterations>$<saltB64>$<hashB64>`.
// Self-describing so the iteration count can be raised over time without
// invalidating existing hashes — verify reads the parameters back from the string.

const ITERATIONS = 210_000 // OWASP 2023 floor for PBKDF2-HMAC-SHA256
const KEY_LEN = 32 // bytes
const SALT_LEN = 16 // bytes

function b64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function fromB64(str: string): Uint8Array<ArrayBuffer> {
  const binary = atob(str)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function derive(password: string, salt: BufferSource, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    KEY_LEN * 8,
  )
  return new Uint8Array(bits)
}

/** Hash a plaintext password into a self-describing, storable string. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN))
  const hash = await derive(password, salt, ITERATIONS)
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(hash)}`
}

/**
 * Constant-time verify of a plaintext password against a stored hash string.
 * Returns false on any malformed input rather than throwing — a corrupt hash must
 * read as "wrong password", never crash the login path.
 */
export async function verifyPassword(password: string, stored: string | undefined | null): Promise<boolean> {
  if (!stored || typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const iterations = parseInt(parts[1], 10)
  if (!Number.isFinite(iterations) || iterations < 1) return false
  let salt: Uint8Array<ArrayBuffer>
  let expected: Uint8Array<ArrayBuffer>
  try {
    salt = fromB64(parts[2])
    expected = fromB64(parts[3])
  } catch {
    return false
  }
  const actual = await derive(password, salt, iterations)
  if (actual.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i]
  return diff === 0
}

/** Basic policy gate for chosen passwords. Kept minimal + honest (no theater). */
export function passwordPolicyError(password: string): string | null {
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters.'
  if (password.length > 200) return 'Password is too long.'
  return null
}
