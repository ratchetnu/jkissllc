// ── AI worker registry ───────────────────────────────────────────────────────
//
// The nine initial governed AI workers. Every worker carries the global Level-5
// prohibited set (they can never do those, regardless of autonomy), plus its own
// declared surface. Defaults are conservative: PII redacted, no location/financial
// access, approval required at Level 3, audit always on.

import { PROHIBITED_ACTIONS, APPROVAL_REQUIRED_AT } from './autonomy'
import type { AiWorker, WorkerId } from './types'

type WorkerInput = Pick<AiWorker, 'id' | 'displayName' | 'purpose' | 'allowedCapabilities' | 'allowedTools' | 'requiredPermissions' | 'dataDomains' | 'defaultAutonomy'> &
  Partial<AiWorker>

function worker(w: WorkerInput): AiWorker {
  return {
    approvalRequiredAtOrAbove: APPROVAL_REQUIRED_AT,
    budgetUsdPerDay: 5,
    rateLimitPerHour: 60,
    auditRequired: true,
    prohibitedActions: [...PROHIBITED_ACTIONS],
    escalationRule: 'On low confidence, missing permission, or any Level-5 touch: stop and escalate to a human owner/admin.',
    enabledForTenants: 'all', // still gated by AI_WORKFORCE_ENABLED at the governance layer
    industryPackCompatibility: 'all',
    modelRoutingPolicy: 'default',
    piiAccess: 'redacted',
    locationDataAccess: false,
    financialDataAccess: false,
    promptVersionId: `${w.id}.v1`,
    ...w,
  }
}

const LIST: AiWorker[] = [
  worker({
    id: 'ai-coo', displayName: 'AI COO',
    purpose: 'Summarize operations, surface risks, brief the owner.',
    allowedCapabilities: ['reporting', 'routes', 'scheduling', 'ai-intelligence', 'audit-logs'],
    allowedTools: ['ops.insights'], requiredPermissions: ['ai:use', 'ai:analytics', 'reports:view'],
    dataDomains: ['operations', 'analytics'], defaultAutonomy: 1, financialDataAccess: true,
  }),
  worker({
    id: 'ai-dispatcher', displayName: 'AI Dispatcher',
    purpose: 'Recommend and draft crew assignments and route adjustments.',
    allowedCapabilities: ['routes', 'scheduling', 'workforce', 'availability', 'equipment', 'fleet'],
    allowedTools: ['assignment.suggest', 'dispatch.draft'], requiredPermissions: ['ai:use', 'routes:manage', 'crew:assign'],
    dataDomains: ['dispatch', 'workforce'], defaultAutonomy: 2,
  }),
  worker({
    id: 'ai-sales', displayName: 'AI Sales Assistant',
    purpose: 'Draft quotes and lead follow-ups from verified pricing.',
    allowedCapabilities: ['leads', 'quotes', 'pricing', 'customers'],
    allowedTools: ['quote.draft', 'followup.draft'], requiredPermissions: ['ai:use'],
    dataDomains: ['sales', 'pricing'], defaultAutonomy: 2,
  }),
  worker({
    id: 'ai-support', displayName: 'AI Customer Support Assistant',
    purpose: 'Draft customer replies from booking context.',
    allowedCapabilities: ['messaging', 'bookings', 'customers'],
    allowedTools: ['message.draft'], requiredPermissions: ['ai:use', 'messages:send'],
    dataDomains: ['comms', 'bookings'], defaultAutonomy: 2,
  }),
  worker({
    id: 'ai-finance', displayName: 'AI Finance Analyst',
    purpose: 'Flag variances and brief on profitability (read-only).',
    allowedCapabilities: ['reporting', 'analytics', 'invoicing', 'payments', 'contractor-compensation', 'expenses'],
    allowedTools: ['finance.analyze'], requiredPermissions: ['ai:use', 'profitability:view'],
    dataDomains: ['finance'], defaultAutonomy: 1, financialDataAccess: true,
  }),
  worker({
    id: 'ai-workforce', displayName: 'AI Workforce Assistant',
    purpose: 'Draft schedules and workforce reminders.',
    allowedCapabilities: ['workforce', 'availability', 'time-off', 'scheduling'],
    allowedTools: ['schedule.draft', 'reminder.draft'], requiredPermissions: ['ai:use', 'timeoff:view'],
    dataDomains: ['workforce'], defaultAutonomy: 2,
  }),
  worker({
    id: 'ai-fleet', displayName: 'AI Fleet & Equipment Assistant',
    purpose: 'Surface maintenance-due and equipment-conflict alerts.',
    allowedCapabilities: ['equipment', 'fleet'],
    allowedTools: ['maintenance.flag'], requiredPermissions: ['ai:use', 'equipment:manage'],
    dataDomains: ['equipment'], defaultAutonomy: 1,
  }),
  worker({
    id: 'ai-marketing', displayName: 'AI Marketing Assistant',
    purpose: 'Draft review replies and marketing content.',
    allowedCapabilities: ['reporting', 'analytics'],
    allowedTools: ['review.reply.draft', 'post.draft'], requiredPermissions: ['ai:use', 'comms:analytics'],
    dataDomains: ['marketing', 'analytics'], defaultAutonomy: 2,
  }),
  worker({
    id: 'ai-advisor', displayName: 'AI Business Advisor',
    purpose: 'Strategic recommendations over the full read model.',
    allowedCapabilities: ['reporting', 'analytics', 'ai-intelligence'],
    allowedTools: ['advise'], requiredPermissions: ['ai:use', 'ai:analytics'],
    dataDomains: ['operations', 'finance', 'analytics'], defaultAutonomy: 1, financialDataAccess: true,
  }),
]

export const AI_WORKER_REGISTRY: Record<WorkerId, AiWorker> = Object.freeze(
  LIST.reduce((acc, w) => { acc[w.id] = w; return acc }, {} as Record<WorkerId, AiWorker>),
)

export function getWorker(id: WorkerId): AiWorker {
  const w = AI_WORKER_REGISTRY[id]
  if (!w) throw new Error(`unknown AI worker: ${id}`)
  return w
}

export function allWorkers(): AiWorker[] {
  return Object.values(AI_WORKER_REGISTRY)
}
