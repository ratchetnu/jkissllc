// Pure decision logic for the one-time re-seal of legacy applicant documents
// (scripts/reseal-driver-docs.ts). Extracted so it can be tested without touching
// the production Blob store or Redis — the script keeps all the I/O.
//
// The whole migration hinges on classifying a stored document reference correctly:
// mistake a headshot for an identity document and we break staff avatars; mistake a
// sealed object for a plaintext one and we double-encrypt it.

import { isSensitiveDoc } from './ats-config'

export type DocRef = { kind: string; url: string }

/** Sealed objects carry a trailing `.enc`. */
export const isSealed = (url: string) => url.endsWith('.enc')

/** A pre-encryption reference: an absolute URL to an unsealed object. */
export const isLegacyPlaintext = (url: string) => url.startsWith('http') && !isSealed(url)

/** "https://…/driver-docs/ss_card/uuid.jpg" → "driver-docs/ss_card/uuid.jpg" */
export function pathnameOf(url: string): string {
  try { return new URL(url).pathname.replace(/^\//, '') } catch { return '' }
}

export type Action =
  | { action: 'seal'; oldPath: string; newPath: string }
  | { action: 'skip'; reason: 'headshot' | 'already-sealed' | 'not-legacy' | 'unparseable' }

/**
 * What should happen to one stored document reference.
 *
 * Only identity documents are sealed. Headshots stay public on purpose — they are
 * badge photos with no identity data, and they flow into staff avatars on
 * crew-facing screens.
 */
export function classify(doc: DocRef): Action {
  if (!isSensitiveDoc(doc.kind)) return { action: 'skip', reason: 'headshot' }
  if (isSealed(doc.url)) return { action: 'skip', reason: 'already-sealed' }
  if (!isLegacyPlaintext(doc.url)) return { action: 'skip', reason: 'not-legacy' }

  const oldPath = pathnameOf(doc.url)
  if (!oldPath) return { action: 'skip', reason: 'unparseable' }
  return { action: 'seal', oldPath, newPath: `${oldPath}.enc` }
}

/** True when a blob under `driver-docs/` is an unsealed identity document. */
export function isPlaintextIdentityBlob(pathname: string): boolean {
  const kind = pathname.split('/')[1] ?? ''
  return isSensitiveDoc(kind) && !isSealed(pathname)
}
