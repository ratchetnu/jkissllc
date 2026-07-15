// ── Make uploaded images readable by the vision model ────────────────────────
//
// The AI vision provider (Claude via the AI Gateway) decodes JPEG / PNG / WebP /
// GIF — NOT HEIC/HEIF. iPhones shoot HEIC by DEFAULT, so an un-converted HEIC
// reaches the model as an undecodable format and it identifies nothing (the exact
// "couldn't identify the piles" failure). This converts HEIC/HEIF → JPEG at upload
// so every photo the model sees is readable. Everything else passes through.

import convert from 'heic-convert' // pure-JS + libheif wasm — serverless-safe
import { put } from '@vercel/blob'

const HEIC_TYPES = new Set(['image/heic', 'image/heif'])

export type ReadableImage = { buffer: Buffer; contentType: string; ext: string }

/** Thrown when a HEIC/HEIF genuinely cannot be decoded — the caller should ask the
 *  customer to re-take or upload a JPG/PNG rather than store an unreadable image. */
export class UnreadableImageError extends Error {
  constructor(message = 'unreadable image') { super(message); this.name = 'UnreadableImageError' }
}

const extFor = (ct: string): string => (ct === 'image/jpeg' ? 'jpg' : (ct.split('/')[1] || 'jpg'))

/**
 * Ensure an uploaded image is in a model-readable format. HEIC/HEIF → JPEG;
 * anything else is returned unchanged. `convertHeic` is injectable for tests.
 */
export async function toModelReadableImage(
  buffer: Buffer,
  contentType: string,
  convertHeic: (buf: Buffer) => Promise<ArrayBuffer | Buffer> =
    (buf) => convert({ buffer: buf, format: 'JPEG', quality: 0.9 }),
): Promise<ReadableImage> {
  const ct = (contentType || '').toLowerCase()
  if (!HEIC_TYPES.has(ct)) {
    return { buffer, contentType: ct || 'image/jpeg', ext: extFor(ct || 'image/jpeg') }
  }
  try {
    const out = await convertHeic(buffer)
    const jpeg = Buffer.from(out as ArrayBuffer)
    if (!jpeg.length) throw new UnreadableImageError()
    return { buffer: jpeg, contentType: 'image/jpeg', ext: 'jpg' }
  } catch (e) {
    throw e instanceof UnreadableImageError ? e : new UnreadableImageError((e as Error)?.message)
  }
}

export function isHeic(contentType: string): boolean {
  return HEIC_TYPES.has((contentType || '').toLowerCase())
}

export function isHeicUrl(url: string): boolean {
  return /\.(heic|heif)(\?|#|$)/i.test(url || '')
}

/**
 * Retroactively convert already-STORED HEIC blobs to JPEG. For each url ending
 * .heic/.heif, fetch the object, convert to JPEG, re-store it, and return the new
 * url (same order + length; non-HEIC urls pass through). On a per-photo failure the
 * original url is kept (never drops a photo). `fetchBlob`/`putJpeg`/`convertHeic`
 * are injectable for tests. Used by the admin "Re-scan HEIC photos" action.
 */
export async function reconvertHeicUrls(
  urls: string[],
  deps: {
    fetchBlob?: (url: string) => Promise<{ buffer: Buffer; contentType: string }>
    putJpeg?: (buf: Buffer) => Promise<string>
    convertHeic?: (buf: Buffer) => Promise<ArrayBuffer | Buffer>
  } = {},
): Promise<{ urls: string[]; converted: number }> {
  const fetchBlob = deps.fetchBlob ?? (async (url: string) => {
    const r = await fetch(url)
    if (!r.ok) throw new Error(`fetch ${r.status}`)
    return { buffer: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') || 'image/heic' }
  })
  const putJpeg = deps.putJpeg ?? (async (buf: Buffer) => {
    const blob = await put(`quote-photos/${crypto.randomUUID()}.jpg`, buf, { access: 'public', contentType: 'image/jpeg', addRandomSuffix: false })
    return blob.url
  })
  let converted = 0
  const out: string[] = []
  for (const url of urls) {
    if (!isHeicUrl(url)) { out.push(url); continue }
    try {
      const { buffer, contentType } = await fetchBlob(url)
      const ct = HEIC_TYPES.has(contentType.toLowerCase()) ? contentType : 'image/heic'
      const jpeg = await toModelReadableImage(buffer, ct, deps.convertHeic)
      out.push(await putJpeg(jpeg.buffer))
      converted++
    } catch {
      out.push(url) // keep the original on failure — never lose a photo
    }
  }
  return { urls: out, converted }
}

/**
 * Convert a base64 `data:image/...;base64,...` URL to a model-readable one. HEIC/HEIF
 * → a JPEG data URL; anything else is returned unchanged. Used by routes that hand a
 * data URL straight to the vision model (no Blob storage). Throws UnreadableImageError
 * on an undecodable HEIC.
 */
export async function toModelReadableDataUrl(
  dataUrl: string,
  convertHeic?: (buf: Buffer) => Promise<ArrayBuffer | Buffer>,
): Promise<string> {
  const m = dataUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/i)
  if (!m) return dataUrl
  const ct = m[1].toLowerCase()
  if (!HEIC_TYPES.has(ct)) return dataUrl
  const { buffer } = await toModelReadableImage(Buffer.from(m[2], 'base64'), ct, convertHeic)
  return `data:image/jpeg;base64,${buffer.toString('base64')}`
}
