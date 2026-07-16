// ── Operion Update Center — Claude deployment-prompt generator (Phase 10) ────
// PURE: stored metadata in → a single copyable prompt string out. It NEVER executes
// anything; the browser only copies the text. The generated prompt hard-codes the
// safety guardrails Claude must follow when porting an update to a target repo.

import type { PlatformUpdate, PlatformBusiness, UpdateCompatibility } from './types'

export const DEPLOYMENT_PROMPT_VERSION = 1

export type PromptInput = {
  updates: PlatformUpdate[]
  source: PlatformBusiness
  target: PlatformBusiness
  compat?: UpdateCompatibility[]     // per-update compatibility notes for the target
  releaseVersion?: string
}

const yn = (b: boolean | undefined) => (b ? 'YES' : 'no')
const line = (label: string, v: string | undefined) => `- ${label}: ${v && v.trim() ? v : '(not recorded)'}`

function collect<T>(items: T[], pick: (x: T) => string[] | undefined): string[] {
  const set = new Set<string>()
  for (const it of items) for (const x of pick(it) ?? []) if (x?.trim()) set.add(x.trim())
  return [...set]
}

export function buildDeploymentPrompt(input: PromptInput): string {
  const { updates, source, target, compat = [], releaseVersion } = input
  const compatByUpdate = new Map(compat.map((c) => [c.updateKey, c]))
  const anyMigration = updates.some((u) => u.migrationRequired)
  const anyEnv = updates.some((u) => u.environmentChangeRequired || u.secretRequired)
  const anyFlags = updates.some((u) => u.featureFlagRequired)
  const requiredModules = collect(updates, (u) => u.requiredModules)
  const excludeComponents = collect(compat, (c) => c.componentsToExclude)

  const updatesBlock = updates.map((u) => {
    const c = compatByUpdate.get(u.key)
    return [
      `### ${u.key} — ${u.title}`,
      `  ${u.summary}`,
      line('  Source commit', u.sourceCommit),
      line('  Module', u.module),
      `  Breaking: ${yn(u.breakingChange)} · Migration: ${yn(u.migrationRequired)} · Feature flag: ${yn(u.featureFlagRequired)} · Rollback: ${yn(u.rollbackSupported)}`,
      c ? `  Compatibility (${target.name}): ${c.status}${c.reason ? ` — ${c.reason}` : ''}` : '  Compatibility: not assessed',
      c?.componentsToExclude?.length ? `  EXCLUDE for this target: ${c.componentsToExclude.join(', ')}` : '',
    ].filter(Boolean).join('\n')
  }).join('\n\n')

  return `# Deployment port — ${source.name} → ${target.name}${releaseVersion ? ` (release ${releaseVersion})` : ''}

You are working in the TARGET repository: ${target.repoName ?? '(target repo not recorded)'} (branch ${target.defaultBranch}).

## 1. Mission
Port the listed update(s) from ${source.name} into ${target.name}, preserving ${target.name}'s branding, business-specific workflows, and data. Make the MINIMUM changes needed. Do not deploy if any gate fails.

## 2–6. Source
${line('Business', source.name)}
${line('Repository', source.repoName)}
${line('Branch', source.defaultBranch)}
${line('Commit', updates.find((u) => u.sourceCommit)?.sourceCommit)}
${line('Deployment', updates.find((u) => u.sourceDeploymentId)?.sourceDeploymentId)}

## 7–9. Target
${line('Business', target.name)}
${line('Repository', target.repoName)}
${line('Branch', target.defaultBranch)}
${line('Production URL', target.productionUrl)}
${line('Health endpoint', target.healthEndpoint)}

## 10. Included updates
${updatesBlock || '(none)'}

## 11. Required modules
${requiredModules.length ? requiredModules.map((m) => `- ${m}`).join('\n') : '- (none)'}

## 12. Exclude — source-specific logic / components NOT to port
${excludeComponents.length ? excludeComponents.map((m) => `- ${m}`).join('\n') : `- (assess during the target audit; exclude anything ${source.name}-specific)`}

## 13. Compatibility findings
${compat.length ? compat.map((c) => `- ${c.updateKey}: ${c.status}${c.reason ? ` — ${c.reason}` : ''}${c.blockingIssues ? ` · BLOCKING: ${c.blockingIssues}` : ''}`).join('\n') : '- Not assessed — assess before porting.'}

## 14. Migration requirements
${anyMigration ? '- Migration(s) required. Review + apply carefully; ensure a documented rollback path before deploying.' : '- None.'}

## 15. Environment / secret requirements
${anyEnv ? '- Environment or secret changes required. Set them in the TARGET project only. NEVER copy source secrets or source tenant data.' : '- None.'}

## 16. Feature flags
${anyFlags ? '- Feature flag(s) involved. Default them OFF in the target unless explicitly directed otherwise.' : '- None.'}

## 17. Required tests
- Typecheck, changed-file lint, full test suite must pass in the TARGET repo.

## 18. Production build
- \`npm run build\` must succeed before any deploy.

## 19. Deployment target
${line('Provider', target.deployProvider)}
${line('Project', target.deployProject)}
- Deploy ${target.name} ONLY. Do not touch any other business's repo or deployment.

## 20. Health checks
- After deploy: production READY, ${target.healthEndpoint ?? '/api/health'} returns 200, admin loads, critical modules load, no new 5xx.

## 21. Rollback
${updates.some((u) => u.rollbackSupported) ? '- Rollback supported. Record the previous commit before deploying so a revert is one step.' : '- No rollback plan on record — capture the previous commit and document a revert path before deploying.'}

## Claude, you MUST:
1. AUDIT the target repository first (its branding, workflows, conventions).
2. PRESERVE target branding and target-specific workflows.
3. EXCLUDE all source secrets and source tenant data.
4. Make MINIMAL changes; do not refactor unrelated code.
5. STOP and report if you hit a destructive conflict (do not force it).
6. Run typecheck + tests + \`npm run build\`; do NOT deploy if any fails.
7. Record the resulting commit SHA and the deployment ID.
8. Record the health-check result.
9. Deploy ${target.name} only — never another business.

## Final report format
Return: files changed · commit SHA · build result · test result · deployment ID · production URL · health result · anything excluded/skipped · anything that needs the owner. Then come back here and record the deployment in the Update Center (do not mark it verified until health passes or the owner waives with a reason).
`
}
