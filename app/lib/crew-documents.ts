import { redis } from './redis'

// ── Crew documents ─────────────────────────────────────────────────────────────
// The records a 1099 crew member is entitled to read: their contractor agreement,
// company policies, training material, tax documents, and job-specific docs. Two
// scopes:
//   • library  — one document shared with the whole crew (policies, training,
//                the standard contractor agreement). No staffId.
//   • staff    — a document that belongs to ONE crew member (their signed
//                agreement, their 1099/tax forms). Carries a staffId and is only
//                ever served back to that person.
//
// Bytes live in Vercel Blob; Redis holds the pointer (mirrors uniform.ts /
// payment-proof.ts). Sensitive documents (tax, personal agreements) are AES-256-GCM
// sealed with doc-crypto before upload and decrypted only at serve time for the
// owner — the Blob store is public, so the ciphertext is what's at rest.
//
// Pay statements are NOT stored here: they already have their own issued-snapshot
// store (pay-statements.ts) and the portal documents view merges them in as links.

export type CrewDocCategory = 'agreement' | 'policy' | 'training' | 'tax' | 'job' | 'other'
export type CrewDocScope = 'library' | 'staff'

export type CrewDocument = {
  id: string
  scope: CrewDocScope
  staffId?: string          // required when scope === 'staff'; absent for library
  category: CrewDocCategory
  title: string
  description?: string
  blobUrl: string           // absolute Vercel Blob URL (ciphertext when sealed)
  blobPath: string          // physical pathname (for deletes/migrations)
  sealed: boolean           // AES-GCM sealed → decrypt at serve time
  contentType: string       // the ORIGINAL content type (application/pdf, image/…)
  size: number              // plaintext byte length
  uploadedBy: string        // admin/manager sub who published it
  createdAt: number
  updatedAt: number
}

const KEY = (id: string) => `crewdoc:${id}`
const INDEX = 'crewdoc:index'
const LIBRARY_INDEX = 'crewdoc:library'
const STAFF_INDEX = (staffId: string) => `crewdoc:staff:${staffId}`

// Sensible default: personal/tax/agreement documents are sealed; shared reference
// material (policies, training) is not. Callers may override explicitly.
export function defaultSealed(category: CrewDocCategory, scope: CrewDocScope): boolean {
  if (scope === 'library') return false // shared reference material — same for everyone
  return category === 'tax' || category === 'agreement'
}

export function newCrewDocId(): string {
  return `cd_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`
}

// May this staff member read this document? Library docs are readable by any crew
// member; staff-scoped docs only by their owner. The single gate every serve path uses.
export function canAccess(doc: Pick<CrewDocument, 'scope' | 'staffId'>, staffId: string): boolean {
  if (doc.scope === 'library') return true
  return !!doc.staffId && doc.staffId === staffId
}

export async function saveCrewDocument(doc: CrewDocument): Promise<CrewDocument> {
  doc.updatedAt = Date.now()
  await redis.set(KEY(doc.id), JSON.stringify(doc))
  await redis.zadd(INDEX, doc.createdAt, doc.id)
  if (doc.scope === 'library') {
    await redis.zadd(LIBRARY_INDEX, doc.createdAt, doc.id)
  } else if (doc.staffId) {
    await redis.zadd(STAFF_INDEX(doc.staffId), doc.createdAt, doc.id)
  }
  return doc
}

export async function getCrewDocument(id: string): Promise<CrewDocument | null> {
  const raw = await redis.get(KEY(id))
  if (!raw) return null
  try {
    return JSON.parse(raw as string) as CrewDocument
  } catch {
    return null
  }
}

async function hydrate(ids: string[]): Promise<CrewDocument[]> {
  if (!ids.length) return []
  const raws = await Promise.all(ids.map((id) => redis.get(KEY(id))))
  return raws
    .map((r) => {
      try {
        return r ? (JSON.parse(r as string) as CrewDocument) : null
      } catch {
        return null
      }
    })
    .filter((x): x is CrewDocument => x !== null)
}

export async function listLibraryDocuments(limit = 100): Promise<CrewDocument[]> {
  return hydrate(await redis.zrevrange(LIBRARY_INDEX, 0, limit - 1))
}

export async function listStaffDocuments(staffId: string, limit = 100): Promise<CrewDocument[]> {
  return hydrate(await redis.zrevrange(STAFF_INDEX(staffId), 0, limit - 1))
}

// Everything a crew member may see: the shared library plus their own documents,
// newest first. This is the portal's read.
export async function listCrewDocumentsFor(staffId: string): Promise<CrewDocument[]> {
  const [library, own] = await Promise.all([listLibraryDocuments(), listStaffDocuments(staffId)])
  return [...library, ...own].sort((a, b) => b.createdAt - a.createdAt)
}

export async function listAllCrewDocuments(limit = 300): Promise<CrewDocument[]> {
  return hydrate(await redis.zrevrange(INDEX, 0, limit - 1))
}

export async function deleteCrewDocument(id: string): Promise<CrewDocument | null> {
  const doc = await getCrewDocument(id)
  if (!doc) return null
  await redis.del(KEY(id))
  await redis.zrem(INDEX, id)
  if (doc.scope === 'library') await redis.zrem(LIBRARY_INDEX, id)
  else if (doc.staffId) await redis.zrem(STAFF_INDEX(doc.staffId), id)
  return doc
}
