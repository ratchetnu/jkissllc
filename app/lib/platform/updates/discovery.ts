// ── Automatic Operion update discovery (PURE) ───────────────────────────────
//
// A merge or direct push to the source repository's main branch may CREATE a
// discovered update. It may never approve, package, dispatch, or publish one. The
// route authenticates the GitHub workflow before this module sees the payload; this
// module still validates every field because a valid signer must not be able to
// smuggle an unpinned ref or unsafe path into the release system of record.

import type {
  PlatformBusiness, PlatformUpdate, UpdatePriority, UpdateScope, UpdateSeverity, UpdateType, ValidationChecklist,
} from './types'
import { isSafeRepoPath } from '../automation/manifest'
import { isTargetOwned } from '../release/target-owned-paths'

export const DISCOVERY_MAX_FILES = 300

export type GitHubDiscoveryPayload = {
  deliveryId: string
  repository: string
  ref: string
  before: string
  after: string
  title: string
  commitMessage: string
  changedFiles: string[]
  changedFileCount: number
  filesTruncated: boolean
  pullRequestNumber?: number
  pullRequestUrl?: string
  workflowRunId?: string
}

const FULL_SHA = /^[0-9a-f]{40}$/i
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/
const CONVENTIONAL = /^([a-z]+)(?:\([^\r\n()]{1,80}\))?(!)?:\s*(.+)$/i

const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined

/**
 * An IDENTITY field is never truncated — it is refused.
 *
 * `text()` slices to a maximum, which is right for prose (a title, a commit body)
 * and wrong for anything that identifies a thing. A 41-character `after` was sliced
 * to 40 valid hex characters and accepted: the record would then name a DIFFERENT
 * commit than the one the sender wrote, and the length rule that was supposed to
 * enforce "exactly 40" would never have fired.
 */
const identity = (value: unknown, exact: number): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === exact ? trimmed : undefined
}

function safePullRequestUrl(value: unknown, repository: string, number: number | undefined): string | undefined {
  const raw = text(value, 300)
  if (!raw || number == null) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return undefined
    if (url.pathname !== `/${repository}/pull/${number}`) return undefined
    return url.toString()
  } catch { return undefined }
}

export function validateGitHubDiscoveryPayload(input: unknown):
  { ok: true; value: GitHubDiscoveryPayload } | { ok: false; reason: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'payload must be an object' }
  const obj = input as Record<string, unknown>
  const deliveryId = text(obj.deliveryId, 128)
  const repository = text(obj.repository, 200)
  const ref = text(obj.ref, 220)
  const before = identity(obj.before, 40)
  const after = identity(obj.after, 40)
  const title = text(obj.title, 200)
  const commitMessage = text(obj.commitMessage, 8000)
  if (!deliveryId || !/^[A-Za-z0-9:._-]+$/.test(deliveryId)) return { ok: false, reason: 'invalid deliveryId' }
  if (!repository || !REPOSITORY.test(repository)) return { ok: false, reason: 'invalid repository' }
  if (!ref || !REF.test(ref) || ref.includes('..') || ref.includes('//')) return { ok: false, reason: 'invalid ref' }
  if (!before || !FULL_SHA.test(before)) return { ok: false, reason: 'invalid before commit' }
  if (!after || !FULL_SHA.test(after) || /^0+$/.test(after)) return { ok: false, reason: 'invalid after commit' }
  if (!title) return { ok: false, reason: 'missing title' }
  if (!commitMessage) return { ok: false, reason: 'missing commitMessage' }

  if (!Array.isArray(obj.changedFiles) || obj.changedFiles.length > DISCOVERY_MAX_FILES) {
    return { ok: false, reason: 'invalid changedFiles' }
  }
  const changedFiles = obj.changedFiles
    .map((value) => text(value, 500))
    .filter((value): value is string => !!value)
  if (changedFiles.length !== obj.changedFiles.length || new Set(changedFiles).size !== changedFiles.length) {
    return { ok: false, reason: 'changedFiles must contain unique non-empty paths' }
  }
  if (changedFiles.some((path) => !isSafeRepoPath(path))) return { ok: false, reason: 'changedFiles contains an unsafe path' }
  const changedFileCount = obj.changedFileCount
  if (!Number.isSafeInteger(changedFileCount) || (changedFileCount as number) < changedFiles.length || (changedFileCount as number) > 100_000) {
    return { ok: false, reason: 'invalid changedFileCount' }
  }
  const filesTruncated = obj.filesTruncated === true
  if (filesTruncated !== ((changedFileCount as number) > changedFiles.length)) {
    return { ok: false, reason: 'filesTruncated does not match changedFileCount' }
  }

  let pullRequestNumber: number | undefined
  if (obj.pullRequestNumber !== undefined && obj.pullRequestNumber !== null) {
    if (!Number.isSafeInteger(obj.pullRequestNumber) || (obj.pullRequestNumber as number) < 1) {
      return { ok: false, reason: 'invalid pullRequestNumber' }
    }
    pullRequestNumber = obj.pullRequestNumber as number
  }
  const pullRequestUrl = safePullRequestUrl(obj.pullRequestUrl, repository, pullRequestNumber)
  if ((obj.pullRequestUrl !== undefined && obj.pullRequestUrl !== null) && !pullRequestUrl) {
    return { ok: false, reason: 'invalid pullRequestUrl' }
  }
  const workflowRunId = obj.workflowRunId === undefined ? undefined : text(obj.workflowRunId, 64)
  if (obj.workflowRunId !== undefined && !workflowRunId) return { ok: false, reason: 'invalid workflowRunId' }

  return {
    ok: true,
    value: {
      deliveryId, repository, ref, before, after, title, commitMessage, changedFiles,
      changedFileCount: changedFileCount as number, filesTruncated,
      pullRequestNumber, pullRequestUrl, workflowRunId,
    },
  }
}

export function discoveryMatchesSourceBusiness(
  payload: Pick<GitHubDiscoveryPayload, 'repository' | 'ref'>,
  business: Pick<PlatformBusiness, 'role' | 'repoName' | 'defaultBranch'>,
): boolean {
  return (business.role === 'source' || business.role === 'source_and_target') &&
    business.repoName?.toLowerCase() === payload.repository.toLowerCase() &&
    payload.ref === `refs/heads/${business.defaultBranch}`
}

function conventional(input: GitHubDiscoveryPayload): { kind?: string; breaking: boolean; title: string } {
  const subject = input.title.split(/\r?\n/, 1)[0].trim()
  const match = CONVENTIONAL.exec(subject)
  const bodyBreaking = /(^|\n)BREAKING[ -]CHANGE\s*:/i.test(input.commitMessage)
  if (!match) return { breaking: bodyBreaking, title: subject }
  return {
    kind: match[1].toLowerCase(),
    breaking: match[2] === '!' || bodyBreaking,
    title: match[3].trim(),
  }
}

function updateType(kind: string | undefined): UpdateType {
  switch (kind) {
    case 'feat': return 'feature'
    case 'fix': return 'bug_fix'
    case 'perf': return 'performance'
    case 'docs': return 'documentation'
    case 'security': return 'security'
    case 'style': case 'design': case 'ui': return 'design'
    case 'build': case 'ci': case 'chore': return 'infrastructure'
    default: return 'enhancement'
  }
}

function updateSeverity(type: UpdateType): UpdateSeverity {
  if (type === 'security') return 'high'
  if (type === 'documentation' || type === 'design') return 'low'
  return 'medium'
}

function updatePriority(type: UpdateType): UpdatePriority {
  return type === 'security' || type === 'emergency_hotfix' ? 'high' : 'normal'
}

function updateScope(files: string[]): UpdateScope {
  if (files.length > 0 && files.every((path) => path.startsWith('docs/') || /(^|\/)README/i.test(path))) return 'repository_specific'
  if (files.some((path) => path.startsWith('app/lib/platform/') || path.startsWith('app/api/automation/'))) return 'platform_core'
  if (files.some((path) => path.startsWith('app/lib/') || path.startsWith('app/components/'))) return 'shared_module'
  if (files.some((path) => /(^|\/)(?:\.env|vercel\.json|next\.config|tsconfig)/.test(path))) return 'environment_specific'
  return 'platform_core'
}

function moduleFromFiles(files: string[]): string | undefined {
  const source = files.find((path) => path.startsWith('app/')) ?? files[0]
  if (!source) return undefined
  const parts = source.split('/')
  return parts.slice(0, Math.min(parts.length - 1 || 1, 3)).join('/').slice(0, 120) || undefined
}

// ── Data-shape change detection ─────────────────────────────────────────────
//
// The previous rule required a PATH SEPARATOR before the word: `(^|\/)(migrations?
// |schema|prisma)(\/|\.|$)`. Every real migration in this repository is named with a
// HYPHEN — `wave6-migration.ts`, `token-backfill.ts`, `capability-backfill.ts`,
// `doc-migration.ts`, `open-punch-backfill.ts` — so not one of them matched. A commit
// changing any of them was classified `migrationRequired: false`, which additionally
// flipped `rollbackSupported` to true: the release ledger claimed a data change could
// be undone by redeploying the previous build.
//
// Two patterns, because the two vocabularies carry different risk of a false
// positive — and a flag that fires on the wrong things is one an owner learns to
// dismiss, which is worse than no flag.
//
//   MIGRATION words (`migration`, `migrate`, `backfill`) are unambiguous. Nothing
//   in this codebase is called `x-migration.ts` unless it migrates data, so a
//   hyphen or underscore separator is safe and is exactly what was being missed.
//
//   SCHEMA words are NOT. `analysis-schema.ts`, `analysis-schema-v2.ts` and
//   `confirmation-schema.ts` are AI RESPONSE shapes, not database ones. So `schema`
//   and `prisma` still require a real path separator: `prisma/schema.prisma`,
//   `app/lib/schema.ts`, `db/schema/…` match; a hyphen-suffixed response schema
//   does not.
//
// Documentation is excluded outright. `docs/operations/07-migration-safety-
// checklist.md` is a checklist ABOUT migrations, not a migration.
const DOCUMENTATION = /(^docs\/|\.mdx?$)/i
const DATA_MIGRATION = /(^|[/\-_])(migrations?|migrate|backfill)([/\-_.]|$)/i
const DATA_SCHEMA = /(^|\/)(schema|prisma)([/.]|$)/i

/** True when a changed path looks like it alters stored data. */
export function touchesStoredData(path: string): boolean {
  if (DOCUMENTATION.test(path)) return false
  return DATA_MIGRATION.test(path) || DATA_SCHEMA.test(path)
}

// ── Secret-introduction detection ───────────────────────────────────────────
//
// `secretRequired` used to be hardcoded false, so a commit that introduced a new
// credential without touching a `.env*` file set no owner-approval gate at all.
//
// This reads PATHS only — the discovery payload never carries file contents, and
// asking for them would put source code through a webhook. That is a real limit,
// and it is why the answer here is deliberately ASYMMETRIC: a positive is trusted,
// a negative is not. `secretRequired` false means "nothing in the file list said
// so", never "this change introduces no secret", and the record stays `discovered`
// with every validation field unknown precisely because a person still has to look.
const SECRET_SURFACE = /(^|[/\-_])(secrets?|credentials?|env-config|provider-config)([/\-_.]|$)/i

/** True when a changed path is where credentials are declared or consumed. */
export function touchesSecretSurface(path: string): boolean {
  if (DOCUMENTATION.test(path)) return false
  return SECRET_SURFACE.test(path)
}

const UNKNOWN_VALIDATION: ValidationChecklist = {
  typecheck: 'unknown', lint: 'unknown', tests: 'unknown', build: 'unknown',
  securityReview: 'unknown', accessibilityReview: 'unknown', e2e: 'unknown',
  smokeTest: 'unknown', ownerVerification: 'unknown',
}

export function discoveredUpdateFromGitHub(
  payload: GitHubDiscoveryPayload,
  input: { key: string; sourceBusinessId: string; sourceBranch: string; now: number },
): PlatformUpdate {
  const parsed = conventional(payload)
  const type = updateType(parsed.kind)
  const migrationRequired = payload.changedFiles.some(touchesStoredData)
  const environmentChangeRequired = payload.changedFiles.some((path) => /(^|\/)(?:\.env(?:\.|$)|env\.example$)/i.test(path))
  const secretRequired = payload.changedFiles.some(touchesSecretSurface)
  const featureFlagRequired = payload.changedFiles.some((path) => path === 'app/lib/platform/flags.ts')
  // A truncated file list is a list we cannot reason about. Classifying from a
  // sample and presenting the answer as if it covered the whole commit is the kind
  // of confident-but-wrong that this record exists to avoid, so an over-long commit
  // is treated as if it touched everything risky and is sent to a person.
  const unknownScope = payload.filesTruncated
  // Files this deployment will never transfer to a managed target: branding, the
  // identity module, deployment configuration. Consulted here only to DESCRIBE the
  // change honestly — the transfer-time exclusion in target-owned-paths.ts is
  // unchanged and remains the thing that actually withholds them.
  const targetOwned = payload.changedFiles.filter(isTargetOwned)
  const entirelyTargetOwned = payload.changedFiles.length > 0 && targetOwned.length === payload.changedFiles.length
  const pr = payload.pullRequestNumber ? `PR #${payload.pullRequestNumber}` : 'a direct push'
  const fileSummary = `${payload.changedFileCount} file${payload.changedFileCount === 1 ? '' : 's'} changed`
  const sample = payload.changedFiles.slice(0, 20).join(', ')
  return {
    recordVersion: 1,
    key: input.key,
    title: parsed.title.slice(0, 200),
    summary: entirelyTargetOwned
      ? `Automatically discovered when ${pr} landed on ${input.sourceBranch} · ${fileSummary}, all of them owned by each business (branding, identity or deployment configuration). Nothing here transfers to another business.`
      : `Automatically discovered when ${pr} landed on ${input.sourceBranch} · ${fileSummary}.`,
    description: payload.commitMessage,
    technicalImpact: sample ? `Changed paths: ${sample}${payload.filesTruncated || payload.changedFiles.length > 20 ? ', …' : ''}` : undefined,
    type,
    scope: updateScope(payload.changedFiles),
    severity: updateSeverity(type),
    priority: updatePriority(type),
    status: 'discovered',
    module: moduleFromFiles(payload.changedFiles),
    sourceBusinessId: input.sourceBusinessId,
    sourceRepo: payload.repository,
    sourceBranch: input.sourceBranch,
    sourceCommit: payload.after.toLowerCase(),
    sourceWorktreeDirty: false,
    pullRequest: payload.pullRequestUrl,
    breakingChange: parsed.breaking,
    migrationRequired: migrationRequired || unknownScope,
    environmentChangeRequired,
    secretRequired: secretRequired || unknownScope,
    featureFlagRequired,
    manualPortRequired: false,
    // Never claims a rollback is safe when the change may alter stored data.
    // Redeploying the previous build does not put the data back.
    rollbackSupported: !parsed.breaking && !migrationRequired && !unknownScope,
    validation: { ...UNKNOWN_VALIDATION },
    ownerNotes: [
      `Created automatically by Operion update discovery (${payload.deliveryId}). Review the classification and validation evidence before approval.`,
      migrationRequired ? 'Flagged as a data migration or backfill: it changes stored data, so rolling the code back will NOT undo it.' : '',
      secretRequired ? 'Touches a file where credentials are declared or read — confirm whether a new secret is needed.' : '',
      unknownScope ? `The changed-file list was truncated (${payload.changedFiles.length} of ${payload.changedFileCount} reported), so this classification is from a SAMPLE and the real scope is unknown. Treated as risky until a person reviews the full diff.` : '',
      targetOwned.length && !entirelyTargetOwned ? `${targetOwned.length} changed file(s) are owned by each business and are never transferred: ${targetOwned.slice(0, 5).join(', ')}.` : '',
      entirelyTargetOwned ? 'Every changed file is business-owned. There is nothing here to send to another business.' : '',
    ].filter(Boolean).join(' '),
    createdBy: 'github-actions',
    createdAt: input.now,
    updatedAt: input.now,
  }
}
