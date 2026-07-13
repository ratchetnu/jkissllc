// Pure validation for the owner "Modify Estimate" action. Shared so the API route
// and tests enforce identical rules: reason required, final > 0, no negatives,
// load min ≤ max, whole-number trips.

export type ModifyInput = {
  overriddenUsd?: number
  loadMin?: number
  loadMax?: number
  laborUsd?: number
  disposalUsd?: number
  trips?: number
  reason?: string
}

export type ModifyValidation = { ok: true } | { ok: false; error: string }

export function validateEstimateModification(i: ModifyInput): ModifyValidation {
  if (!i.reason || !i.reason.trim()) return { ok: false, error: 'A reason is required to modify the estimate.' }
  const final = Math.round(i.overriddenUsd ?? 0)
  if (!(final > 0)) return { ok: false, error: 'Enter a valid final quote amount greater than 0.' }
  const nonNeg: [string, number | undefined][] = [
    ['Load minimum', i.loadMin], ['Load maximum', i.loadMax],
    ['Labor', i.laborUsd], ['Disposal', i.disposalUsd], ['Trip count', i.trips],
  ]
  for (const [label, v] of nonNeg) if (v !== undefined && v < 0) return { ok: false, error: `${label} cannot be negative.` }
  if (i.loadMin !== undefined && i.loadMax !== undefined && i.loadMin > i.loadMax) {
    return { ok: false, error: 'Load minimum cannot exceed the maximum.' }
  }
  if (i.trips !== undefined && !Number.isInteger(i.trips)) return { ok: false, error: 'Trip count must be a whole number.' }
  return { ok: true }
}
