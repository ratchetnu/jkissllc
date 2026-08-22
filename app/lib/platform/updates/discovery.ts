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
  const before = text(obj.before, 40)
  const after = text(obj.after, 40)
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
  const migrationRequired = payload.changedFiles.some((path) => /(^|\/)(migrations?|schema|prisma)(\/|\.|$)/i.test(path))
  const environmentChangeRequired = payload.changedFiles.some((path) => /(^|\/)(?:\.env(?:\.|$)|env\.example$)/i.test(path))
  const featureFlagRequired = payload.changedFiles.some((path) => path === 'app/lib/platform/flags.ts')
  const pr = payload.pullRequestNumber ? `PR #${payload.pullRequestNumber}` : 'a direct push'
  const fileSummary = `${payload.changedFileCount} file${payload.changedFileCount === 1 ? '' : 's'} changed`
  const sample = payload.changedFiles.slice(0, 20).join(', ')
  return {
    recordVersion: 1,
    key: input.key,
    title: parsed.title.slice(0, 200),
    summary: `Automatically discovered when ${pr} landed on ${input.sourceBranch} · ${fileSummary}.`,
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
    migrationRequired,
    environmentChangeRequired,
    secretRequired: false,
    featureFlagRequired,
    manualPortRequired: false,
    rollbackSupported: !parsed.breaking && !migrationRequired,
    validation: { ...UNKNOWN_VALIDATION },
    ownerNotes: `Created automatically by Operion update discovery (${payload.deliveryId}). Review the classification and validation evidence before approval.`,
    createdBy: 'github-actions',
    createdAt: input.now,
    updatedAt: input.now,
  }
}
