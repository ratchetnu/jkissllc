// ── AI-send-side photo resolution ────────────────────────────────────────────
//
// At upload we store the ORIGINAL photo and, when image optimization is on, a
// downscaled JPEG derivative next to it at a deterministic sibling key:
//   quote-photos/<uuid>.jpg        ← original (what a booking/staff view shows)
//   quote-photos/<uuid>.ai.jpg     ← model derivative (what the vision model reads)
//
// Because the derivative key is a pure function of the original URL, the AI path
// can transparently prefer the derivative for ANY stored photo — the instant quote
// path AND the durable Book-Now worker, which only carries original URLs — with NO
// booking-schema change and full backward compatibility.
//
// resolveAiPhotoUrls is the swap point. Off (or derivative missing) → the original
// URL is used, so behavior is byte-identical to today and a photo is never dropped.

/** Map a stored original blob URL to its deterministic `.ai.jpg` derivative URL.
 *  Returns null when the input isn't a URL or is already a derivative. */
export function aiDerivativeUrl(originalUrl: string): string | null {
  if (typeof originalUrl !== 'string' || !originalUrl) return null
  let url: URL
  try { url = new URL(originalUrl) } catch { return null }
  const path = url.pathname
  const slash = path.lastIndexOf('/')
  const seg = path.slice(slash + 1)
  if (!seg || seg.startsWith('.')) return null
  if (/\.ai\.jpg$/i.test(seg)) return null // already the derivative — don't double-map
  const dot = seg.lastIndexOf('.')
  const base = dot > 0 ? seg.slice(0, dot) : seg
  url.pathname = path.slice(0, slash + 1) + `${base}.ai.jpg`
  return url.toString()
}

export type ResolveAiPhotoUrls = {
  urls: string[]          // same length + order as input; derivative where present, else original
  derivativeCount: number // how many originals were swapped for their derivative
}

// Default existence probe: a HEAD against the public blob URL. Fail-soft — any
// network/parse error is treated as "not present" so we fall back to the original.
async function headExists(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: 'HEAD' })
    return r.ok
  } catch {
    return false
  }
}

/**
 * Swap each original photo URL for its stored optimized derivative when
 * optimization is enabled AND the derivative actually exists. `exists` is
 * injectable for tests. Never throws; never changes array length/order.
 */
export async function resolveAiPhotoUrls(
  urls: readonly string[],
  opts: { enabled: boolean; exists?: (url: string) => Promise<boolean> },
): Promise<ResolveAiPhotoUrls> {
  const list = Array.isArray(urls) ? urls.slice() : []
  if (!opts.enabled || list.length === 0) return { urls: list, derivativeCount: 0 }
  const exists = opts.exists ?? headExists

  const resolved = await Promise.all(list.map(async (original) => {
    const derived = aiDerivativeUrl(original)
    if (!derived) return { url: original, used: false }
    try {
      return (await exists(derived)) ? { url: derived, used: true } : { url: original, used: false }
    } catch {
      return { url: original, used: false }
    }
  }))

  return {
    urls: resolved.map(r => r.url),
    derivativeCount: resolved.reduce((n, r) => n + (r.used ? 1 : 0), 0),
  }
}
