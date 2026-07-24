// ── maintenance.flag executor (narrow, internal-only) ────────────────────────
//
// The previously-dormant `maintenance.flag` AI action, made real — WITHOUT building a
// general workflow engine. It evaluates fleet maintenance state (pure) and records an
// INTERNAL flag per equipment that needs attention. Idempotent: a record is written only
// when a status actually changed, and recovered equipment has its flag cleared, so
// re-running with unchanged state is a no-op. Tenant-scoped by construction — listEquipment
// and the fleet:flag:* keys route through the redis chokepoint. It NEVER sends external
// SMS/email; the flags are surfaced in the fleet maintenance UI only.

import { redis } from '../redis'
import { listEquipment } from '../equipment'
import { evaluateFleetFlags, type FleetFlag } from './maintenance'

const FLAG_KEY = (id: string) => `fleet:flag:${id}`

export type MaintenanceFlagRun = { evaluated: number; flagged: number; changed: number; flags: FleetFlag[] }

export async function runMaintenanceFlag(now = Date.now()): Promise<MaintenanceFlagRun> {
  const equipments = await listEquipment(500)
  const flags = evaluateFleetFlags(equipments, now)
  const active = new Map(flags.map((f) => [f.equipmentId, f.status]))
  let changed = 0

  // Upsert current flags — write only on an actual status change (idempotent replay).
  for (const f of flags) {
    const prev = await redis.get(FLAG_KEY(f.equipmentId))
    if (prev !== f.status) { await redis.set(FLAG_KEY(f.equipmentId), f.status); changed++ }
  }
  // Clear flags for equipment that recovered since the last run.
  for (const e of equipments) {
    if (active.has(e.id)) continue
    if (await redis.get(FLAG_KEY(e.id))) { await redis.del(FLAG_KEY(e.id)); changed++ }
  }

  return { evaluated: equipments.length, flagged: flags.length, changed, flags }
}
