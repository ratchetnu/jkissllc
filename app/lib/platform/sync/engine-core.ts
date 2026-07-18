// ── Reconciliation engine — pure decision core ───────────────────────────────
//
// Given RAW facts already fetched from providers, decide the two status signals. No
// I/O here, so every rule is deterministic and unit-testable. The orchestrator
// (engine.ts) fetches the facts via the provider abstraction and calls these.

import type { BaselineMarker, DeploymentStatus, PlatformSyncStatus } from './types'

export function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : ''
}

// ── Signal 2: Deployment Status (live deploy vs own repo main) ───────────────
export type DeploymentFacts = {
  supportsTracking: boolean
  gitConnected: boolean
  deployedCommit?: string
  mainCommit?: string
  behindBy?: number
  deployedAt?: number
  environment?: 'production' | 'preview' | 'unknown'
  healthy?: boolean            // from a health probe; undefined ⇒ not probed / unknown
  error?: string               // a hard provider error (deploy or main read failed)
}

export function computeDeploymentStatus(f: DeploymentFacts): DeploymentStatus {
  const environment = f.environment ?? 'unknown'
  const health: DeploymentStatus['health'] = f.healthy === true ? 'healthy' : f.healthy === false ? 'down' : 'unknown'

  if (!f.supportsTracking) {
    return {
      applicable: false, gitConnected: false, environment, health: 'unknown',
      upToDate: false, commitLabel: '—', statusLabel: 'Not tracked', state: 'not_applicable',
      detail: 'Deployment tracking is disabled for this product.',
    }
  }

  if (f.error) {
    return {
      applicable: true, gitConnected: f.gitConnected, environment, health,
      upToDate: false, commitLabel: 'Unknown', statusLabel: 'Unknown', state: 'unknown', error: f.error,
    }
  }

  // CLI / non-git deployment — EXPECTED, not an error.
  if (!f.gitConnected) {
    return {
      applicable: true, gitConnected: false, environment, health,
      deployedAt: f.deployedAt, upToDate: true,
      commitLabel: 'N/A (CLI Deployment)', statusLabel: 'Verified', state: 'ok',
      detail: 'Non-git deployment — commit comparison is not applicable.',
    }
  }

  // Git-connected: compare deployed commit to main.
  if (f.deployedCommit && f.mainCommit) {
    const behindBy = f.behindBy ?? (sameCommit(f.deployedCommit, f.mainCommit) ? 0 : undefined)
    const upToDate = behindBy === 0 || sameCommit(f.deployedCommit, f.mainCommit)
    return {
      applicable: true, gitConnected: true, environment, health,
      deployedCommit: f.deployedCommit, mainCommit: f.mainCommit, behindBy, deployedAt: f.deployedAt,
      upToDate,
      commitLabel: shortSha(f.deployedCommit),
      statusLabel: upToDate ? 'Up to date' : behindBy != null ? `Behind by ${behindBy}` : 'Behind',
      state: upToDate ? 'ok' : 'attention',
    }
  }

  return {
    applicable: true, gitConnected: true, environment, health,
    deployedCommit: f.deployedCommit, mainCommit: f.mainCommit, deployedAt: f.deployedAt,
    upToDate: false, commitLabel: f.deployedCommit ? shortSha(f.deployedCommit) : 'Unknown',
    statusLabel: 'Unknown', state: 'unknown',
    detail: 'Insufficient deployment/repository data to compare.',
  }
}

function sameCommit(a: string, b: string): boolean {
  if (!a || !b) return false
  return a === b || a.startsWith(b) || b.startsWith(a)
}

// ── Signal 1: Platform Sync Status (vs configured source baseline) ───────────
export type PlatformSyncFacts = {
  supportsSync: boolean
  sourceConfigured: boolean        // a resolvable source product with a repo
  markerFound: boolean
  marker?: BaselineMarker | null   // the product repo's marker (its current baseline)
  latestBaselineVersion?: string   // the source's latest baseline version
  latestBaselineCommit?: string    // the source repo's main HEAD
  commitsBehind?: number           // source commits the product hasn't taken
  compatibility?: 'compatible' | 'needs_changes' | 'blocked' | 'unknown'
  error?: string
}

export function computePlatformSyncStatus(f: PlatformSyncFacts): PlatformSyncStatus {
  if (!f.supportsSync) {
    return {
      applicable: false, compatibility: 'unknown', updateAvailable: false, safeToSync: false,
      state: 'not_applicable', detail: 'This product does not track a platform source.',
    }
  }
  if (f.error) {
    return {
      applicable: true, compatibility: 'unknown', updateAvailable: false, safeToSync: false,
      state: 'unknown', error: f.error,
    }
  }
  if (!f.sourceConfigured) {
    return {
      applicable: true, compatibility: 'unknown', updateAvailable: false, safeToSync: false,
      state: 'unknown', detail: 'No resolvable platform source is configured.',
    }
  }

  const currentBaselineVersion = f.marker?.baselineVersion
  const currentBaselineCommit = f.marker?.baselineCommit
  const latestBaselineVersion = f.latestBaselineVersion
  const latestBaselineCommit = f.latestBaselineCommit

  if (!f.markerFound) {
    return {
      applicable: true, currentBaselineVersion, currentBaselineCommit, latestBaselineVersion, latestBaselineCommit,
      compatibility: 'unknown', updateAvailable: true, safeToSync: false, state: 'attention',
      detail: 'No baseline marker found in the product repository — never synced from the source.',
    }
  }

  if (f.commitsBehind == null) {
    return {
      applicable: true, currentBaselineVersion, currentBaselineCommit, latestBaselineVersion, latestBaselineCommit,
      compatibility: 'unknown', updateAvailable: false, safeToSync: false, state: 'unknown',
      detail: 'Could not determine how many commits behind the source this product is.',
    }
  }

  const updateAvailable = f.commitsBehind > 0
  // Up to date ⇒ trivially compatible. Behind ⇒ compatibility is 'unknown' until a
  // dedicated compatibility analysis runs, unless the caller supplied one.
  const compatibility = f.compatibility ?? (updateAvailable ? 'unknown' : 'compatible')
  const safeToSync = updateAvailable && compatibility === 'compatible'
  return {
    applicable: true, currentBaselineVersion, currentBaselineCommit, latestBaselineVersion, latestBaselineCommit,
    commitsBehind: f.commitsBehind, compatibility, updateAvailable, safeToSync,
    state: updateAvailable ? 'attention' : 'ok',
    detail: updateAvailable ? `${f.commitsBehind} source commit(s) not yet synced.` : 'Current with the platform source.',
  }
}
