// ── Photo de-duplication (content hash) ──────────────────────────────────────
//
// A customer sometimes uploads the SAME photo twice (the eval's duplicate case). The
// vision model is told not to double-count (analysis-v2-prompt rule 4), but this is the
// deterministic backstop: collapse EXACT byte-duplicate images BEFORE analysis so a repeat
// upload can never multiply the inventory/volume. Fetches each URL once and sha256s the
// bytes; on any fetch error the URL is KEPT (fail-open — never silently drop a real photo).
//
// Near-duplicate / perceptual matching is intentionally out of scope: it needs an image
// library and risks collapsing genuinely different angles. Exact byte-duplicate covers the
// common "same file uploaded twice" case that actually inflates a quote.

import crypto from 'node:crypto'

export type DedupResult = {
  uniqueUrls: string[]        // input order preserved; later exact-duplicates removed
  duplicateCount: number      // how many URLs were dropped as exact duplicates
}

export async function dedupePhotoUrls(
  urls: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<DedupResult> {
  const seen = new Set<string>()
  const uniqueUrls: string[] = []
  let duplicateCount = 0
  for (const url of urls) {
    let hash: string | null = null
    try {
      const res = await fetchImpl(url)
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer())
        hash = crypto.createHash('sha256').update(buf).digest('hex')
      }
    } catch {
      hash = null   // fail-open: keep the photo
    }
    if (hash && seen.has(hash)) { duplicateCount++; continue }
    if (hash) seen.add(hash)
    uniqueUrls.push(url)
  }
  return { uniqueUrls, duplicateCount }
}
