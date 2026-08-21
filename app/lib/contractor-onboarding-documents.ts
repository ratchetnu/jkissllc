import { get, put } from '@vercel/blob'
import { openDoc, sealDoc, docCryptoReady } from './doc-crypto'
import { scopeBlobPath, sanitizeBlobSegment } from './platform/tenancy/blob-keys'
import {
  listStaffDocuments, newCrewDocId, saveCrewDocument, type CrewDocument,
} from './crew-documents'
import type { Applicant } from './applicants'

// After an administrator verifies onboarding, the contractor's OWN executed
// agreement becomes visible to them in the crew portal's documents area.
//
// The bytes are re-sealed into the crew-documents namespace rather than pointed at
// the onboarding upload: crew documents are owner-scoped (`scope: 'staff'`), served
// decrypted only through the portal's ownership check with `private, no-store`, and
// deleted through the crew-document lifecycle. Nothing is written in plaintext to
// public storage, and no other crew member can reach it — `canAccess` compares the
// document's staffId against the caller's own.

const AGREEMENT_TITLE = 'Signed independent-contractor agreement'

/** True when this staff member already has their executed agreement published. */
export async function hasExecutedAgreementDocument(staffId: string): Promise<boolean> {
  const docs = await listStaffDocuments(staffId)
  return docs.some(doc => doc.category === 'agreement' && doc.title === AGREEMENT_TITLE)
}

/**
 * Copy the applicant's executed agreement into their owner-scoped crew documents.
 * Idempotent: verifying twice does not publish a second copy.
 *
 * Returns null when there is nothing to publish; throws only on a storage failure the
 * caller should surface, never on "already published".
 */
export async function publishExecutedAgreementToCrewDocuments(input: {
  applicant: Pick<Applicant, 'id' | 'applicantNumber' | 'documents' | 'contractorOnboarding' | 'promotedStaffId'>
  publishedBy: string
}): Promise<CrewDocument | null> {
  const staffId = input.applicant.promotedStaffId
  if (!staffId) throw new Error('CONTRACTOR_CREW_LINK_REQUIRED')
  const executed = input.applicant.documents.find(doc => doc.kind === 'contractor_agreement')
  if (!executed) return null
  if (await hasExecutedAgreementDocument(staffId)) return null
  if (!docCryptoReady()) throw new Error('CONTRACTOR_AGREEMENT_CRYPTO_UNAVAILABLE')

  // The onboarding upload stored a sealed PATHNAME (never a URL — nothing in the
  // contractor's browser is a link to their tax documents). Resolve it the same way
  // the admin document reader does, then re-seal under the crew-documents path.
  const source = executed.url
  const sealedSource = source.endsWith('.enc')
  let raw: Buffer
  if (sealedSource && !/^https?:\/\//.test(source)) {
    const object = await get(source, { access: 'public' })
    if (!object) throw new Error('executed agreement object missing')
    raw = Buffer.from(await new Response(object.stream as unknown as ReadableStream).arrayBuffer())
  } else {
    const res = await fetch(source)
    if (!res.ok) throw new Error(`executed agreement blob ${res.status}`)
    raw = Buffer.from(await res.arrayBuffer())
  }
  const plaintext = sealedSource ? openDoc(raw) : raw

  const id = newCrewDocId()
  const path = scopeBlobPath(`crew-docs/agreement/${sanitizeBlobSegment(`${id}.pdf.enc`)}`)
  const blob = await put(path, sealDoc(plaintext), {
    access: 'public',                       // sealed bytes; the URL is never published
    contentType: 'application/octet-stream',
    addRandomSuffix: false,
  })
  const now = Date.now()
  return saveCrewDocument({
    id,
    scope: 'staff',
    staffId,
    category: 'agreement',
    title: AGREEMENT_TITLE,
    description: `Executed agreement from onboarding ${input.applicant.applicantNumber}`
      + (input.applicant.contractorOnboarding?.agreementVersion
        ? ` (template v${input.applicant.contractorOnboarding.agreementVersion})`
        : ''),
    blobUrl: blob.url,
    blobPath: path,
    sealed: true,
    contentType: 'application/pdf',
    size: plaintext.byteLength,
    uploadedBy: input.publishedBy,
    createdAt: now,
    updatedAt: now,
  })
}

/**
 * The onboarding documents an administrator must actually see before a contractor may
 * be verified. Returns the kinds that are missing, so the route can name them.
 */
export function missingVerificationDocuments(
  applicant: Pick<Applicant, 'position' | 'documents' | 'contractorOnboarding'>,
  requiredKinds: readonly string[],
): string[] {
  const present = new Set(applicant.documents.map(doc => doc.kind))
  const required = new Set<string>(requiredKinds)
  // Insurance is conditional on the contractor declaring a personal vehicle, and the
  // submission route already enforced that; mirror it so verification agrees.
  if (applicant.contractorOnboarding?.usesPersonalVehicle) required.add('insurance')
  required.add('w9')
  required.add('contractor_agreement')
  return [...required].filter(kind => !present.has(kind as never))
}
