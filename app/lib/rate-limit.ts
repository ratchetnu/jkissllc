import type { NextRequest } from 'next/server'
import { redis } from './redis'

export function getIP(req: NextRequest): string {
  return (
    req.headers.get('x-vercel-forwarded-for')?.split(',')[0].trim() ||
    req.headers.get('x-real-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    'unknown'
  )
}

/**
 * Fixed-window per-IP rate limit, backed by Upstash Redis so the counter is
 * shared across all serverless instances. An in-memory Map is per-instance and
 * trivially bypassed on a platform that scales horizontally and cold-starts.
 *
 * Returns true when the caller is OVER the limit (should be rejected).
 *
 * Fails OPEN if Redis is unavailable: a public form going down because the
 * cache hiccuped is worse than briefly losing the limit.
 */
export async function rateLimit(
  req: NextRequest,
  bucket: string,
  max: number,
  windowMs: number,
): Promise<boolean> {
  const key = `rl:${bucket}:${getIP(req)}`
  try {
    const count = await redis.incr(key)
    if (count === 1) await redis.pexpire(key, windowMs)
    return count > max
  } catch {
    return false
  }
}
