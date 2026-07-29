// Wave 6C migration runner — bind public tokens issued before the binding index.
// Idempotent; safe to re-run. Reads inside ONE named tenant and never scans others.
//
//   npx tsx scripts/wave6c-token-backfill.ts --tenant jkiss --dry-run
//   npx tsx scripts/wave6c-token-backfill.ts --tenant jkiss --i-know-the-target
//
// Refuses to write until the operator has seen the KV host it printed — a migration
// that silently picks up the wrong store is how a Production incident starts.
import { backfillTokenBindings } from '../app/lib/platform/tenancy/token-backfill'
import { kvHost } from '../app/lib/redis'

const argv = process.argv
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const dryRun = argv.includes('--dry-run')
const confirmed = argv.includes('--i-know-the-target')
const tenant = arg('--tenant')

async function main() {
  const host = kvHost()
  if (!host) { console.error('No KV configured (KV_REST_API_URL unset). Refusing to run.'); process.exit(1) }
  if (!tenant) { console.error('--tenant <id> is required. The tenant is never inferred.'); process.exit(1) }

  console.log(`KV target : ${host}`)
  console.log(`Tenant    : ${tenant}`)
  console.log(`Mode      : ${dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`)

  if (!dryRun && !confirmed) {
    console.error('\nRefusing to write without --i-know-the-target.')
    console.error('Re-run with --dry-run first, confirm the KV host above, then apply.')
    process.exit(1)
  }

  const report = await backfillTokenBindings(tenant, { dryRun })
  console.log('\n' + JSON.stringify(report, null, 2))

  if (report.conflicts.length) {
    console.error(`\n${report.conflicts.length} CONFLICT(S): tokens already bound to a different tenant.`)
    console.error('Ownership is ambiguous — resolve by hand. Nothing was overwritten.')
    process.exit(2)
  }
  console.log(`\n${report.bound} token(s) ${dryRun ? 'would be bound' : 'bound'}, ${report.alreadyBound} already present.`)
}

main().catch((e) => { console.error('FAILED', e); process.exit(1) })
