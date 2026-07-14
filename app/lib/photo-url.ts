// ─────────────────────────────────────────────────────────────────────────────
// Photo-URL allow-list. Every customer photo enters through /api/upload (or the
// admin blob-upload broker) and lands on Vercel Blob, so the ONLY host we should
// ever hand to the AI vision provider — or persist onto a booking / carry into an
// ops email — is our Blob store. This closes the SSRF-via-provider + cost-abuse +
// link-injection surface on the public quote routes (untrusted `photos[]`).
// ─────────────────────────────────────────────────────────────────────────────

const BLOB_HOST_SUFFIXES = ['.public.blob.vercel-storage.com', '.blob.vercel-storage.com']

/** True only for an https URL on our Vercel Blob store. */
export function isAllowedPhotoUrl(u: unknown): boolean {
  if (typeof u !== 'string' || u.length > 1000) return false
  let url: URL
  try { url = new URL(u) } catch { return false }
  if (url.protocol !== 'https:') return false
  const h = url.hostname.toLowerCase()
  return BLOB_HOST_SUFFIXES.some(s => h.endsWith(s))
}

/** Filter arbitrary input to a bounded list of allowed Blob photo URLs. */
export function filterPhotoUrls(v: unknown, max = 8): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of v) {
    const u = String(raw)
    if (!isAllowedPhotoUrl(u) || seen.has(u)) continue
    seen.add(u)
    out.push(u)
    if (out.length >= max) break
  }
  return out
}
