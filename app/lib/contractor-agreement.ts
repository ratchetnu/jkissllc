import { createHash } from 'node:crypto'
import { put } from '@vercel/blob'
import { redis } from './redis'
import { sealDoc, openDoc, docCryptoReady } from './doc-crypto'
import { scopeBlobPath, sanitizeBlobSegment } from './platform/tenancy/blob-keys'

// ── Counsel-approved contractor agreement (versioned template) ────────────────
//
// Operion never authors, generates, or edits agreement language. An administrator
// uploads a counsel-approved PDF; this module stores it as an immutable, numbered
// VERSION and points "current" at it. Publishing a replacement mints a new version
// and leaves every earlier one readable, because each onboarding request is pinned
// to the version the contractor was actually asked to sign — replacing the template
// must never retroactively change what an outstanding request means.
//
// The bytes are sealed with the same AES-GCM envelope as every other sensitive
// document and stored under a tenant-scoped Blob path. Redis keys are plain
// `contractoragreement:` logical keys, so the chokepoint in lib/redis.ts scopes
// them per tenant like everything else.

const KEY = (version: number) => `contractoragreement:v:${version}`
const CURRENT = 'contractoragreement:current'
const COUNTER = 'contractoragreement:counter'

export type ContractorAgreementTemplate = {
  version: number
  filename: string
  contentType: string
  size: number             // plaintext byte length
  sha256: string           // plaintext digest — lets an admin prove which file is live
  blobUrl: string          // absolute Blob URL (ciphertext)
  blobPath: string         // physical pathname, tenant-scoped
  sealed: true
  publishedBy: string
  publishedAt: number
  note?: string
}

export class ContractorAgreementUnavailable extends Error {
  constructor(message: string) { super(message); this.name = 'ContractorAgreementUnavailable' }
}

/** The published template for `version`, or null when that version never existed. */
export async function getContractorAgreementVersion(version: number): Promise<ContractorAgreementTemplate | null> {
  if (!Number.isInteger(version) || version < 1) return null
  const raw = await redis.get(KEY(version))
  if (!raw) return null
  try { return JSON.parse(raw as string) as ContractorAgreementTemplate } catch { return null }
}

/** The template a NEW onboarding request would be pinned to, or null when unset. */
export async function getCurrentContractorAgreement(): Promise<ContractorAgreementTemplate | null> {
  const current = await redis.get(CURRENT)
  const version = Number(current ?? 0)
  if (!version) return null
  return getContractorAgreementVersion(version)
}

/**
 * Store a counsel-approved PDF as the next version and make it current.
 *
 * The caller supplies bytes it has already validated as a PDF. Nothing here parses,
 * rewrites or reflows the document — the published object is the exact file the
 * administrator uploaded, sealed.
 */
export async function publishContractorAgreement(input: {
  bytes: Buffer
  filename: string
  publishedBy: string
  note?: string
}): Promise<ContractorAgreementTemplate> {
  if (!docCryptoReady()) {
    throw new ContractorAgreementUnavailable('Document encryption is not configured; refusing to store the agreement.')
  }
  const version = Number(await redis.incr(COUNTER))
  const filename = sanitizeBlobSegment(input.filename || 'contractor-agreement.pdf')
  const path = scopeBlobPath(`contractor-agreements/v${version}/${sanitizeBlobSegment(`${crypto.randomUUID()}.pdf.enc`)}`)
  const blob = await put(path, sealDoc(input.bytes), {
    access: 'public',                       // the BYTES are sealed; the URL is never published
    contentType: 'application/octet-stream',
    addRandomSuffix: false,
  })
  const template: ContractorAgreementTemplate = {
    version,
    filename,
    contentType: 'application/pdf',
    size: input.bytes.byteLength,
    sha256: createHash('sha256').update(input.bytes).digest('hex'),
    blobUrl: blob.url,
    blobPath: path,
    sealed: true,
    publishedBy: input.publishedBy,
    publishedAt: Date.now(),
    ...(input.note ? { note: input.note } : {}),
  }
  await redis.set(KEY(version), JSON.stringify(template))
  await redis.set(CURRENT, String(version))
  return template
}

/** Decrypt a published template for delivery. Never called without an authorized token. */
export async function readContractorAgreementBytes(template: ContractorAgreementTemplate): Promise<Buffer> {
  const res = await fetch(template.blobUrl)
  if (!res.ok) throw new ContractorAgreementUnavailable(`agreement blob ${res.status}`)
  const raw = Buffer.from(await res.arrayBuffer())
  return template.sealed ? openDoc(raw) : raw
}

/** Every published version, newest first — for the admin status panel. */
export async function listContractorAgreementVersions(limit = 20): Promise<ContractorAgreementTemplate[]> {
  const latest = Number(await redis.get(COUNTER) ?? 0)
  if (!latest) return []
  const versions: number[] = []
  for (let v = latest; v > 0 && versions.length < limit; v--) versions.push(v)
  const rows = await Promise.all(versions.map(getContractorAgreementVersion))
  return rows.filter((row): row is ContractorAgreementTemplate => row !== null)
}
