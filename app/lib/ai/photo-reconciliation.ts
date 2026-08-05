import { createHash } from 'node:crypto'
import { Jimp } from 'jimp'

export type PhotoFingerprint = {
  photoId: string
  url: string
  exactHash?: string
  perceptualHash?: string
  exactDuplicateOf?: string
  nearDuplicateOf?: string
  duplicateRelationshipConfidence: number
}

export type ReconciledPhotoSet = {
  all: PhotoFingerprint[]
  active: PhotoFingerprint[]
  exactDuplicateCount: number
  nearDuplicateCount: number
}

const MAX_BYTES = 8_000_000
export const NEAR_DUPLICATE_DISTANCE = 8

export function hammingHex(a: string, b: string): number {
  if (!a || a.length !== b.length) return -1
  let distance = 0
  for (let i = 0; i < a.length; i++) {
    let bits = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (bits) { distance += bits & 1; bits >>>= 1 }
  }
  return distance
}

export async function fingerprintPhoto(buffer: Buffer): Promise<{ exactHash: string; perceptualHash?: string }> {
  const exactHash = createHash('sha256').update(buffer).digest('hex')
  try {
    const image = await Jimp.read(buffer)
    image.greyscale().resize({ w: 9, h: 8 })
    let bits = ''
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const left = image.bitmap.data[(y * 9 + x) * 4]
        const right = image.bitmap.data[(y * 9 + x + 1) * 4]
        bits += left < right ? '1' : '0'
      }
    }
    let perceptualHash = ''
    for (let i = 0; i < bits.length; i += 4) perceptualHash += parseInt(bits.slice(i, i + 4), 2).toString(16)
    return { exactHash, perceptualHash }
  } catch {
    return { exactHash }
  }
}

async function readPhoto(url: string, fetcher: typeof fetch): Promise<Buffer | null> {
  try {
    const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(5_000) })
    if (!response.ok) return null
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > MAX_BYTES) return null
    const bytes = Buffer.from(await response.arrayBuffer())
    return bytes.length > 0 && bytes.length <= MAX_BYTES ? bytes : null
  } catch {
    return null
  }
}

/** Per-request only: photo evidence is never cached or shared across tenants. */
export async function reconcilePhotoSet(
  urls: readonly string[],
  fetcher: typeof fetch = fetch,
): Promise<ReconciledPhotoSet> {
  const all: PhotoFingerprint[] = urls.map((url, index) => ({
    photoId: `p${index}`, url, duplicateRelationshipConfidence: 0,
  }))
  const buffers = await Promise.all(all.map(photo => readPhoto(photo.url, fetcher)))
  const hashes = await Promise.all(buffers.map(buffer => buffer ? fingerprintPhoto(buffer) : {}))
  hashes.forEach((hash, index) => Object.assign(all[index], hash))

  for (let i = 0; i < all.length; i++) {
    for (let j = 0; j < i; j++) {
      const current = all[i], prior = all[j]
      if (current.exactHash && current.exactHash === prior.exactHash) {
        current.exactDuplicateOf = prior.exactDuplicateOf ?? prior.photoId
        current.duplicateRelationshipConfidence = 1
        break
      }
      const distance = current.perceptualHash && prior.perceptualHash
        ? hammingHex(current.perceptualHash, prior.perceptualHash) : -1
      if (distance >= 0 && distance <= NEAR_DUPLICATE_DISTANCE) {
        current.nearDuplicateOf = prior.photoId
        current.duplicateRelationshipConfidence = Math.max(0.5, 1 - distance / 16)
        break
      }
    }
  }
  return {
    all,
    active: all.filter(photo => !photo.exactDuplicateOf),
    exactDuplicateCount: all.filter(photo => photo.exactDuplicateOf).length,
    nearDuplicateCount: all.filter(photo => photo.nearDuplicateOf).length,
  }
}
