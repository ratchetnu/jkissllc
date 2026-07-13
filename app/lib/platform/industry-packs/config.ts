// ── Layered configuration resolver ───────────────────────────────────────────
//
// Effective value = location/service override → tenant → industry-pack → platform.
// One resolver so no call site hand-merges (and drifts). Mirrors how disposal.ts
// already merges a Redis blob over typed defaults, generalized across layers.
// Typed, section-scoped, and validated by the caller's schema — never a giant
// free-form JSON blob (see 06-industry-module-strategy.md §3).

export type ConfigLayers<T> = {
  platform?: Partial<T>
  pack?: Partial<T>
  tenant?: Partial<T>
  override?: Partial<T> // location / service level
}

/** Highest-precedence layer wins per key. Later spreads override earlier ones. */
export function resolveConfig<T extends object>(base: T, layers: ConfigLayers<T>): T {
  return {
    ...base,
    ...(layers.platform ?? {}),
    ...(layers.pack ?? {}),
    ...(layers.tenant ?? {}),
    ...(layers.override ?? {}),
  }
}

/** The precedence order, most specific first — for documentation/tests. */
export const CONFIG_PRECEDENCE = ['override', 'tenant', 'pack', 'platform'] as const
