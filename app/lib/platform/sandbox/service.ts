// ── Operion Sandbox — diagnose + repair service ──────────────────────────────
//
// Runs INSIDE the deployment, so `redis` (and every store fn below) reads/writes
// the deployment's own KV — the correct Preview store on a Preview deploy. All I/O
// is injected via `deps` so tests exercise the logic against an in-memory fake with
// zero network. Diagnose is read-only; repair writes ONLY the operion-sandbox keys
// and proves the live-business records are byte-identical before and after.

import { getBusiness, saveBusiness, getUpdate, saveUpdate, getCompatMap, saveCompat, listBusinesses } from '../updates/store'
import { getProduct, saveProduct, getLatest, saveReconciliation, listProducts } from '../sync/store'
import { buildBusinessReleaseViews } from '../release/projection'
import type { PlatformBusiness, PlatformUpdate, UpdateCompatibility } from '../updates/types'
import type { SyncProduct, ReconciliationRecord } from '../sync/types'
import {
  SANDBOX_SLUG, SANDBOX_UPDATE_KEY,
  buildSandboxRecords, sandboxBusinessValid, sandboxProductValid, sandboxUpdateValid,
  sandboxReconciliationValid, sandboxCompatValid,
} from './records'

// ── Injected I/O surface (defaults = the real stores → the deployment's KV) ──
export type SandboxDeps = {
  getBusiness: (id: string) => Promise<PlatformBusiness | null>
  saveBusiness: (b: PlatformBusiness) => Promise<void>
  getProduct: (id: string) => Promise<SyncProduct | null>
  saveProduct: (p: SyncProduct) => Promise<unknown>
  getLatest: (id: string) => Promise<ReconciliationRecord | null>
  saveReconciliation: (r: ReconciliationRecord) => Promise<void>
  getUpdate: (key: string) => Promise<PlatformUpdate | null>
  saveUpdate: (u: PlatformUpdate) => Promise<void>
  getCompatMap: (key: string) => Promise<Record<string, UpdateCompatibility>>
  saveCompat: (c: UpdateCompatibility) => Promise<void>
  listBusinesses: (limit?: number) => Promise<PlatformBusiness[]>
  listProducts: () => Promise<SyncProduct[]>
  buildViews: () => Promise<Awaited<ReturnType<typeof buildBusinessReleaseViews>>>
}

export const liveDeps: SandboxDeps = {
  getBusiness, saveBusiness, getProduct, saveProduct, getLatest, saveReconciliation,
  getUpdate, saveUpdate, getCompatMap, saveCompat, listBusinesses, listProducts,
  buildViews: buildBusinessReleaseViews,
}

// ── Live-record integrity fingerprint (non-sensitive) ────────────────────────
// A stable, content-free fingerprint (djb2 over the JSON) so we can prove a record
// is unchanged WITHOUT ever returning or logging its contents.
function fp(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(16)
}
async function liveFingerprints(deps: SandboxDeps): Promise<Record<string, string>> {
  const [biz, prods] = await Promise.all([deps.listBusinesses(500), deps.listProducts()])
  const out: Record<string, string> = {}
  for (const b of biz) if (b.id !== SANDBOX_SLUG) out[`business:${b.id}`] = fp(JSON.stringify(b))
  for (const p of prods) if (p.id !== SANDBOX_SLUG) out[`product:${p.id}`] = fp(JSON.stringify(p))
  return out
}

// ── Diagnostics (read-only, safe payload) ────────────────────────────────────
export type SandboxDiagnostics = {
  environment: string
  records: {
    business: 'present' | 'malformed' | 'missing'
    product: 'present' | 'malformed' | 'missing'
    reconciliation: 'present' | 'malformed' | 'missing'
    update: 'present' | 'malformed' | 'missing'
    compat: 'present' | 'malformed' | 'missing'
  }
  queryReturnsSandbox: boolean
  currentVersion: string | null
  availableVersion: string | null
  resolvedStatus: string | null
  resolvedAction: string | null
  visibleBusinesses: { id: string; name: string }[]  // owner's own products — safe
  needsRepair: boolean
  notes: string[]
}

const rstate = (present: boolean, valid: boolean) => (!present ? 'missing' : valid ? 'present' : 'malformed') as 'present' | 'malformed' | 'missing'

export async function diagnose(environment: string, deps: SandboxDeps = liveDeps): Promise<SandboxDiagnostics> {
  const [business, product, latest, update, compatMap, views] = await Promise.all([
    deps.getBusiness(SANDBOX_SLUG), deps.getProduct(SANDBOX_SLUG), deps.getLatest(SANDBOX_SLUG),
    deps.getUpdate(SANDBOX_UPDATE_KEY), deps.getCompatMap(SANDBOX_UPDATE_KEY), deps.buildViews(),
  ])
  const compat = compatMap[SANDBOX_SLUG] ?? null
  const row = views.find((v) => v.id === SANDBOX_SLUG) ?? null

  const records = {
    business: rstate(!!business, sandboxBusinessValid(business)),
    product: rstate(!!product, sandboxProductValid(product)),
    reconciliation: rstate(!!latest, sandboxReconciliationValid(latest)),
    update: rstate(!!update, sandboxUpdateValid(update)),
    compat: rstate(!!compat, sandboxCompatValid(compat)),
  }
  const anyBad = Object.values(records).some((s) => s !== 'present')

  const notes: string[] = []
  if (!product) notes.push('The sync-product record is missing — the Businesses list iterates sync products, so the sandbox cannot appear without it.')
  if (!row && product) notes.push('The sync-product exists but the Businesses query did not return the sandbox — check status/edition filters.')
  if (row && row.status !== 'update_available') notes.push(`Resolved status is "${row.statusLabel}", not "Update available".`)

  return {
    environment,
    records,
    queryReturnsSandbox: !!row,
    currentVersion: row?.installedVersion ?? business?.currentVersion ?? null,
    availableVersion: row?.latestVersion ?? null,
    resolvedStatus: row?.statusLabel ?? null,
    resolvedAction: row?.actionLabel ?? null,
    visibleBusinesses: views.map((v) => ({ id: v.id, name: v.name })),
    needsRepair: anyBad || !row,
    notes,
  }
}

// ── Repair (writes ONLY operion-sandbox keys) ────────────────────────────────
export type RepairResult = {
  keysWritten: string[]
  keysUnchanged: string[]
  integrity: { liveRecordsBefore: number; liveRecordsAfter: number; liveRecordsUnchanged: boolean; changedNonSandbox: string[] }
  diagnostics: SandboxDiagnostics
}

export async function repair(environment: string, now: number, deps: SandboxDeps = liveDeps): Promise<RepairResult> {
  const before = await liveFingerprints(deps)
  const canonical = buildSandboxRecords(now)
  const written: string[] = []
  const unchanged: string[] = []

  // Each record: overwrite only if missing or malformed; a present-and-valid record
  // is preserved. Every write targets a single operion-sandbox / SBX-011 key.
  const [curBiz, curProd, curLatest, curUpd, curCompatMap] = await Promise.all([
    deps.getBusiness(SANDBOX_SLUG), deps.getProduct(SANDBOX_SLUG), deps.getLatest(SANDBOX_SLUG),
    deps.getUpdate(SANDBOX_UPDATE_KEY), deps.getCompatMap(SANDBOX_UPDATE_KEY),
  ])

  if (!sandboxBusinessValid(curBiz)) { await deps.saveBusiness(canonical.business); written.push('platform:business:operion-sandbox') }
  else unchanged.push('platform:business:operion-sandbox')

  if (!sandboxProductValid(curProd)) { await deps.saveProduct(canonical.product); written.push('platform:sync:product:operion-sandbox') }
  else unchanged.push('platform:sync:product:operion-sandbox')

  if (!sandboxReconciliationValid(curLatest)) { await deps.saveReconciliation(canonical.reconciliation); written.push('platform:sync:latest:operion-sandbox') }
  else unchanged.push('platform:sync:latest:operion-sandbox')

  if (!sandboxUpdateValid(curUpd)) { await deps.saveUpdate(canonical.update); written.push('platform:update:SBX-011') }
  else unchanged.push('platform:update:SBX-011')

  if (!sandboxCompatValid(curCompatMap[SANDBOX_SLUG])) { await deps.saveCompat(canonical.compat); written.push('platform:compat:SBX-011') }
  else unchanged.push('platform:compat:SBX-011')

  const after = await liveFingerprints(deps)
  const changedNonSandbox: string[] = []
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[k] !== after[k]) changedNonSandbox.push(k)
  }

  return {
    keysWritten: written,
    keysUnchanged: unchanged,
    integrity: {
      liveRecordsBefore: Object.keys(before).length,
      liveRecordsAfter: Object.keys(after).length,
      liveRecordsUnchanged: changedNonSandbox.length === 0,
      changedNonSandbox,
    },
    diagnostics: await diagnose(environment, deps),
  }
}
