// ── Operion Sandbox — canonical record contract (PURE) ───────────────────────
//
//   TEST ONLY / NON-PRODUCTION / SAFE TO RESET
//
// The single source of truth for the disposable operion-sandbox records, built to
// the EXACT schemas the Release Center reads today (updates/types.ts + sync/types.ts).
// Pure + deterministic (takes `now`) so the repair path and its tests share one shape.
// Mirrors scripts/seed-operion-sandbox.mjs but is the authoritative, type-checked copy.

import type { PlatformBusiness, PlatformUpdate, UpdateCompatibility } from '../updates/types'
import { PLATFORM_UPDATE_VERSION } from '../updates/types'
import type { SyncProduct, ReconciliationRecord } from '../sync/types'
import { SYNC_RECORD_VERSION } from '../sync/types'

export const SANDBOX_SLUG = 'operion-sandbox'
export const SANDBOX_UPDATE_KEY = 'SBX-011' // custom key — never touches the shared UPD counter
export const SANDBOX_CURRENT_VERSION = '0.1.0'
export const SANDBOX_AVAILABLE_VERSION = '0.1.1'
export const SANDBOX_REPO = 'ratchetnu/operion-sandbox'
export const SANDBOX_DEFAULT_BRANCH = 'main'
export const SANDBOX_WORKFLOW = 'operion-update.yml'
export const SANDBOX_VERCEL_PROJECT = 'operion-sandbox'
export const SANDBOX_PREVIEW_PROJECT_ID = 'prj_Uqxm4MMxZJzD3EwXgfACqnMsUeD4'
const MAIN_COMMIT = '4adfa8c54ff6546f69fdccafd893df6faa2c804f' // main @ 0.1.0
const SOURCE_COMMIT = 'a64f5385df305c0cb9d7df7d5d447bf41d458b93' // release/0.1.1-source

const PASS = {
  typecheck: 'passed', lint: 'passed', tests: 'passed', build: 'passed',
  securityReview: 'not_applicable', accessibilityReview: 'not_applicable',
  e2e: 'not_applicable', smokeTest: 'passed', ownerVerification: 'passed',
} as const

export type SandboxRecords = {
  business: PlatformBusiness
  update: PlatformUpdate
  compat: UpdateCompatibility
  product: SyncProduct
  reconciliation: ReconciliationRecord
}

/** Build the full canonical record set. `installationId` is optional + non-secret. */
export function buildSandboxRecords(now: number, installationId?: string): SandboxRecords {
  const business: PlatformBusiness = {
    recordVersion: PLATFORM_UPDATE_VERSION,
    id: SANDBOX_SLUG, name: 'Operion Sandbox — TEST ONLY', slug: SANDBOX_SLUG,
    industry: 'Sandbox / automation test', edition: 'sandbox',
    status: 'active', role: 'target',
    repoProvider: 'github', repoName: SANDBOX_REPO,
    repositoryOwner: 'ratchetnu', repositoryNameOnly: 'operion-sandbox',
    defaultBranch: SANDBOX_DEFAULT_BRANCH,
    deployProvider: 'vercel', deployProject: SANDBOX_VERCEL_PROJECT,
    healthEndpoint: '/api/health',
    currentVersion: SANDBOX_CURRENT_VERSION, currentCommit: MAIN_COMMIT,
    releaseChannel: 'beta', updatePolicy: 'owner_approval',
    updatesPaused: false, manualApprovalRequired: true, autoDeployAllowed: false,
    healthStatus: 'unknown',
    githubInstallationId: installationId,
    allowedTargetBranches: ['main'], automationWorkflowFile: SANDBOX_WORKFLOW,
    previewDeploymentProvider: 'vercel', previewProjectId: SANDBOX_PREVIEW_PROJECT_ID,
    requirePullRequest: true, requireOwnerApproval: true, requirePreview: true, requirePassingChecks: true,
    allowAutomatedMerge: false,        // never auto-merge
    allowProductionPromotion: false,   // never promote to production
    configurationStatus: installationId ? 'ready' : 'incomplete',
    notes: 'TEST ONLY / NON-PRODUCTION / SAFE TO RESET. Disposable Operion automation sandbox — not a customer business. Remove with scripts/reset-operion-sandbox.mjs.',
    createdAt: now, updatedAt: now,
  }

  const update: PlatformUpdate = {
    recordVersion: PLATFORM_UPDATE_VERSION,
    key: SANDBOX_UPDATE_KEY, title: 'Sandbox release 0.1.1',
    summary: 'Bumps the sandbox version from 0.1.0 to 0.1.1 (single-file change) to validate the Preview-only Update flow.',
    technicalImpact: 'Single-file change to lib/version.ts. No migrations, secrets, or external integrations.',
    type: 'enhancement', scope: 'platform_core', severity: 'low', priority: 'normal',
    status: 'approved', module: 'sandbox/version',
    sourceBusinessId: SANDBOX_SLUG, sourceRepo: SANDBOX_REPO,
    sourceBranch: 'release/0.1.1-source', sourceCommit: SOURCE_COMMIT,
    breakingChange: false, migrationRequired: false, environmentChangeRequired: false,
    secretRequired: false, featureFlagRequired: false, manualPortRequired: false, rollbackSupported: true,
    validation: { ...PASS },
    createdBy: 'owner', approvedBy: 'owner', approvedAt: now, createdAt: now, updatedAt: now,
  }

  const compat: UpdateCompatibility = {
    recordVersion: PLATFORM_UPDATE_VERSION,
    updateKey: SANDBOX_UPDATE_KEY, businessId: SANDBOX_SLUG,
    status: 'compatible', reason: 'Sandbox self-transfer: source and target are the same disposable repo.',
    assessedBy: 'owner', createdAt: now, updatedAt: now,
  }

  const product: SyncProduct = {
    recordVersion: SYNC_RECORD_VERSION,
    id: SANDBOX_SLUG, displayName: 'Operion Sandbox — TEST ONLY',
    productType: 'standalone', status: 'active',
    sourceProvider: 'github', githubOwner: 'ratchetnu', githubRepo: 'operion-sandbox',
    defaultBranch: SANDBOX_DEFAULT_BRANCH,
    deploymentProvider: 'vercel', vercelProject: SANDBOX_VERCEL_PROJECT,
    healthPath: '/api/health',
    platformSourceId: null,
    supportsPlatformSync: true, supportsDeploymentTracking: true,
    createdAt: now, updatedAt: now,
  }

  const reconciliation: ReconciliationRecord = {
    recordVersion: SYNC_RECORD_VERSION,
    id: `${SANDBOX_SLUG}:${now}`, productId: SANDBOX_SLUG, checkedAt: now, trigger: 'seed',
    platformSync: {
      applicable: true,
      currentBaselineVersion: SANDBOX_CURRENT_VERSION, currentBaselineCommit: MAIN_COMMIT,
      latestBaselineVersion: SANDBOX_AVAILABLE_VERSION, latestBaselineCommit: SOURCE_COMMIT,
      commitsBehind: 1, compatibility: 'compatible',
      updateAvailable: true, safeToSync: true, state: 'attention',
      detail: 'A newer sandbox version (0.1.1) is available.',
    },
    deployment: {
      applicable: true, gitConnected: true,
      deployedCommit: MAIN_COMMIT, mainCommit: MAIN_COMMIT, behindBy: 0, deployedAt: now,
      environment: 'preview', health: 'unknown', upToDate: true,
      commitLabel: MAIN_COMMIT.slice(0, 7), statusLabel: 'Up to date', state: 'ok',
    },
    ok: true, failed: false,
  }

  return { business, update, compat, product, reconciliation }
}

// ── Validity predicates — detect a MALFORMED existing record so repair overwrites it,
//    while a present-and-valid record is left untouched (idempotent, preserve valid). ──
export function sandboxBusinessValid(b: PlatformBusiness | null | undefined): boolean {
  return !!b && b.id === SANDBOX_SLUG && b.status === 'active' && b.role === 'target' &&
    b.currentVersion === SANDBOX_CURRENT_VERSION && b.allowProductionPromotion === false &&
    b.deployProject === SANDBOX_VERCEL_PROJECT && b.repoName === SANDBOX_REPO
}
export function sandboxProductValid(p: SyncProduct | null | undefined): boolean {
  return !!p && p.id === SANDBOX_SLUG && p.status === 'active' && p.supportsPlatformSync === true &&
    p.productType === 'standalone'
}
export function sandboxUpdateValid(u: PlatformUpdate | null | undefined): boolean {
  return !!u && u.key === SANDBOX_UPDATE_KEY && u.status === 'approved' && u.breakingChange === false &&
    u.rollbackSupported === true
}
export function sandboxReconciliationValid(r: ReconciliationRecord | null | undefined): boolean {
  return !!r && r.productId === SANDBOX_SLUG && r.platformSync?.applicable === true &&
    r.platformSync?.updateAvailable === true &&
    r.platformSync?.currentBaselineVersion === SANDBOX_CURRENT_VERSION &&
    r.platformSync?.latestBaselineVersion === SANDBOX_AVAILABLE_VERSION
}
export function sandboxCompatValid(c: UpdateCompatibility | null | undefined): boolean {
  return !!c && c.updateKey === SANDBOX_UPDATE_KEY && c.businessId === SANDBOX_SLUG && c.status === 'compatible'
}
