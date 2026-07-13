// ── Stable, non-name-derived ids ─────────────────────────────────────────────
//
// Future key generation for entities currently keyed by user-facing strings
// (business name → bizKey, promo code, BOL, phone) must use OPAQUE stable ids so
// a display-name change never moves the record or crosses a boundary. Legacy
// name-derived keys are kept for compatibility; the migration maps name → id.
// See docs/opspilot-os/tenant-isolation/07-name-derived-key-migration.md.

import { randomUUID } from 'node:crypto'

export function stableId(prefix = 'id'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`
}

export function isStableId(s: string): boolean {
  return /^[a-z][a-z0-9]*_[a-f0-9]{32}$/.test(s)
}

/**
 * True when a string looks like it was DERIVED FROM a user-facing label (spaces,
 * uppercase, '@', punctuation) — i.e. unsafe to use as an identity boundary.
 */
export function looksNameDerived(s: string): boolean {
  return /[\sA-Z@]/.test(s) || s.length === 0
}
