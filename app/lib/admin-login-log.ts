// Records the admin's login history so every authenticated page can show a
// "Last Login" line (a lightweight account-security signal — "was that you?").
//
// There is ONE shared admin account today (see the tenancy TODO in
// app/api/admin/_lib/session.ts), so this is account-wide, not per-user. When real
// user identity lands, key these records by subject instead of the two fixed keys.
//
// Privacy: we store the coarse device string (parsed from the User-Agent) and the
// timestamp only. Raw IP addresses are never stored here and never returned to the
// client.
import { redis } from './redis'

const KEY_CURRENT = 'admin:login:current'
const KEY_PREVIOUS = 'admin:login:previous'

export type LoginRecord = { at: number; device: string | null }

// Best-effort, conservative UA → "Browser on OS". Returns null when we can't tell
// reliably (the request said: show device only when reliable).
export function parseDevice(ua: string | null | undefined): string | null {
  if (!ua || typeof ua !== 'string') return null
  const s = ua

  let os: string | null = null
  if (/iPhone/.test(s)) os = 'iPhone'
  else if (/iPad/.test(s)) os = 'iPad'
  else if (/Macintosh|Mac OS X/.test(s)) os = 'Mac'
  else if (/Windows NT/.test(s)) os = 'Windows'
  else if (/Android/.test(s)) os = 'Android'
  else if (/CrOS/.test(s)) os = 'ChromeOS'
  else if (/Linux/.test(s)) os = 'Linux'

  let browser: string | null = null
  // Order matters: Edge/Chrome UA strings also contain "Safari"; Chrome contains "Safari".
  if (/Edg\//.test(s)) browser = 'Edge'
  else if (/OPR\/|Opera/.test(s)) browser = 'Opera'
  else if (/SamsungBrowser/.test(s)) browser = 'Samsung Internet'
  else if (/Firefox\//.test(s)) browser = 'Firefox'
  else if (/Chrome\//.test(s)) browser = 'Chrome'
  else if (/Safari\//.test(s) && /Version\//.test(s)) browser = 'Safari'

  if (browser && os) return `${browser} on ${os}`
  if (browser) return browser
  if (os) return os
  return null
}

// Call ONLY on a successful authentication (never on a page refresh): rotate the
// current login into "previous" and stamp the new current. Best-effort — a Redis
// hiccup must never block sign-in, so callers wrap this and ignore failures.
export async function recordLogin(ua: string | null | undefined, at: number): Promise<void> {
  const current = await getRecord(KEY_CURRENT)
  if (current) await redis.set(KEY_PREVIOUS, JSON.stringify(current))
  const rec: LoginRecord = { at, device: parseDevice(ua) }
  await redis.set(KEY_CURRENT, JSON.stringify(rec))
}

// The login BEFORE the current session — i.e. what "Last Login" shows. Null when
// this is the first login ever recorded (UI shows "First Recorded Login").
export async function getLastLogin(): Promise<LoginRecord | null> {
  return getRecord(KEY_PREVIOUS)
}

async function getRecord(key: string): Promise<LoginRecord | null> {
  try {
    const raw = await redis.get(key)
    if (!raw) return null
    const o = JSON.parse(raw) as Partial<LoginRecord>
    if (typeof o.at !== 'number') return null
    return { at: o.at, device: typeof o.device === 'string' ? o.device : null }
  } catch {
    return null
  }
}
