// Google Places API wrapper for fetching Google Business Profile reviews.
// Requires two env vars (set them in Vercel → Project → Settings → Environment Variables):
//   GOOGLE_PLACES_API_KEY  — Places API (New) key from Google Cloud Console
//   GOOGLE_PLACE_ID        — J Kiss LLC's Google Business Profile place_id
//
// Without them, getReviews() returns null and the UI shows a graceful "coming soon" block.

export type Review = {
  authorName: string
  authorPhotoUrl: string | null
  rating: number          // 1–5
  text: string
  timeAgo: string         // human-readable e.g. "2 weeks ago"
  publishedAtUnix: number // for sorting / schema datePublished
}

export type ReviewsData = {
  reviews: Review[]
  rating: number              // overall rating, 1.0–5.0
  totalRatings: number        // total review count from Google
  fetchedAt: number
}

const PLACES_DETAILS_URL = 'https://places.googleapis.com/v1/places'

type PlacesReview = {
  authorAttribution?: { displayName?: string; photoUri?: string }
  rating?: number
  text?: { text?: string }
  relativePublishTimeDescription?: string
  publishTime?: string
}

type PlacesDetailsResponse = {
  rating?: number
  userRatingCount?: number
  reviews?: PlacesReview[]
}

/**
 * Fetches reviews from Google Places API (New). Returns null if env vars are missing
 * or the request fails — callers should handle the null gracefully.
 * Calls are deduped/cached for 24h via Next.js fetch revalidation.
 */
export async function getReviews(): Promise<ReviewsData | null> {
  const key = process.env.GOOGLE_PLACES_API_KEY
  const placeId = process.env.GOOGLE_PLACE_ID
  if (!key || !placeId) return null

  try {
    const res = await fetch(`${PLACES_DETAILS_URL}/${placeId}`, {
      headers: {
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'rating,userRatingCount,reviews',
      },
      next: { revalidate: 60 * 60 * 24 }, // 24 hours
    })
    if (!res.ok) {
      console.error('[reviews] Places API error', res.status, await res.text())
      return null
    }
    const data = (await res.json()) as PlacesDetailsResponse

    const reviews: Review[] = (data.reviews ?? []).map(r => ({
      authorName: r.authorAttribution?.displayName ?? 'Google User',
      authorPhotoUrl: r.authorAttribution?.photoUri ?? null,
      rating: r.rating ?? 5,
      text: r.text?.text ?? '',
      timeAgo: r.relativePublishTimeDescription ?? '',
      publishedAtUnix: r.publishTime ? new Date(r.publishTime).getTime() : Date.now(),
    }))

    return {
      reviews,
      rating: data.rating ?? 0,
      totalRatings: data.userRatingCount ?? 0,
      fetchedAt: Date.now(),
    }
  } catch (err) {
    console.error('[reviews] fetch failed', err)
    return null
  }
}
