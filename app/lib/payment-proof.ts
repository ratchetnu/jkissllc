import { put, get } from '@vercel/blob'
import { sealDoc, openDoc, docCryptoReady } from './doc-crypto'
import { scopeBlobPath, sanitizeBlobSegment } from './platform/tenancy/blob-keys'

// Secure storage for Zelle payment screenshots (request Parts 4-5). Treated as
// sensitive customer financial data:
//   • server-side validation (mime allowlist + size cap + magic-byte sniff)
//   • AES-256-GCM SEALED before it ever reaches Blob storage (Vercel's store is
//     public, so the bytes must carry their own protection — mirrors driver-docs)
//   • unguessable path scoped to the booking token
//   • decrypted only by the admin-gated serve endpoint; the path is never exposed
//     to a customer and never trusted from the client
//
// This module holds the pure validation + seal/store/open logic. Auth, rate limiting,
// and bot defense live in the route handlers that call it.

export const PROOF_MIME = /^image\/(jpeg|png|webp|heic|heif)$/
// Path shape the serve endpoint locks to (prefix + token scope + .enc marker).
// The leading tenant prefix is OPTIONAL: legacy (un-prefixed) paths match exactly
// as before — byte-identical — and once tenancy is on a `tenants/<id>/` prefix is
// also accepted, so stored proof paths keep validating across the flip. NOTE: the
// booking-scoped ownership check lives in the serve route
// (app/api/admin/bookings/[id]/proof) via `startsWith('payment-proofs/<token>/')`
// and must be widened to tolerate the same optional prefix BEFORE tenancy flips on.
export const PROOF_PATH_RE = /^(?:tenants\/[a-z0-9][a-z0-9-]{0,63}\/)?payment-proofs\/[a-f0-9]{16,}\/[a-zA-Z0-9-]+\.(jpg|png|webp|heic|heif)\.enc$/
const MEDIA: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' }

// Max encoded data-URL length (~7.5 MB of actual image after base64 overhead).
const MAX_DATAURL_LEN = 10_000_000

export type ProofValidation =
  | { ok: true; buf: Buffer; ext: string; mime: string }
  | { ok: false; error: string }

// First bytes must match the DECLARED media type — stops a renamed executable / PDF
// from riding in under an image mime, and catches HEIC where we can.
function magicMatches(buf: Buffer, mime: string): boolean {
  if (buf.length < 12) return false
  const b = buf
  if (mime === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
  if (mime === 'image/png') return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
  if (mime === 'image/webp') return b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP'
  if (mime === 'image/heic' || mime === 'image/heif') return b.subarray(4, 8).toString('ascii') === 'ftyp'
  return false
}

// Validate a base64 data-URL screenshot. Rejects non-images (PDF/exe/unknown),
// oversized files, and mime/content mismatches. Never throws.
export function validateProofImage(image: unknown): ProofValidation {
  if (typeof image !== 'string' || !image) return { ok: false, error: 'A payment screenshot is required.' }
  if (image.length > MAX_DATAURL_LEN) return { ok: false, error: 'That image is too large. Please upload a photo under ~7 MB.' }
  const m = image.match(/^data:(image\/(jpeg|png|webp|heic|heif));base64,(.+)$/)
  if (!m) return { ok: false, error: 'Please upload a JPG, PNG, or HEIC screenshot (PDFs and other files are not accepted).' }
  const mime = m[1]
  let buf: Buffer
  try { buf = Buffer.from(m[3], 'base64') } catch { return { ok: false, error: 'That file could not be read. Please try a different screenshot.' } }
  if (buf.length < 100) return { ok: false, error: 'That image looks empty. Please re-upload your payment confirmation.' }
  if (!magicMatches(buf, mime)) return { ok: false, error: 'That file does not look like a valid image. Please upload a real screenshot.' }
  const ext = m[2] === 'jpeg' ? 'jpg' : m[2]
  return { ok: true, buf, ext, mime }
}

// Tenant-safe physical path for a sealed payment proof. The booking token stays a
// directory segment exactly as today (it is server-controlled and already
// `[a-f0-9]{16,}`); only the filename is sanitized. Byte-identical to
// `payment-proofs/<token>/<uuid>.<ext>.enc` while tenancy is off;
// `tenants/<id>/payment-proofs/…` once on. The returned pathname (never a URL) is
// what we persist and read back, so legacy records keep resolving unchanged.
export function proofBlobPath(bookingToken: string, id: string, ext: string): string {
  return scopeBlobPath(`payment-proofs/${bookingToken}/${sanitizeBlobSegment(`${id}.${ext}.enc`)}`)
}

// Seal + store under an unguessable, booking-scoped path. Returns the pathname
// (NOT a public URL) to persist on the payment record.
export async function sealAndStoreProof(bookingToken: string, buf: Buffer, ext: string): Promise<string> {
  if (!docCryptoReady()) throw new Error('DOC_CRYPTO_UNAVAILABLE')
  const pathname = proofBlobPath(bookingToken, crypto.randomUUID(), ext)
  await put(pathname, sealDoc(buf), {
    access: 'public',                       // the store is public; the BYTES are ciphertext
    contentType: 'application/octet-stream',
    addRandomSuffix: false,
  })
  return pathname
}

export function proofMediaType(pathname: string): string {
  const ext = pathname.slice(0, -4).split('.').pop() ?? ''   // "…/<uuid>.jpg.enc" → "jpg"
  return MEDIA[ext] ?? 'application/octet-stream'
}

// Download + decrypt a sealed proof for the admin serve endpoint. Throws on
// tamper (GCM auth) or a missing object.
export async function openProof(pathname: string): Promise<Buffer> {
  const res = await get(pathname, { access: 'public' })
  if (!res) throw new Error('proof not found')
  const sealed = Buffer.from(await new Response(res.stream as unknown as ReadableStream).arrayBuffer())
  return openDoc(sealed)
}
