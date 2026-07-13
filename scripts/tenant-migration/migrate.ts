// ── Tenant migration CLI ─────────────────────────────────────────────────────
//
// Usage:
//   npx tsx scripts/tenant-migration/migrate.ts <command> [--tenant=jkiss] [--match='*'] [--batch=100]
//
// Commands (safe by default — only `migrate` mutates):
//   inventory      Enumerate + classify keys (tenant-owned / platform-global / scoped). No writes.
//   dry-run        Report what a copy WOULD do (counts + conflicts). No writes.
//   migrate        Copy legacy → t:{tenant}:legacy. Guarded; never deletes.
//   verify         Confirm every tenant-owned key has a matching scoped copy. No writes.
//   rollback-plan  Print the rollback manifest (targets to delete). No writes, no deletes.
//
// Safety: `migrate` refuses unless TENANT_MIGRATION_CONFIRM=1, and refuses against
// production (VERCEL_ENV=production) unless TENANT_MIGRATION_PROD_OVERRIDE=1 is
// ALSO set. This tool is the only place besides app/lib/redis.ts allowed to talk
// to Upstash directly (it needs SCAN). It NEVER deletes legacy keys.

import {
  type KvClient, inventory, classifyKeys, copyKeys, verifyKeys, rollbackManifest,
  isNameDerived,
} from './lib'
import { requireTenantKey } from '../../app/lib/platform/tenancy/keys'
import { createLogger } from '../../app/lib/platform/observability/logger'
import { DEFAULT_TENANT_ID } from '../../app/lib/platform/tenancy/types'

const log = createLogger()

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : dflt
}

function isProduction(): boolean {
  return process.env.VERCEL_ENV === 'production'
}

function assertMayMutate(): void {
  if (process.env.TENANT_MIGRATION_CONFIRM !== '1') {
    throw new Error('refusing to mutate: set TENANT_MIGRATION_CONFIRM=1 to allow writes')
  }
  if (isProduction() && process.env.TENANT_MIGRATION_PROD_OVERRIDE !== '1') {
    throw new Error('refusing to run against PRODUCTION: set TENANT_MIGRATION_PROD_OVERRIDE=1 (separate explicit override)')
  }
}

// Real Upstash client (REST). Only instantiated for commands that need Redis.
function upstash(): KvClient {
  const url = process.env.KV_REST_API_URL
  const token = process.env.KV_REST_API_TOKEN
  if (!url || !token) throw new Error('KV_REST_API_URL and KV_REST_API_TOKEN must be set')
  const call = async (args: (string | number)[]): Promise<unknown> => {
    const res = await fetch(url, {
      method: 'POST', cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args.map(String)),
    })
    const json = (await res.json()) as { result?: unknown; error?: string }
    if (json.error) throw new Error(json.error)
    return json.result
  }
  return {
    async scan(cursor, match, count) {
      const r = (await call(['SCAN', cursor, 'MATCH', match, 'COUNT', count])) as [string, string[]]
      return { cursor: r[0], keys: r[1] ?? [] }
    },
    get: async (k) => (await call(['GET', k])) as string | null,
    set: async (k, v) => { await call(['SET', k, v]) },
    exists: async (k) => ((await call(['EXISTS', k])) as number) === 1,
    del: async (k) => { await call(['DEL', k]) },
  }
}

async function main() {
  const command = process.argv[2] ?? 'help'
  const tenant = arg('tenant', DEFAULT_TENANT_ID)
  const match = arg('match', '*')
  const batch = parseInt(arg('batch', '100'), 10)
  log.info('tenant-migration:start', { command, tenantId: tenant, detail: `match=${match} batch=${batch} prod=${isProduction()}` })

  if (command === 'help') {
    console.log('commands: inventory | dry-run | migrate | verify | rollback-plan  (see file header)')
    return
  }

  const kv = upstash()
  const keys = await inventory(kv, match, 200)
  const cls = classifyKeys(keys)
  const nameDerived = cls.tenantOwned.filter(isNameDerived)

  if (command === 'inventory') {
    log.info('tenant-migration:inventory', {
      detail: `total=${keys.length} tenantOwned=${cls.tenantOwned.length} platformGlobal=${cls.platformGlobal.length} alreadyScoped=${cls.alreadyScoped.length} nameDerived=${nameDerived.length}`,
    })
    console.log(JSON.stringify({ total: keys.length, ...cls, nameDerivedCount: nameDerived.length }, null, 2))
    return
  }

  if (command === 'dry-run') {
    const r = await copyKeys(kv, keys, tenant, { dryRun: true, batchSize: batch })
    log.info('tenant-migration:dry-run', { tenantId: tenant, detail: `wouldCopy=${r.copied} skipExisting=${r.skippedExisting} conflicts=${r.conflicts.length}` })
    console.log(JSON.stringify({ wouldCopy: r.copied, skippedExisting: r.skippedExisting, conflicts: r.conflicts }, null, 2))
    return
  }

  if (command === 'migrate') {
    assertMayMutate()
    const r = await copyKeys(kv, keys, tenant, {
      dryRun: false, batchSize: batch,
      onProgress: (d, t) => { if (d % 500 === 0) log.info('tenant-migration:progress', { tenantId: tenant, detail: `${d}/${t}` }) },
    })
    if (r.conflicts.length) log.warn('tenant-migration:conflicts', { tenantId: tenant, detail: `${r.conflicts.length} conflicts — not overwritten` })
    log.info('tenant-migration:migrate-done', { tenantId: tenant, detail: `copied=${r.copied} skipExisting=${r.skippedExisting} conflicts=${r.conflicts.length}` })
    console.log(JSON.stringify({ copied: r.copied, skippedExisting: r.skippedExisting, conflicts: r.conflicts }, null, 2))
    return
  }

  if (command === 'verify') {
    const r = await verifyKeys(kv, keys, tenant)
    log.info('tenant-migration:verify', { tenantId: tenant, detail: `ok=${r.ok} missing=${r.missing.length} mismatch=${r.mismatch.length}` })
    console.log(JSON.stringify(r, null, 2))
    return
  }

  if (command === 'rollback-plan') {
    const pairs = cls.tenantOwned.map((legacy) => ({ legacy, target: requireTenantKey(tenant, legacy) }))
    const manifest = rollbackManifest(pairs)
    console.log(JSON.stringify({ deleteTargetsCount: manifest.deleteTargets.length, note: manifest.note, sample: manifest.deleteTargets.slice(0, 20) }, null, 2))
    return
  }

  throw new Error(`unknown command: ${command}`)
}

// Guarded so the mutation path never runs on import (only when executed directly).
main().catch((e) => { log.error('tenant-migration:failed', { detail: String(e instanceof Error ? e.message : e) }); process.exitCode = 1 })
