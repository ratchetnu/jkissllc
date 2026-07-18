// ── Deliberate-action framework — pure logic (no React, no domain) ───────────
//
// Increment 3B.2A. The testable core behind the reusable high-consequence-action
// components (TypedConfirm / DeliberateActionDrawer / RiskBanner / EligibilityChecklist).
// Knows nothing about publishing, promotion, GitHub, or Vercel — it is generic UI logic.

// ── Typed confirmation ───────────────────────────────────────────────────────
/** Does the typed value satisfy the required confirmation phrase? Trims both sides;
 *  case-sensitive by default (a deliberate, exact match — e.g. a business name). */
export function matchesConfirmation(input: string | undefined | null, required: string | undefined | null, opts: { caseSensitive?: boolean } = {}): boolean {
  const a = (input ?? '').trim()
  const b = (required ?? '').trim()
  if (!b) return false // never satisfied by an empty requirement
  return opts.caseSensitive === false ? a.toLowerCase() === b.toLowerCase() : a === b
}

// ── Risk levels ──────────────────────────────────────────────────────────────
export type RiskLevel = 'info' | 'warning' | 'destructive' | 'success'

export type RiskPresentation = { fg: string; bg: string; border: string; role: 'status' | 'alert'; icon: 'info' | 'warning' | 'danger' | 'success' }

/** Presentation for a risk level. Problems (warning/destructive) announce as role="alert";
 *  info/success are role="status". Colors come from the design-system status tokens. */
export function riskPresentation(level: RiskLevel): RiskPresentation {
  switch (level) {
    case 'destructive': return { fg: 'var(--status-bad-fg)', bg: 'var(--status-bad-bg)', border: 'var(--status-bad-fg)', role: 'alert', icon: 'danger' }
    case 'warning': return { fg: 'var(--status-warn-fg)', bg: 'var(--status-warn-bg)', border: 'var(--status-warn-fg)', role: 'alert', icon: 'warning' }
    case 'success': return { fg: 'var(--status-good-fg)', bg: 'var(--status-good-bg)', border: 'var(--status-good-fg)', role: 'status', icon: 'success' }
    case 'info': default: return { fg: 'var(--status-info-fg)', bg: 'var(--status-info-bg)', border: 'var(--status-info-fg)', role: 'status', icon: 'info' }
  }
}

// ── Eligibility checklist ─────────────────────────────────────────────────────
export type ChecklistState = 'pass' | 'warn' | 'fail'
export type ChecklistItem = { label: string; state: ChecklistState; detail?: string }

/** Screen-reader word for a checklist state (never color-only). */
export function checklistStateLabel(state: ChecklistState): string {
  return state === 'pass' ? 'Passed' : state === 'warn' ? 'Warning' : 'Failed'
}
/** Decorative glyph for a checklist state (rendered aria-hidden). */
export function checklistStateGlyph(state: ChecklistState): string {
  return state === 'pass' ? '✓' : state === 'warn' ? '⚠' : '✕'
}
export function checklistStateColor(state: ChecklistState): string {
  return state === 'pass' ? 'var(--status-good-fg)' : state === 'warn' ? 'var(--status-warn-fg)' : 'var(--status-bad-fg)'
}

export type ChecklistSummary = { total: number; passed: number; warnings: number; failed: number; allPassed: boolean }
export function summarizeChecklist(items: ChecklistItem[]): ChecklistSummary {
  const passed = items.filter((i) => i.state === 'pass').length
  const warnings = items.filter((i) => i.state === 'warn').length
  const failed = items.filter((i) => i.state === 'fail').length
  return { total: items.length, passed, warnings, failed, allPassed: failed === 0 && items.length > 0 }
}

// ── Deliberate-action gating ──────────────────────────────────────────────────
/** Is the confirm action allowed to fire? Requires a match, not loading, and (if a
 *  checklist is supplied) no hard failures. Pure — the component mirrors this. */
export function canConfirmDeliberateAction(input: {
  confirmed: boolean            // typed value matched (or no typed-confirm required → true)
  loading?: boolean
  blockingFailures?: number     // e.g. checklist failed count
}): boolean {
  if (!input.confirmed) return false
  if (input.loading) return false
  if ((input.blockingFailures ?? 0) > 0) return false
  return true
}
