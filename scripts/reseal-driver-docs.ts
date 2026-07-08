/**
 * One-time migration: seal applicant identity documents that were uploaded before
 * encryption existed.
 *
 * Every identity document (Social Security card, driver's license, state ID) written
 * before `app/lib/doc-crypto.ts` landed sits in Vercel Blob as PLAINTEXT at a public
 * URL — readable forever by anyone who ever obtained the link. This re-seals them.
 *
 *   Dry run (default, writes nothing):
 *     npx tsx@4 scripts/reseal-driver-docs.ts
 *
 *   Apply:
 *     npx tsx@4 scripts/reseal-driver-docs.ts --apply
 *
 *   Also delete unreferenced plaintext blobs (uploads from abandoned applications):
 *     npx tsx@4 scripts/reseal-driver-docs.ts --apply --delete-orphans
 *
 * Requires BLOB_READ_WRITE_TOKEN, KV_REST_API_URL/TOKEN, and either
 * DOC_ENCRYPTION_KEY or ADMIN_SESSION_SECRET (same key the app uses).
 *
 * SAFETY. For each document we: fetch the plaintext → seal → upload the sealed
 * object → READ IT BACK AND VERIFY IT DECRYPTS TO THE EXACT ORIGINAL BYTES → update
 * the applicant record → only then delete the plaintext original. A failure at any
 * step leaves the original in place and the record untouched. Re-running is safe:
 * anything already sealed is skipped.
 *
 * Headshots are deliberately left alone — badge photos, no identity data, and they
 * flow into staff avatars on crew-facing screens.
 */
import { list, put, del } from '@vercel/blob'
import { listApplicants, saveApplicant, type Applicant } from '../app/lib/applicants'
import { sealDoc, openDoc, docCryptoReady } from '../app/lib/doc-crypto'
import { classify, pathnameOf, isPlaintextIdentityBlob } from '../app/lib/doc-migration'

const APPLY = process.argv.includes('--apply')
const DELETE_ORPHANS = process.argv.includes('--delete-orphans')

type Plan = { applicant: Applicant; kind: string; oldUrl: string; oldPath: string; newPath: string }

// Classification lives in lib/doc-migration.ts and is unit-tested there — this
// script owns only the I/O.
async function buildPlan(): Promise<{ plan: Plan[]; alreadySealed: number; skippedHeadshots: number }> {
  const applicants = await listApplicants(1000)
  const plan: Plan[] = []
  let alreadySealed = 0
  let skippedHeadshots = 0

  for (const a of applicants) {
    for (const doc of a.documents ?? []) {
      const c = classify(doc)
      if (c.action === 'skip') {
        if (c.reason === 'headshot') skippedHeadshots++
        else if (c.reason === 'already-sealed') alreadySealed++
        else if (c.reason === 'unparseable') console.warn(`  ⚠ ${a.applicantNumber} ${doc.kind}: unparseable url, skipping`)
        continue
      }
      plan.push({ applicant: a, kind: doc.kind, oldUrl: doc.url, oldPath: c.oldPath, newPath: c.newPath })
    }
  }
  return { plan, alreadySealed, skippedHeadshots }
}

async function reseal(p: Plan): Promise<'sealed' | 'failed'> {
  const label = `${p.applicant.applicantNumber} ${p.kind}`

  const res = await fetch(p.oldUrl)
  if (!res.ok) { console.error(`  ✖ ${label}: source fetch ${res.status}`); return 'failed' }
  const plaintext = Buffer.from(await res.arrayBuffer())

  if (!APPLY) { console.log(`  would seal ${label}  (${plaintext.length}B) → ${p.newPath}`); return 'sealed' }

  // 1. upload the sealed object
  const blob = await put(p.newPath, sealDoc(plaintext), {
    access: 'public', contentType: 'application/octet-stream', addRandomSuffix: false,
  })

  // 2. read it back and prove it decrypts to the exact original — before we destroy
  //    the only copy that currently exists.
  const check = Buffer.from(await (await fetch(blob.url)).arrayBuffer())
  const recovered = openDoc(check)
  if (!recovered.equals(plaintext)) {
    console.error(`  ✖ ${label}: round-trip MISMATCH — leaving the original in place`)
    await del(blob.url).catch(() => {})
    return 'failed'
  }

  // 3. point the record at the sealed object
  const doc = p.applicant.documents.find(d => d.kind === p.kind && d.url === p.oldUrl)
  if (!doc) { console.error(`  ✖ ${label}: doc vanished from record`); return 'failed' }
  doc.url = p.newPath
  await saveApplicant(p.applicant)

  // 4. and only now remove the plaintext
  await del(p.oldUrl)
  console.log(`  ✔ ${label}  (${plaintext.length}B) → ${p.newPath}`)
  return 'sealed'
}

/** Plaintext identity documents in the store that no applicant record references. */
async function findOrphans(referenced: Set<string>): Promise<string[]> {
  const out: string[] = []
  let cursor: string | undefined
  do {
    const page = await list({ prefix: 'driver-docs/', cursor, limit: 1000 })
    for (const b of page.blobs) {
      if (!isPlaintextIdentityBlob(b.pathname)) continue  // headshots + already-sealed
      if (referenced.has(b.pathname)) continue            // handled by the plan above
      out.push(b.url)
    }
    cursor = page.hasMore ? page.cursor : undefined
  } while (cursor)
  return out
}

async function main() {
  if (!docCryptoReady()) {
    console.error('No encryption key. Set DOC_ENCRYPTION_KEY or ADMIN_SESSION_SECRET.')
    process.exit(1)
  }
  console.log(APPLY ? '── APPLYING (writes to Blob + Redis) ──\n' : '── DRY RUN (nothing will be written) ──\n')

  const { plan, alreadySealed, skippedHeadshots } = await buildPlan()
  console.log(`applicant docs already sealed : ${alreadySealed}`)
  console.log(`headshots left public         : ${skippedHeadshots}`)
  console.log(`plaintext identity docs found : ${plan.length}\n`)

  let sealed = 0, failed = 0
  for (const p of plan) {
    if (await reseal(p) === 'sealed') sealed++
    else failed++
  }

  const referenced = new Set(plan.map(p => p.oldPath))
  const orphans = await findOrphans(referenced)
  console.log(`\nunreferenced plaintext identity blobs: ${orphans.length}`)
  for (const o of orphans) {
    if (APPLY && DELETE_ORPHANS) { await del(o); console.log(`  ✔ deleted orphan ${pathnameOf(o)}`) }
    else console.log(`  ${APPLY ? 'kept' : 'would delete'} ${pathnameOf(o)}  ${DELETE_ORPHANS ? '' : '(pass --delete-orphans)'}`)
  }

  console.log(`\n${APPLY ? 'sealed' : 'would seal'}: ${sealed}   failed: ${failed}   orphans: ${orphans.length}`)
  if (failed) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
