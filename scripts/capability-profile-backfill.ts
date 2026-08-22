import { loadEnvConfig } from '@next/env'

function valueFor(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd())
  const tenantId = (valueFor('tenant') ?? 'jkiss').trim().toLowerCase()
  const apply = process.argv.includes('--apply')
  const confirmation = valueFor('confirm')
  if (apply && confirmation !== tenantId) {
    throw new Error(`refusing write: use --apply --confirm=${tenantId}`)
  }

  const [{ backfillCapabilityProfile }, { describeBackfillPlan }] = await Promise.all([
    import('../app/lib/platform/capabilities/tenant-profile-store'),
    import('../app/lib/platform/capabilities/capability-backfill'),
  ])
  const result = await backfillCapabilityProfile(tenantId, {
    dryRun: !apply,
    actor: process.env.USER || 'capability-backfill-cli',
  })
  for (const warning of result.warnings) console.warn(`WARNING: ${warning}`)
  console.log(describeBackfillPlan(result.plan))
  console.log(result.written
    ? 'APPLIED: choices recorded; effective behavior preserved.'
    : result.alreadyInitialized
      ? 'NO-OP: profile was already initialized.'
      : 'DRY RUN: nothing was written.')
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
