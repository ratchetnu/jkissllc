// ── Capability registry validation ───────────────────────────────────────────
//
// Structural integrity checks so the registry can't drift into an inconsistent
// state: every dependency must resolve, nothing may depend on itself, the
// dependency graph must be acyclic, and the modelling rules that keep optional
// providers optional must hold. Run in tests (and callable at boot).

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
    for (const dep of c.softDependencies) {
      if (!ids.has(dep)) errors.push(`${c.id} soft-depends on unknown capability "${dep}"`)
      if (dep === c.id) errors.push(`${c.id} soft-depends on itself`)
      if (c.dependencies.includes(dep)) {
        errors.push(`${c.id} lists "${dep}" as BOTH a hard and a soft dependency — pick one`)
      }
    }

    // ── Provider-adapter modelling rules ──
    // These exist so the "core update blocked by a missing Stripe key" shape cannot
    // be re-introduced: anything that fronts an external provider must be optional,
    // and only such a thing may infer its default from credential presence.
    if (c.provider && c.kind !== 'optional') {
      errors.push(`${c.id} adapts provider "${c.provider}" but is kind "${c.kind}" — a provider adapter must be optional`)
    }
    if (c.defaultSelection === 'auto' && !c.provider) {
      errors.push(`${c.id} uses defaultSelection "auto" without a provider — auto means "enabled iff the provider's credentials are present"`)
    }
    if (!c.tenantConfigurable && c.defaultSelection !== 'enabled') {
      errors.push(`${c.id} is not tenant-configurable, so its default must be "enabled" (got "${c.defaultSelection}") — otherwise it can never be turned on`)
    }
    if (!c.tenantConfigurable && c.kind !== 'core') {
      errors.push(`${c.id} is not tenant-configurable but is kind "${c.kind}" — only core capabilities may be mandatory`)
    }
  }

  // Cycle detection over the HARD graph (DFS with colors). Soft edges are advisory
  // and are deliberately excluded: "invoicing works better with payments, which
  // works better with Stripe" is not a cycle risk and must not constrain modelling.
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

  // The shipped defaults must themselves be a legal configuration. Without this a
  // brand-new tenant could be seeded straight into a state the profile validator
  // then refuses to save.
  const defaultOn = (c: Capability) => c.defaultSelection !== 'disabled'
  for (const c of Object.values(reg)) {
    if (!defaultOn(c)) continue
    for (const dep of c.dependencies) {
      const d = reg[dep]
      if (d && !defaultOn(d)) {
        errors.push(`default profile is not closed: ${c.id} defaults on but its hard dependency ${dep} defaults off`)
      }
    }
  }

  return [...new Set(errors)]
}

export function assertValidCapabilityRegistry(
  reg: Record<CapabilityId, Capability> = CAPABILITY_REGISTRY,
): void {
  const errors = validateCapabilityRegistry(reg)
  if (errors.length) throw new Error(`invalid capability registry:\n- ${errors.join('\n- ')}`)
}
