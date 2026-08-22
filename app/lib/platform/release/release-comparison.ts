// ── Source release vs. managed target — the comparison an owner reads (PURE) ─
//
// Everything here already existed somewhere: the transfer manifest knows the files,
// the update record knows whether there is a migration or a new setting, the
// capability impact knows what will be dormant, and the target's own evidence knows
// what it is running. What did not exist was one place that puts them side by side.
//
// Without that, deciding whether to ship meant opening four screens and holding the
// answer in your head — which is how "it needed a database change" gets noticed
// after the deployment rather than before it.
//
// Four kinds of difference, deliberately named separately because they carry
// different risk and different remedies:
//
//   code           Files that will change. Reversible by rollback.
//   schema         Stored-data changes. NOT reversible by redeploying the old build.
//   configuration  New settings or secrets the target will need.
//   capability     Optional features affected — never a blocker, often a surprise.

import type { PlatformUpdate, TargetDeploymentEvidence } from '../updates/types'
import type { UpdateApplicability } from '../automation/target-evidence'
import type { SourceArtifact } from './source-artifact'

export type DifferenceKind = 'code' | 'schema' | 'configuration' | 'capability'

export type ReleaseDifference = {
  kind: DifferenceKind
  /** One line, plain language. */
  summary: string
  /** Specific items — file paths, variable NAMES, capability ids. Never values. */
  items: string[]
  /**
   * True when this difference cannot be undone by putting the previous build back.
   * Only ever schema, and it is the single most important thing on this screen.
   */
  irreversible: boolean
}

export type ReleaseComparison = {
  source: { repo: string; commit: string; updateKey: string; title: string }
  target: {
    businessId: string
    name: string
    /** What the target last reported it was running. Absent = it has never said. */
    commit?: string
    buildId?: string
    reportedAt?: number
  }
  /** True when the target already reports the exact commit this update ships. */
  alreadyOnThisCommit: boolean
  differences: ReleaseDifference[]
  /** The one sentence to put above the list. */
  headline: string
}

const commitEq = (a?: string, b?: string): boolean => {
  const x = (a ?? '').toLowerCase(), y = (b ?? '').toLowerCase()
  return !!x && !!y && (x.startsWith(y) || y.startsWith(x))
}

export type ComparisonInput = {
  artifact: SourceArtifact
  update: Pick<PlatformUpdate,
    'key' | 'title' | 'migrationRequired' | 'environmentChangeRequired' | 'secretRequired' | 'rollbackSupported' | 'capabilityImpact'
  >
  business: { id: string; name: string }
  /** Repository-relative paths the transfer would write. */
  changedPaths?: string[]
  /** Paths deliberately NOT sent (target-owned branding, config, tenant data). */
  excludedPaths?: string[]
  capabilityImpact?: UpdateApplicability | null
  targetEvidence?: TargetDeploymentEvidence | null
}

export function buildReleaseComparison(input: ComparisonInput): ReleaseComparison {
  const differences: ReleaseDifference[] = []
  const changed = input.changedPaths ?? []
  const excluded = input.excludedPaths ?? []

  if (changed.length) {
    differences.push({
      kind: 'code',
      summary: `${changed.length} file${changed.length === 1 ? '' : 's'} will change on ${input.business.name}.`,
      items: changed.slice(0, 50),
      irreversible: false,
    })
  }

  if (excluded.length) {
    differences.push({
      kind: 'configuration',
      // This is the reassurance an owner actually wants before pressing the button:
      // not "what will change" but "what will NOT be touched".
      summary: `${excluded.length} target-owned file${excluded.length === 1 ? '' : 's'} will be left alone (branding, configuration and anything tenant-specific).`,
      items: excluded.slice(0, 50),
      irreversible: false,
    })
  }

  if (input.update.migrationRequired) {
    differences.push({
      kind: 'schema',
      summary: 'This changes stored data. Putting the previous build back will NOT undo it.',
      items: ['a data migration runs as part of this update'],
      irreversible: true,
    })
  }

  const configItems: string[] = []
  if (input.update.environmentChangeRequired) configItems.push('a setting has to change on the target')
  if (input.update.secretRequired) configItems.push('a new secret has to be added on the target')
  for (const r of input.capabilityImpact?.activationRequirements ?? []) {
    // Variable NAMES only — a requirement never carries a value.
    if (r.kind === 'provider_credential' && r.reference) configItems.push(`${r.capability} needs ${r.reference}`)
  }
  if (configItems.length) {
    differences.push({
      kind: 'configuration',
      summary: 'Some of this will not do anything until a setting is added on the target.',
      items: configItems,
      irreversible: false,
    })
  }

  const affected = input.capabilityImpact?.affectedCapabilities ?? []
  if (affected.length || input.capabilityImpact?.dormant) {
    const byId = new Map((input.targetEvidence?.capabilities ?? []).map((c) => [c.capability, c]))
    differences.push({
      kind: 'capability',
      summary: input.capabilityImpact?.dormant
        ? 'Every optional feature this touches is switched off on the target, so it installs and waits.'
        : 'Optional features this update touches.',
      items: affected.map((id) => {
        const c = byId.get(id)
        if (!c) return `${id} — the target has not reported this one`
        if (!c.enabled) return `${id} — switched off there; the code installs and stays dormant`
        if (c.configured === false) return `${id} — switched on there but not finished${c.missingVars?.length ? ` (needs ${c.missingVars.join(', ')})` : ''}`
        return `${id} — live there; this takes effect on arrival`
      }),
      irreversible: false,
    })
  }

  const alreadyOnThisCommit = commitEq(input.targetEvidence?.commit, input.artifact.commit)

  return {
    source: {
      repo: `${input.artifact.repo.owner}/${input.artifact.repo.name}`,
      commit: input.artifact.commit,
      updateKey: input.update.key,
      title: input.update.title,
    },
    target: {
      businessId: input.business.id,
      name: input.business.name,
      commit: input.targetEvidence?.commit,
      buildId: input.targetEvidence?.buildId,
      reportedAt: input.targetEvidence?.recordedAt,
    },
    alreadyOnThisCommit,
    differences,
    headline: alreadyOnThisCommit
      ? `${input.business.name} already reports this exact build — there is nothing to send.`
      : differences.some((d) => d.irreversible)
        ? `${input.business.name} will change, and one of those changes cannot be undone by rolling back.`
        : differences.length
          ? `${input.business.name} will change in ${differences.length} way${differences.length === 1 ? '' : 's'}, all reversible.`
          : `Nothing measurable differs yet — the file list has not been resolved for ${input.business.name}.`,
  }
}

/** Everything that cannot be undone by putting the previous build back. */
export function irreversibleDifferences(c: ReleaseComparison): ReleaseDifference[] {
  return c.differences.filter((d) => d.irreversible)
}
