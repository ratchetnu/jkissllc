// Wave 6 migration runner. Idempotent; safe to re-run.
//
//   npx tsx scripts/wave6-backfill.ts --dry-run     # read-only report
//   npx tsx scripts/wave6-backfill.ts               # apply
//
// It writes to whichever KV the ambient KV_REST_API_* point at, so it refuses to run
// unless the target is stated explicitly — a migration that silently picks up
// .env.local and rewrites the wrong store is how a Production incident starts.
import { runWave6Backfill } from '../app/lib/platform/tenancy/wave6-migration'
import { kvHost } from '../app/lib/redis'

const dryRun = process.argv.includes('--dry-run')
const confirmed = process.argv.includes('--i-know-the-target')

async function main() {
  const host = kvHost()
  if (!host) {
    console.error('No KV configured (KV_REST_API_URL unset). Refusing to run.')
    process.exit(1)
  }
  console.log(`KV target : ${host}`)
  console.log(`Mode      : ${dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`)

  if (!dryRun && !confirmed) {
    console.error('\nRefusing to write without --i-know-the-target.')
    console.error('Re-run with --dry-run first, confirm the KV host above is the store you mean,')
    console.error('then re-run with --i-know-the-target to apply.')
    process.exit(1)
  }

  const report = await runWave6Backfill({ dryRun })
  console.log('\n' + JSON.stringify(report, null, 2))
  console.log(
    `\nusers: ${report.memberships.created} membership(s) ${dryRun ? 'would be created' : 'created'}, ` +
    `${report.memberships.existing} already present.`,
  )
}

main().catch((e) => { console.error('FAILED', e); process.exit(1) })
