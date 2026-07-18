// ── Operion Sandbox — diagnostics health label (PURE) ────────────────────────
//
// The "Advanced · Sandbox" panel used to show "Sandbox missing" for anything that
// wasn't exactly "Update available" — so a healthy sandbox mid-lifecycle (Updating…,
// Ready to publish) or a failed-but-present one read as "missing". This resolves a
// present sandbox across ALL valid lifecycle states and distinguishes four cases.
// PURE — no I/O; the release-state resolver + primary action logic are untouched.

export type SandboxHealth = 'missing' | 'present' | 'ready' | 'attention'

export const SANDBOX_HEALTH_LABEL: Record<SandboxHealth, string> = {
  missing: 'Sandbox missing',        // no sandbox record exists
  present: 'Sandbox present',        // record exists (e.g. mid-flow / not set up)
  ready: 'Sandbox ready',            // healthy + ready for testing or publishing
  attention: 'Sandbox needs attention', // record exists but the workflow failed
}

// Green / amber / red / grey chip tones (fg + bg), matching the Release Center palette.
export const SANDBOX_HEALTH_TONE: Record<SandboxHealth, { fg: string; bg: string }> = {
  ready: { fg: '#86efac', bg: 'rgba(34,197,94,.16)' },
  present: { fg: '#94a3b8', bg: 'rgba(255,255,255,.06)' },
  attention: { fg: '#fcd34d', bg: 'rgba(245,158,11,.15)' },
  missing: { fg: '#fca5a5', bg: 'rgba(239,68,68,.16)' },
}

type RecordState = 'present' | 'malformed' | 'missing'
export type SandboxHealthInput = {
  records: { business: RecordState; product: RecordState; reconciliation: RecordState; update: RecordState; compat: RecordState }
  queryReturnsSandbox: boolean
  resolvedStatus: string | null
}

// Statuses that mean "healthy + ready to test or publish".
const READY_STATUSES = new Set(['up to date', 'update available', 'ready to publish', 'preview ready'])
// Statuses that mean "record exists but something needs the owner".
const ATTENTION_STATUSES = new Set(['verification failed', 'action required'])

/** Resolve the sandbox's health from a diagnostics snapshot. */
export function sandboxHealth(d: SandboxHealthInput | null | undefined): SandboxHealth {
  if (!d) return 'missing'
  // "Record exists" if the sync product or business record is there, or the Businesses
  // query returned the sandbox — true across every mid-lifecycle state.
  const recordExists = d.queryReturnsSandbox || d.records.product !== 'missing' || d.records.business !== 'missing'
  if (!recordExists) return 'missing'

  const s = (d.resolvedStatus ?? '').trim().toLowerCase()
  if (ATTENTION_STATUSES.has(s) || s.includes('failed')) return 'attention'
  if (READY_STATUSES.has(s)) return 'ready'
  // Present but not "ready": e.g. Updating… (Checking/Preparing/Deploying/Verifying Preview),
  // Not set up, or a malformed-but-present record.
  return 'present'
}
