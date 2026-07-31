type PhotoLike = string | { url?: unknown }

export function canonicalPhotoUrls(photos: readonly PhotoLike[] | undefined): string[] {
  return [...new Set(
    (photos ?? [])
      .map(photo => typeof photo === 'string' ? photo : photo?.url)
      .filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
      .map(url => url.trim()),
  )].sort()
}

/** Stable, non-secret identity for a photo set. Order changes do not invalidate it. */
export function photoSetFingerprint(photos: readonly PhotoLike[] | undefined): string {
  const urls = canonicalPhotoUrls(photos)
  let hash = 0x811c9dc5
  for (const char of urls.join('\u0000')) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193)
  }
  return `p${urls.length}-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function samePhotoSet(
  left: readonly PhotoLike[] | undefined,
  right: readonly PhotoLike[] | undefined,
): boolean {
  const a = canonicalPhotoUrls(left)
  const b = canonicalPhotoUrls(right)
  return a.length === b.length && a.every((url, index) => url === b[index])
}
