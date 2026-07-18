// ── Platform baseline marker — parse + generate (pure) ───────────────────────
//
// A generic, platform-agnostic marker committed into EACH participating repo, recording
// which source-platform baseline that repo was last synced to. It is machine-generated
// during an approved platform sync and committed as part of that update — NEVER hand-
// edited. The Update Center reads it directly from GitHub to compute drift.
//
// This module only PARSES a marker read from a repo and GENERATES the marker content for
// a sync to write. It performs no I/O and writes to no repository itself.

import { BASELINE_COMPATIBILITY_VERSION, OPERION_PLATFORM_ID, type BaselineMarker } from './types'

/** Parse + validate marker JSON read from a repo. Returns null when malformed/foreign. */
export function parseBaselineMarker(text: string | null | undefined): BaselineMarker | null {
  if (!text) return null
  let obj: unknown
  try { obj = JSON.parse(text) } catch { return null }
  if (!obj || typeof obj !== 'object') return null
  const m = obj as Record<string, unknown>
  if (typeof m.platform !== 'string' || !m.platform) return null
  if (typeof m.baselineVersion !== 'string' || !m.baselineVersion) return null
  if (typeof m.baselineCommit !== 'string' || !m.baselineCommit) return null
  const generatedAt = typeof m.generatedAt === 'string' ? m.generatedAt : ''
  const compatibilityVersion = typeof m.compatibilityVersion === 'number' ? m.compatibilityVersion : 0
  return {
    platform: m.platform,
    baselineVersion: m.baselineVersion,
    baselineCommit: m.baselineCommit,
    generatedAt,
    compatibilityVersion,
  }
}

/**
 * Build a marker for a sync that brought a product up to `baselineCommit` / `baselineVersion`
 * of the source platform. `generatedAt` is supplied by the caller (deterministic in tests;
 * the wall clock in the CLI) — this function itself is pure.
 */
export function generateBaselineMarker(input: {
  baselineVersion: string
  baselineCommit: string
  generatedAt: string
  platform?: string
}): BaselineMarker {
  return {
    platform: input.platform ?? OPERION_PLATFORM_ID,
    baselineVersion: input.baselineVersion,
    baselineCommit: input.baselineCommit,
    generatedAt: input.generatedAt,
    compatibilityVersion: BASELINE_COMPATIBILITY_VERSION,
  }
}

/** Serialize a marker to the exact bytes committed to a repo (stable key order + newline). */
export function serializeBaselineMarker(m: BaselineMarker): string {
  return JSON.stringify(
    {
      platform: m.platform,
      baselineVersion: m.baselineVersion,
      baselineCommit: m.baselineCommit,
      generatedAt: m.generatedAt,
      compatibilityVersion: m.compatibilityVersion,
    },
    null,
    2,
  ) + '\n'
}

/** True when a marker belongs to the given platform + a compatible contract version. */
export function isCompatibleMarker(m: BaselineMarker, platform = OPERION_PLATFORM_ID): boolean {
  return m.platform === platform && m.compatibilityVersion <= BASELINE_COMPATIBILITY_VERSION
}
