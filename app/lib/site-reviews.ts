import { redis } from './redis'

// On-site customer reviews — collected from the paid receipt, stored in Redis,
// independent of the Google Places integration in ./reviews.ts. One review per
// booking (keyed by booking token); a re-submission updates the existing one.
export type SiteReview = {
  token: string          // booking token — the key
  bookingNumber: string
  authorName: string     // full name from the booking (display is shortened)
  rating: number         // 1–5
  text?: string
  createdAt: number
  hidden?: boolean        // admin can hide a review from the public page
}

const KEY = (token: string) => `rv:${token}`
const INDEX = 'rv:index' // sorted set, score = createdAt, member = token

export async function getReview(token: string): Promise<SiteReview | null> {
  const raw = await redis.get(KEY(token))
  if (!raw) return null
  try { return JSON.parse(raw) as SiteReview } catch { return null }
}

export async function saveReview(r: SiteReview): Promise<void> {
  await redis.set(KEY(r.token), JSON.stringify(r))
  await redis.zadd(INDEX, r.createdAt, r.token)
}

export async function listReviews(limit = 300): Promise<SiteReview[]> {
  const tokens = await redis.zrevrange(INDEX, 0, limit - 1)
  if (!tokens.length) return []
  const raws = await Promise.all(tokens.map(t => redis.get(KEY(t))))
  return raws
    .map(r => { try { return r ? (JSON.parse(r) as SiteReview) : null } catch { return null } })
    .filter((x): x is SiteReview => !!x)
}

export async function setHidden(token: string, hidden: boolean): Promise<SiteReview | null> {
  const r = await getReview(token)
  if (!r) return null
  r.hidden = hidden
  await redis.set(KEY(token), JSON.stringify(r))
  return r
}

export async function deleteReview(token: string): Promise<void> {
  await redis.del(KEY(token))
  await redis.zrem(INDEX, token)
}

// First name + last initial — protects the customer's full name on the public page.
export function displayName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'Customer'
  if (parts.length === 1) return parts[0]
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`
}

export function aggregate(reviews: SiteReview[]): { rating: number; count: number } {
  const visible = reviews.filter(r => !r.hidden)
  if (!visible.length) return { rating: 0, count: 0 }
  const sum = visible.reduce((s, r) => s + r.rating, 0)
  return { rating: sum / visible.length, count: visible.length }
}
