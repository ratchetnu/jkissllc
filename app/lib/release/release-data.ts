// ── Release Center — curated static content (server-safe, no secrets) ─────────
//
// The read-only Release Center (/admin/operations/release) renders this alongside
// runtime build info (manifest.ts) and resolved feature-flag states (flag-view.ts).
//
// This is CURATED CONTENT, edited as a normal reviewed code change — NOT a live data
// store and NOT editable from the UI. It contains no secrets and no raw env values.
// Keep it aligned with docs/operations/16-release-notes.md (same schema + log).

export type CheckState = 'passed' | 'failed' | 'skipped' | 'pending' | 'not_applicable'

export type VerificationLine = {
  label: string
  state: CheckState
  note?: string
}

export type ReleaseEntry = {
  version: string
  /** Human release date (YYYY-MM-DD) or a draft label. Distinct from build deploy date. */
  date: string
  /** Where this note describes state. */
  environment: 'production' | 'preview' | 'development'
  summary: string
  highlights: string[]
  /** Flags introduced or flipped by this release, described in plain language. */
  flagChanges: string[]
  /** Migration summary + reversibility, or "None." */
  migrations: string
  knownIssues: string[]
  /** Release-specific rollback notes (see docs/operations/06-rollback-checklist.md). */
  rollback: string
  verification: VerificationLine[]
  /** True for the release this build currently represents. */
  current?: boolean
}

// Most-recent first. The first entry flagged `current` is the headline snapshot.
export const RELEASES: ReleaseEntry[] = [
  {
    version: '2026.07 — Update Center foundation',
    date: '2026-07-17',
    environment: 'preview',
    current: true,
    summary:
      'Operator documentation set + a read-only, admin-only Release Center. No operational workflow changed.',
    highlights: [
      'docs/operations/: architecture overview, repo map, environment matrix, and local / preview / production / rollback / migration checklists.',
      'Runbooks: incident response, AI processing, communications safety, Book Now, crew portal.',
      'Security checklist, parallel-session branch/worktree rules, and a canonical feature-flag inventory.',
      'Read-only Release Center at /admin/operations/release: current build/commit/environment, feature-flag states, and this release snapshot.',
    ],
    flagChanges: ['None — no flags introduced or flipped.'],
    migrations: 'None. The Release Center persists nothing; all data is static or derived.',
    knownIssues: [
      'Deployment commit/id/environment show only when Vercel build vars are present; otherwise the panel reads "unavailable" by design.',
      'Release history is curated in code (release-data.ts), not editable from the UI — intentional for a read-only surface.',
      'Naming overlap: the owner-only, write-capable console at /admin/operations/platform is historically also called "Update Center". This admin surface is the read-only Release Center and is complementary.',
    ],
    rollback:
      'Pure code rollback (promote the prior deployment). Nothing is persisted, so there is no data to unwind.',
    verification: [
      { label: 'TypeScript (tsc --noEmit)', state: 'pending', note: 'Run in Phase 4 of the sprint.' },
      { label: 'Lint (eslint)', state: 'pending' },
      { label: 'Unit tests (release-manifest + suite)', state: 'pending' },
      { label: 'Production build', state: 'pending' },
      { label: 'Authorization (admin-only, GET-only)', state: 'pending' },
      { label: 'Mobile layout', state: 'pending' },
      { label: 'Owner production verification', state: 'not_applicable', note: 'Not deployed by this sprint.' },
    ],
  },
]

// ── Migration status summary (see docs/operations/07) ─────────────────────────
export type MigrationSummary = {
  state: 'none_pending' | 'pending' | 'in_progress'
  headline: string
  detail: string
}

export const MIGRATION_STATUS: MigrationSummary = {
  state: 'none_pending',
  headline: 'No migrations pending',
  detail:
    'This app uses Redis/KV JSON records (no SQL). The Release Center introduces no record shape, key prefix, or tenancy change. Tenancy migration remains gated and off in production.',
}

// ── Standing known issues / limitations (surface-level, not release-specific) ──
export const KNOWN_ISSUES: string[] = [
  'Root README.md is stock create-next-app boilerplate and does not describe Operion — see docs/operations/README.md instead.',
  'VISION_ESTIMATION_SHADOW is retired: the flag name remains for compatibility but wires nothing and must stay OFF.',
  'vercel env pull redacts many production values to "" (notably every OPERION_* flag); a blank is redaction, not the real state.',
]
