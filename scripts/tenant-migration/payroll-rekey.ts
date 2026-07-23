// ── Stable-id payroll rekey CLI ──────────────────────────────────────────────
//
// Closes the residual half of H-KEY-1: `Staff.payByBusiness` is keyed by the
// normalized business NAME, inside a JSON value where the tenancy chokepoint
// cannot reach it. A rename therefore silently drops every crew member's
// per-business pay override for that business — real money, no warning.
//
// This assigns each business an opaque stableId and ADDS a matching pay-override
// entry keyed by that id. It is the companion to migrate.ts and follows the same
// doctrine: copy-only, idempotent, conflict-detecting, and it NEVER deletes a
// legacy key — so `resolveCrewPay` keeps resolving through the name path until
// the owner chooses to cut over, and rollback is "delete the new keys".
//
// Usage:
//   npx tsx scripts/tenant-migration/payroll-rekey.ts <command> [--limit=500]
//
// Commands (safe by default — only `apply` mutates):
//   plan     Report what would change: ids to mint, overrides to add, skips. No writes.
//   apply    Mint ids + add stableId-keyed overrides. Guarded; never deletes.
//   verify   Confirm every legacy override has an equal stableId twin. No writes.
//
// Safety: `apply` refuses unless TENANT_MIGRATION_CONFIRM=1, and refuses against
// production (VERCEL_ENV=production) unless TENANT_MIGRATION_PROD_OVERRIDE=1 is
// ALSO set — deliberately the same two switches as migrate.ts, so an operator
// learns one rule. Reads and writes go through app/lib (the redis.ts chokepoint),
// not raw Upstash: this migration needs no SCAN, only the existing zset indexes.

import { planPayRekey, applyRekey, type BizIdentity, type StaffPayMap } from './payroll-lib'
// The plan matches on `Business.key`, which IS bizKey(name) already, so the legacy
// key builder is deliberately not needed here.
import { listBusinesses, ensureBusinessStableId, newBizId } from '../../app/lib/businesses'
import { listStaff, saveStaff } from '../../app/lib/staff'
import { createLogger } from '../../app/lib/platform/observability/logger'

const log = createLogger()

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : dflt
}

function assertMayMutate(): void {
  if (process.env.TENANT_MIGRATION_CONFIRM !== '1') {
    throw new Error('refusing to mutate: set TENANT_MIGRATION_CONFIRM=1 to allow writes')
  }
  if (process.env.VERCEL_ENV === 'production' && process.env.TENANT_MIGRATION_PROD_OVERRIDE !== '1') {
    throw new Error('refusing to run against PRODUCTION: set TENANT_MIGRATION_PROD_OVERRIDE=1 (separate explicit override)')
  }
}

async function load(limit: number): Promise<{ businesses: BizIdentity[]; staff: StaffPayMap[] }> {
  const [bs, ss] = await Promise.all([listBusinesses(limit), listStaff(limit)])
  return {
    businesses: bs.map((b) => ({ key: b.key, name: b.name, stableId: b.stableId })),
    staff: ss.map((s) => ({ id: s.id, name: s.name, payByBusiness: s.payByBusiness })),
  }
}

function report(plan: ReturnType<typeof planPayRekey>): void {
  log.info('payroll-rekey plan', {
    mintIds: plan.assignments.length,
    staffToUpdate: plan.rekeys.length,
    overridesToAdd: plan.rekeys.reduce((n, r) => n + Object.keys(r.add).length, 0),
    alreadyMigrated: plan.alreadyMigrated,
    skips: plan.skips.length,
    noop: plan.noop,
  })
  // Skips are the part an owner must actually read — they are the money this
  // migration deliberately refuses to touch.
  for (const s of plan.skips) log.warn('payroll-rekey skip', { staffId: s.staffId, legacyKey: s.legacyKey, reason: s.reason, detail: s.detail })
}

async function main(): Promise<void> {
  const cmd = process.argv[2]
  const limit = Number(arg('limit', '500')) || 500
  if (!cmd || !['plan', 'apply', 'verify'].includes(cmd)) {
    log.error('usage: payroll-rekey.ts <plan|apply|verify> [--limit=500]')
    process.exitCode = 1
    return
  }

  const { businesses, staff } = await load(limit)

  if (cmd === 'plan') {
    report(planPayRekey(businesses, staff, newBizId))
    return
  }

  if (cmd === 'verify') {
    // Every legacy override on a KNOWN business must have an equal stableId twin.
    const idByKey = new Map(businesses.filter((b) => b.stableId).map((b) => [b.key, b.stableId!]))
    const missing: { staffId: string; legacyKey: string }[] = []
    for (const s of staff) {
      for (const [k, v] of Object.entries(s.payByBusiness ?? {})) {
        const id = idByKey.get(k)
        if (!id) continue
        if (s.payByBusiness?.[id] !== v) missing.push({ staffId: s.id, legacyKey: k })
      }
    }
    log.info('payroll-rekey verify', { businessesWithId: idByKey.size, mismatched: missing.length, ok: missing.length === 0 })
    for (const m of missing) log.warn('payroll-rekey missing twin', m)
    if (missing.length) process.exitCode = 1
    return
  }

  assertMayMutate()
  const plan = planPayRekey(businesses, staff, newBizId)
  report(plan)
  if (plan.noop) { log.info('payroll-rekey apply: nothing to do'); return }

  // Businesses first: a staff override keyed by an id nobody holds would be dead
  // weight, whereas a business with an id and no override is simply not migrated yet.
  const records = await listBusinesses(limit)
  for (const a of plan.assignments) {
    const b = records.find((r) => r.key === a.key)
    if (!b) continue
    await ensureBusinessStableId(b, a.stableId)
  }

  const staffRecords = await listStaff(limit)
  for (const r of plan.rekeys) {
    const s = staffRecords.find((x) => x.id === r.staffId)
    if (!s) continue
    s.payByBusiness = applyRekey(s.payByBusiness, r.add)
    await saveStaff(s)
  }

  log.info('payroll-rekey apply complete', {
    businessesAssigned: plan.assignments.length,
    staffUpdated: plan.rekeys.length,
    legacyKeysDeleted: 0,
  })
}

main().catch((e) => {
  log.error('payroll-rekey failed', { error: e instanceof Error ? e.message : String(e) })
  process.exitCode = 1
})
