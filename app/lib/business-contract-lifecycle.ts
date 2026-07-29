import { bizKey, type Business, type BusinessContractEvent, type RateHistoryEntry } from './businesses'
import type { RouteRecord, RouteStatus } from './routes'
import type { RouteTemplate } from './route-templates'

export const CONTRACT_ENDABLE_ROUTE_STATUSES: ReadonlySet<RouteStatus> = new Set([
  'draft', 'assigned', 'text_sent', 'confirmed', 'declined', 'no_response',
])

type Actor = { sub: string; role: string }

export type EndContractInput = {
  businessKey: string
  businessName: string
  reason?: string
  now: number
  today: string
  actor: Actor
}

export type EndContractResult = {
  ok: boolean
  business?: Business
  cancelledRouteCount: number
  pausedTemplateCount: number
  failedRoutes: string[]
}

export type BusinessContractDeps = {
  getBusiness: (key: string) => Promise<Business | null>
  saveBusiness: (business: Business) => Promise<void>
  listRoutes: () => Promise<RouteRecord[]>
  cancelRoute: (token: string, input: EndContractInput) => Promise<'cancelled' | 'skipped'>
  listTemplates: () => Promise<RouteTemplate[]>
  saveTemplate: (template: RouteTemplate) => Promise<void>
}

const sameBusiness = (name: string, key: string) => bizKey(name) === key

export function isFutureContractRoute(route: RouteRecord, businessKey: string, today: string): boolean {
  return sameBusiness(route.businessName, businessKey)
    && route.routeDate >= today
    && CONTRACT_ENDABLE_ROUTE_STATUSES.has(route.status)
}

function appendContractEvent(history: BusinessContractEvent[] | undefined, event: BusinessContractEvent): BusinessContractEvent[] {
  const next = [...(history ?? []), event]
  return next.slice(-50)
}

/**
 * End a client contract without deleting operational history.
 *
 * The order is intentional: recurring generation is stopped first, then future
 * routes are cancelled, and only after every route succeeds is the business
 * archived. If one route is busy, a retry safely completes the remaining work.
 */
export async function endBusinessContract(input: EndContractInput, deps: BusinessContractDeps): Promise<EndContractResult> {
  const [existing, templates] = await Promise.all([
    deps.getBusiness(input.businessKey),
    deps.listTemplates(),
  ])

  const matchingTemplates = templates.filter(t => t.active && sameBusiness(t.businessName, input.businessKey))
  let pausedTemplateCount = 0
  for (const template of matchingTemplates) {
    await deps.saveTemplate({ ...template, active: false })
    pausedTemplateCount++
  }

  let cancelledRouteCount = 0
  const failedRoutes = new Set<string>()

  // Read routes only after schedules are paused. Re-check once more after the
  // first sweep so a generator that was already in flight cannot leave a late
  // route alive behind an archived contract.
  for (let sweep = 0; sweep < 2; sweep++) {
    const matchingRoutes = (await deps.listRoutes()).filter(r => isFutureContractRoute(r, input.businessKey, input.today))
    if (!matchingRoutes.length) break
    for (const route of matchingRoutes) {
      try {
        const outcome = await deps.cancelRoute(route.token, input)
        if (outcome === 'cancelled') cancelledRouteCount++
      } catch {
        failedRoutes.add(route.routeNumber)
      }
    }
  }

  const stillLive = (await deps.listRoutes()).filter(r => isFutureContractRoute(r, input.businessKey, input.today))
  for (const route of stillLive) failedRoutes.add(route.routeNumber)
  if (failedRoutes.size) {
    return { ok: false, cancelledRouteCount, pausedTemplateCount, failedRoutes: [...failedRoutes] }
  }

  const pricingWasActive = existing?.pricingActive ?? existing?.contractRateCents !== undefined
  const reason = input.reason?.trim().slice(0, 500) || undefined
  const history: RateHistoryEntry[] = [...(existing?.rateHistory ?? [])]
  if (!existing?.contractEndedAt && pricingWasActive) {
    history.push({
      at: input.now,
      contractRateCents: existing?.contractRateCents,
      effectiveDate: existing?.rateEffectiveDate,
      active: false,
      notes: reason || 'Contract ended',
    })
  }

  const event: BusinessContractEvent = {
    at: input.now,
    action: 'ended',
    actorId: input.actor.sub,
    actorRole: input.actor.role,
    reason,
    cancelledRouteCount,
    pausedTemplateCount,
  }
  const business: Business = {
    ...(existing ?? {
      key: input.businessKey,
      name: input.businessName,
      createdAt: input.now,
      updatedAt: input.now,
    }),
    name: existing?.name || input.businessName,
    pricingActive: false,
    pricingActiveBeforeContractEnd: existing?.contractEndedAt
      ? existing.pricingActiveBeforeContractEnd
      : pricingWasActive,
    rateHistory: history.length ? history.slice(-50) : undefined,
    contractEndedAt: existing?.contractEndedAt ?? input.now,
    contractEndReason: reason ?? existing?.contractEndReason,
    contractEndedBy: input.actor.sub,
    contractEndedByRole: input.actor.role,
    contractHistory: existing?.contractEndedAt
      ? existing.contractHistory
      : appendContractEvent(existing?.contractHistory, event),
  }
  await deps.saveBusiness(business)
  return { ok: true, business, cancelledRouteCount, pausedTemplateCount, failedRoutes: [] }
}

export async function reopenBusinessContract(
  business: Business,
  actor: Actor,
  now: number,
  saveBusiness: (business: Business) => Promise<void>,
): Promise<Business> {
  if (!business.contractEndedAt) return business
  const reopened: Business = {
    ...business,
    pricingActive: business.pricingActiveBeforeContractEnd ?? false,
    contractEndedAt: undefined,
    contractEndReason: undefined,
    contractEndedBy: undefined,
    contractEndedByRole: undefined,
    pricingActiveBeforeContractEnd: undefined,
    contractHistory: appendContractEvent(business.contractHistory, {
      at: now,
      action: 'reopened',
      actorId: actor.sub,
      actorRole: actor.role,
    }),
  }
  await saveBusiness(reopened)
  return reopened
}
