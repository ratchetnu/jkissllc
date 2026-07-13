// ── Capability registry validation ───────────────────────────────────────────
//
// Structural integrity checks so the registry can't drift into an inconsistent
// state: every dependency must resolve, nothing may depend on itself, and the
// dependency graph must be acyclic. Run in tests (and callable at boot).

import type { Capability, CapabilityId } from './types'
import { CAPABILITY_REGISTRY } from './registry'

export function validateCapabilityRegistry(
  reg: Record<CapabilityId, Capability> = CAPABILITY_REGISTRY,
): string[] {
  const errors: string[] = []
  const ids = new Set(Object.keys(reg))

  for (const [key, c] of Object.entries(reg)) {
    if (c.id !== key) errors.push(`registry key "${key}" != capability id "${c.id}"`)
    for (const dep of c.dependencies) {
      if (!ids.has(dep)) errors.push(`${c.id} depends on unknown capability "${dep}"`)
      if (dep === c.id) errors.push(`${c.id} depends on itself`)
    }
  }

  // Cycle detection (DFS with colors).
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<string, number>()
  for (const id of ids) color.set(id, WHITE)
  const visit = (id: string, stack: string[]): void => {
    color.set(id, GRAY)
    for (const dep of reg[id as CapabilityId]?.dependencies ?? []) {
      if (!color.has(dep)) continue // missing dep already reported above
      if (color.get(dep) === GRAY) errors.push(`dependency cycle: ${[...stack, id, dep].join(' → ')}`)
      else if (color.get(dep) === WHITE) visit(dep, [...stack, id])
    }
    color.set(id, BLACK)
  }
  for (const id of ids) if (color.get(id) === WHITE) visit(id, [])

  return [...new Set(errors)]
}

export function assertValidCapabilityRegistry(
  reg: Record<CapabilityId, Capability> = CAPABILITY_REGISTRY,
): void {
  const errors = validateCapabilityRegistry(reg)
  if (errors.length) throw new Error(`invalid capability registry:\n- ${errors.join('\n- ')}`)
}
