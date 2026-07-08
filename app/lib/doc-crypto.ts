// Encryption at rest for applicant identity documents.
//
// WHY THIS EXISTS INSTEAD OF A PRIVATE BLOB.
// The right fix is `put(..., { access: 'private' })`. Vercel rejects that on this
// store — "Cannot use private access on a public store. The store must be
// configured with private access" — and flipping a store to private is a dashboard
// change, not a code one. Applicants must keep uploading their Social Security card
// today, so we make the protection independent of store configuration: the bytes
// are AES-256-GCM sealed before they ever reach Blob storage. Whoever gets the URL
// gets ciphertext. Only /api/admin/careers/doc holds the key, and only for a
// signed-in admin.
//
// If the store is later reconfigured for private access, keep this anyway — a
// private store and an encrypted object are independent layers.
//
// KEY MATERIAL. Prefers DOC_ENCRYPTION_KEY (32 bytes, base64 or hex). If unset we
// derive a distinct key from ADMIN_SESSION_SECRET via HKDF with a domain-separation
// label, so this works in production with zero new configuration and the derived
// key can never collide with the session-signing key. If neither exists we FAIL
// CLOSED — refusing the upload beats writing a plaintext SS card to a public URL.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

const IV_BYTES = 12   // GCM standard
const TAG_BYTES = 16
const KEY_BYTES = 32

/** Distinct from every other use of ADMIN_SESSION_SECRET. Never change this string. */
const HKDF_INFO = 'jkiss/driver-docs/aes-256-gcm/v1'

export class DocCryptoUnavailable extends Error {
  constructor() {
    super('No document encryption key: set DOC_ENCRYPTION_KEY or ADMIN_SESSION_SECRET')
    this.name = 'DocCryptoUnavailable'
  }
}

function parseKey(raw: string): Buffer | null {
  const hex = /^[0-9a-f]{64}$/i
  const buf = hex.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  return buf.length === KEY_BYTES ? buf : null
}

function key(): Buffer {
  const explicit = process.env.DOC_ENCRYPTION_KEY
  if (explicit) {
    const k = parseKey(explicit.trim())
    if (k) return k
    // A malformed key is a configuration error, not a reason to store plaintext.
    throw new DocCryptoUnavailable()
  }

  const secret = process.env.ADMIN_SESSION_SECRET
  if (!secret) throw new DocCryptoUnavailable()

  // Salt is fixed and public; HKDF's security here rests on the secret, and a fixed
  // salt keeps the derivation deterministic across serverless instances.
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.from('jkiss-doc-salt'), Buffer.from(HKDF_INFO), KEY_BYTES))
}

/** Sealed layout: iv(12) ‖ tag(16) ‖ ciphertext. Self-describing, no sidecar. */
export function sealDoc(plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}

/** Throws if the object was tampered with — GCM authenticates as well as encrypts. */
export function openDoc(sealed: Buffer): Buffer {
  if (sealed.length <= IV_BYTES + TAG_BYTES) throw new Error('sealed document is truncated')
  const iv = sealed.subarray(0, IV_BYTES)
  const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const body = sealed.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

/** True when this app can seal/open documents at all. Used to fail closed early. */
export function docCryptoReady(): boolean {
  try { key(); return true } catch { return false }
}
