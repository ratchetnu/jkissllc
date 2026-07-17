// ── Release Center — snapshot assembler (read-only, no secrets) ──────────────
//
// Combines three safe sources into one read-only snapshot for the Release Center:
//   1. Runtime build info from NON-SECRET Vercel build vars (graceful fallback).
//   2. Curated static release content (release-data.ts).
//   3. Redaction-safe feature-flag view (flag-view.ts).
//
// It reads NO secret env var and returns NO raw env value — build info is limited to
// the handful of non-secret Vercel vars below, and everything else is static/derived.

import { RELEASES, MIGRATION_STATUS, KNOWN_ISSUES, type ReleaseEntry, type MigrationSummary } from './release-data'
import { buildFlagViews, flagSummary, type FlagView } from './flag-view'

export type Environment = 'production' | 'preview' | 'development' | 'local'

export type BuildInfo = {
  environment: Environment
  /** Full commit SHA when known, else null. */
  commitSha: string | null
  /** 7-char short SHA when known, else null. */
  commitShort: string | null
  deploymentId: string | null
  deploymentUrl: string | null
  /** Deploy date is not exposed by a Vercel env var — null unless the current release provides one. */
  deployDate: string | null
  /** False when running outside a Vercel deployment (local) — the UI shows a graceful fallback. */
  available: boolean
}

export type ReleaseSnapshot = {
  generatedAt: number
  build: BuildInfo
  current: ReleaseEntry | null
  history: ReleaseEntry[]
  flags: FlagView[]
  flagSummary: ReturnType<typeof flagSummary>
  migration: MigrationSummary
  knownIssues: string[]
}

// The ONLY env vars this module reads. All are non-secret Vercel build metadata.
const SAFE_BUILD_KEYS = ['VERCEL_ENV', 'VERCEL_GIT_COMMIT_SHA', 'VERCEL_DEPLOYMENT_ID', 'VERCEL_URL'] as const

function resolveEnvironment(raw: string | undefined): Environment {
  switch ((raw ?? '').toLowerCase()) {
    case 'production': return 'production'
    case 'preview': return 'preview'
    case 'development': return 'development'
    default: return 'local'
  }
}

/**
 * Derive build info from an env map (defaults to process.env). Pure + deterministic so
 * it is unit-testable and gracefully degrades: with none of the Vercel vars present it
 * returns `available: false` and null metadata rather than throwing or inventing data.
 */
export function deriveBuildInfo(
  env: Record<string, string | undefined> = process.env,
  deployDate: string | null = null,
): BuildInfo {
  const sha = env.VERCEL_GIT_COMMIT_SHA?.trim() || null
  const deploymentId = env.VERCEL_DEPLOYMENT_ID?.trim() || null
  const url = env.VERCEL_URL?.trim() || null
  const environment = resolveEnvironment(env.VERCEL_ENV)
  const available = SAFE_BUILD_KEYS.some((k) => !!env[k]?.trim())
  return {
    environment,
    commitSha: sha,
    commitShort: sha ? sha.slice(0, 7) : null,
    deploymentId,
    deploymentUrl: url,
    deployDate,
    available,
  }
}

/** Current release = the first entry flagged `current`, else the newest, else null. */
export function currentRelease(releases: ReleaseEntry[] = RELEASES): ReleaseEntry | null {
  return releases.find((r) => r.current) ?? releases[0] ?? null
}

/**
 * Assemble the full read-only snapshot. `now` is injectable for deterministic tests.
 */
export function getReleaseSnapshot(
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now(),
): ReleaseSnapshot {
  const current = currentRelease()
  const build = deriveBuildInfo(env, current?.date ?? null)
  const flags = buildFlagViews(env)
  return {
    generatedAt: now,
    build,
    current,
    history: RELEASES.filter((r) => r !== current),
    flags,
    flagSummary: flagSummary(flags),
    migration: MIGRATION_STATUS,
    knownIssues: KNOWN_ISSUES,
  }
}
