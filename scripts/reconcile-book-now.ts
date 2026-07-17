// Existing-data reconciliation runner — DRY-RUN by default, READ-ONLY.
//
//   npx tsx scripts/reconcile-book-now.ts            # dry run: classify + counts
//   npx tsx scripts/reconcile-book-now.ts --json     # dry run, machine-readable
//   npx tsx scripts/reconcile-book-now.ts --apply     # (no-op) explains why
//
// Requires KV_REST_API_URL + KV_REST_API_TOKEN in the environment (pull from the
// Preview/Production Vercel project). It NEVER writes: Book Now already persists a
// canonical Booking, so there is no safe automatic conversion to perform — this
// tool reports classification only, and ambiguous/duplicate records are surfaced
// for owner review, never auto-touched.
import { listBookings } from '../app/lib/bookings'
import { reconcile, RECON_CLASS_LABEL, type ReconClass } from '../app/lib/schedule/reconcile'

const ORDER: ReconClass[] = [
  'request_only', 'accepted_but_unscheduled', 'scheduled_and_linked',
  'scheduled_but_missing_job', 'duplicate', 'completed', 'cancelled', 'ambiguous',
]

async function main() {
  const json = process.argv.includes('--json')
  const apply = process.argv.includes('--apply')

  let bookings
  try {
    bookings = await listBookings(5000)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg === 'UPSTASH_NOT_CONFIGURED') {
      console.error('KV not configured. Set KV_REST_API_URL + KV_REST_API_TOKEN (pull from the Vercel project) and retry.')
      process.exit(2)
    }
    throw e
  }

  const report = reconcile(bookings, Date.now())

  if (json) { console.log(JSON.stringify(report, null, 2)); return }

  console.log('\n  Book Now ↔ Operations reconciliation — DRY RUN (read-only)')
  console.log(`  Scanned ${report.total} booking record(s)\n`)
  for (const cls of ORDER) {
    const n = report.counts[cls]
    console.log(`  ${String(n).padStart(4)}  ${RECON_CLASS_LABEL[cls]}`)
  }
  if (report.reviewRequired.length) {
    console.log(`\n  ${report.reviewRequired.length} record(s) need owner review (never auto-touched):`)
    for (const r of report.reviewRequired) {
      console.log(`    ${r.number}  ${r.class}  ${r.customer}  ${r.status}${r.date ? `  ${r.date}` : ''}`)
    }
  }
  if (apply) {
    console.log('\n  --apply: no automatic conversions performed.')
    console.log('  Book Now requests are ALREADY canonical Operations jobs (source:online), so there')
    console.log('  is nothing to back-fill. Ambiguous + duplicate records are left for owner review.')
  } else {
    console.log('\n  Dry run only. Nothing was written.')
  }
  console.log('')
}

main().catch(e => { console.error(e); process.exit(1) })
