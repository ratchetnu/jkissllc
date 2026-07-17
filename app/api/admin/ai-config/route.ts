import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../_lib/session'
import { isEnabled } from '../../../lib/platform/flags'
import { listShadowJobs, readShadowSpend, getShadowKillOverride } from '../../../lib/estimation/shadow-store'
import { computeShadowUsage } from '../../../lib/estimation/shadow-metrics'
import { learningReadiness } from '../../../lib/estimation/shadow-learning'
import { shadowBudgetFromEnv } from '../../../lib/estimation/shadow-budget'
import { modelForFeature } from '../../../lib/ai/routing'
import { ESTIMATOR_AI_FEATURE } from '../../../lib/ai/estimator-diagnostics'
import { V2_ESTIMATOR_VERSION } from '../../../lib/estimation/shadow-policy'
import { ANALYSIS_V2_PROMPT_VERSION } from '../../../lib/ai/analysis-v2-prompt'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/ai-config — the shared read for Models & Versions, Usage & Controls, and
// Settings. Platform-owner only + SHADOW_ANALYTICS_ENABLED. ZERO AI: config presence, versions,
// budget (env-derived, read-only), and usage counters — all from EXISTING sources, never a new
// store. NEVER returns a secret VALUE, only presence booleans.
const JOB_SAMPLE = 1000

// Env presence → owner-safe status. Reports configured/missing, never the value.
const present = (k: string): boolean => {
  const v = process.env[k]
  return typeof v === 'string' && v.trim() !== ''
}
const anyPresent = (...keys: string[]): boolean => keys.some(present)

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  if (!isEnabled('SHADOW_ANALYTICS_ENABLED')) return NextResponse.json({ enabled: false }, { status: 200 })

  const now = Date.now()
  try {
    const jobs = await listShadowJobs(JOB_SAMPLE)
    const usage = computeShadowUsage(jobs, now)
    const spend = await readShadowSpend(now)
    const readiness = learningReadiness(jobs)
    const budget = shadowBudgetFromEnv()
    const killOverride = await getShadowKillOverride()
    const killed = budget.killed || killOverride === true
    const liveModel = modelForFeature(ESTIMATOR_AI_FEATURE)

    // The most recent model + prompt version actually recorded by a completed evaluation — the
    // "what actually ran" truth, alongside the shipped constants.
    const recent = jobs.filter((j) => j.model && (j.status === 'completed' || j.status === 'manual_review')).sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt))[0]

    return NextResponse.json({
      enabled: true,
      at: now,
      // ── Models & Versions (read-only) ──
      models: {
        production: {
          role: 'V1 — customer-facing', model: liveModel, feature: ESTIMATOR_AI_FEATURE,
          state: 'live', note: 'The authoritative estimate every customer receives.',
        },
        shadow: {
          role: 'V2 — shadow only', model: recent?.model ?? liveModel,
          estimatorVersion: V2_ESTIMATOR_VERSION, promptVersion: ANALYSIS_V2_PROMPT_VERSION,
          lastRecordedModel: recent?.model ?? null, lastRecordedPromptVersion: recent?.promptVersion ?? null,
          lastEvaluationAt: recent?.completedAt ?? recent?.updatedAt ?? null,
          state: isEnabled('VISION_SHADOW_WORKER_ENABLED') ? 'active' : 'idle',
          promotable: readiness.tier === 'PRODUCTION_READY',
          readinessTier: readiness.tier,
          note: 'Evaluated against V1; never shown to a customer. Not promoted — promotion is a separate explicit owner action.',
        },
      },
      // ── Feature flags (owner-safe booleans; changed only via deployment config) ──
      flags: {
        shadowAnalytics: isEnabled('SHADOW_ANALYTICS_ENABLED'),
        shadowWorker: isEnabled('VISION_SHADOW_WORKER_ENABLED'),
        shadowQueue: isEnabled('VISION_SHADOW_QUEUE_ENABLED'),
        selectedOnly: isEnabled('VISION_SHADOW_SELECTED_ONLY'),
        shadowAlerting: isEnabled('SHADOW_ALERTING_ENABLED'),
      },
      // ── Usage & Controls ──
      controls: {
        killed, killOverride, envKillForced: budget.killed,
        budget, spendToday: spend, usage,
      },
      // ── Settings: config PRESENCE only (never values) ──
      config: [
        { key: 'ai_gateway', label: 'AI provider (gateway)', status: anyPresent('AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'VERCEL') ? 'configured' : 'missing', detail: 'Needed for any V1/V2 inference.' },
        { key: 'cron', label: 'Scheduled worker', status: present('CRON_SECRET') ? 'configured' : 'missing', detail: 'The shadow worker + reconcile crons.' },
        { key: 'owner_subs', label: 'Platform owner subjects', status: present('PLATFORM_OWNER_SUBS') ? 'configured' : 'missing', detail: 'Named owners beyond the legacy session; audit attribution.' },
        { key: 'budget_env', label: 'Budget overrides', status: anyPresent('SHADOW_MAX_EVALS_PER_DAY', 'SHADOW_MAX_DAILY_COST_USD', 'SHADOW_MAX_EVALS_PER_BOOKING') ? 'configured' : 'default', detail: 'Unset ⇒ conservative defaults apply.' },
        { key: 'kill_env', label: 'Kill-switch env flag', status: present('SHADOW_V2_KILL_SWITCH') ? 'configured' : 'default', detail: 'Deploy-time force-off; the runtime toggle is separate.' },
      ],
    })
  } catch {
    return NextResponse.json({ error: 'ai config unavailable' }, { status: 500 })
  }
})
