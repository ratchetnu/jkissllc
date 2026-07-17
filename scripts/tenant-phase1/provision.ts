// ── Phase-1 provisioning CLI ─────────────────────────────────────────────────
//
// Deterministic, reversible backfill of the reference tenant (J KISS LLC): its
// registry record, the owner membership, and the tenant-scoped branding record.
// Safe by default — only `apply` and `rollback` mutate, and both are guarded.
//
// Usage:
//   npx tsx scripts/tenant-phase1/provision.ts <command>
//
//   plan           Print the exact ordered writes an apply WOULD make. No Redis, no writes.
//   rollback-plan  Print the exact deletes a rollback WOULD make.       No Redis, no writes.
//   apply          Idempotently write the seeds. Guarded; conflict-safe (never overwrites).
//   verify         Confirm every seeded record exists and equals its seed. No writes.
//   rollback       Delete ONLY the seeded targets. Guarded. Never touches legacy keys.
//
// Guards (mirror scripts/tenant-migration): a mutating command refuses unless
// TENANT_PHASE1_CONFIRM=1, and refuses against production (VERCEL_ENV=production)
// unless TENANT_PHASE1_PROD_OVERRIDE=1 is ALSO set. Reads/writes go through the app
// Redis client (app/lib/redis.ts) — the isolation chokepoint — so no direct Upstash
// access and no bypass. The plan names physical keys that are either platform-global
// or already tenant-scoped, so `scopeKey` leaves them unchanged regardless of flag.

import { redis } from '../../app/lib/redis'
import {
  type PhaseKv, buildProvisionPlan, applyPlan, verifyPlan, executeRollback,
} from './lib'

const kv: PhaseKv = {
  get: (k) => redis.get(k),
  set: (k, v) => redis.set(k, v),
  del: (k) => redis.del(k),
  zadd: (k, s, m) => redis.zadd(k, s, m),
  zrem: (k, m) => redis.zrem(k, m),
}

function isProduction(): boolean {
  return process.env.VERCEL_ENV === 'production'
}

function assertMayMutate(): void {
  if (process.env.TENANT_PHASE1_CONFIRM !== '1') {
    throw new Error('refusing to mutate: set TENANT_PHASE1_CONFIRM=1 to allow writes')
  }
  if (isProduction() && process.env.TENANT_PHASE1_PROD_OVERRIDE !== '1') {
    throw new Error('refusing to run against PRODUCTION: set TENANT_PHASE1_PROD_OVERRIDE=1 (separate explicit override)')
  }
}

function printPlan(): void {
  const plan = buildProvisionPlan()
  console.log(`# provision plan — tenant "${plan.tenantId}" (${plan.writes.length} writes)`)
  for (const w of plan.writes) {
    if (w.op === 'set') console.log(`SET   ${w.key} = ${w.value}`)
    else console.log(`ZADD  ${w.key} ${w.score} ${w.member}`)
  }
}

function printRollbackPlan(): void {
  const plan = buildProvisionPlan()
  console.log(`# rollback plan — tenant "${plan.tenantId}" (${plan.rollback.length} deletes) — legacy keys untouched`)
  for (const u of plan.rollback) {
    if (u.op === 'del') console.log(`DEL   ${u.key}`)
    else console.log(`ZREM  ${u.key} ${u.member}`)
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'plan'
  const plan = buildProvisionPlan()

  switch (cmd) {
    case 'plan':
      printPlan()
      return
    case 'rollback-plan':
      printRollbackPlan()
      return
    case 'apply': {
      assertMayMutate()
      const res = await applyPlan(kv, plan)
      console.log(`applied=${res.applied} skipped=${res.skipped} conflicts=${res.conflicts.length}`)
      if (res.conflicts.length) {
        console.error('CONFLICTS (existing values differ — NOT overwritten):')
        for (const c of res.conflicts) console.error(`  ${c.key}`)
        process.exitCode = 1
      }
      return
    }
    case 'verify': {
      const res = await verifyPlan(kv, plan)
      console.log(`ok=${res.ok} missing=${res.missing.length} mismatched=${res.mismatched.length}`)
      for (const k of res.missing) console.error(`  MISSING ${k}`)
      for (const k of res.mismatched) console.error(`  MISMATCH ${k}`)
      if (!res.ok) process.exitCode = 1
      return
    }
    case 'rollback': {
      assertMayMutate()
      const n = await executeRollback(kv, plan)
      console.log(`rolled back ${n} targets (legacy keys untouched)`)
      return
    }
    default:
      console.error(`unknown command: ${cmd}`)
      console.error('commands: plan | rollback-plan | apply | verify | rollback')
      process.exitCode = 2
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})
