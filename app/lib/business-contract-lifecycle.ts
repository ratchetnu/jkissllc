import { bizKey, type Business, type BusinessContractEvent, type RateHistoryEntry } from './businesses'
import type { RouteRecord, RouteStatus } from './routes'
import type { RouteTemplate } from './route-templates'

export const CONTRACT_ENDABLE_ROUTE_STATUSES: ReadonlySet<RouteStatus> = new Set([
  'draft', 'assigned', 'text_sent', 'confirmed', 'declined', 'no_response',
])

type Actor = { sub: string; role: string }

/**
 * How many routes this service can prove it has seen. Chosen to match the widest
 * existing business-wide scan (route-reprice uses 2000), so contract-ending is never
 * the narrowest window in the system.
 *
 * FAIL CLOSED. This used to default to Number.MAX_SAFE_INTEGER, which meant a caller
 * that simply forgot to pass `routeScanLimit` silently lost the completeness
 * guarantee entirely — the guard was opt-IN on the safety-critical path. A caller
 * that genuinely wants an unbounded scan must now say so explicitly.
 */
export const DEFAULT_ROUTE_SCAN_LIMIT = 2000

/**
 * The number of records a caller must FETCH for the guard to work: one beyond the
 * limit, so "are there more than I can account for?" is answerable at all.
 *
 * Exported because the limit and the fetch size have to move together. They were
 * previously two magic numbers in two files (2000 here, 2001 in the route), where
 * changing one and not the other would have disabled the guard silently.
 */
export const routeScanFetchSize = (limit: number = DEFAULT_ROUTE_SCAN_LIMIT): number => limit + 1

export type EndContractInput = {
  businessKey: string
  businessName: string
  reason?: string
  now: number
  today: string
  actor: Actor
  routeScanLimit?: number
}

export type EndContractResult = {
  ok: boolean
  business?: Business
  cancelledRouteCount: number
  pausedTemplateCount: number
  failedRoutes: string[]
  failedTemplates: string[]
  incompleteReason?: string
}

export type BusinessContractDeps = {
  getBusiness: (key: string) => Promise<Business | null>
  saveBusiness: (business: Business) => Promise<void>
  listRoutes: () => Promise<RouteRecord[]>
  cancelRoute: (token: string, input: EndContractInput) => Promise<'cancelled' | 'skipped'>
  listTemplates: () => Promise<RouteTemplate[]>
  saveTemplate: (template: RouteTemplate) => Promise<void>
}

const sameBusiness = (name: unknown, key: string) => typeof name === 'string' && bizKey(name) === key

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

  const scanLimit = input.routeScanLimit ?? DEFAULT_ROUTE_SCAN_LIMIT
  const scan = async (): Promise<{ routes: RouteRecord[]; incompleteReason?: string }> => {
    const routes = await deps.listRoutes()
    if (routes.length > scanLimit) {
      return {
        routes,
        incompleteReason: `More than ${scanLimit.toLocaleString('en-US')} operations exist; completeness cannot be proven.`,
      }
    }
    return { routes }
  }

  // Completeness is checked BEFORE anything is written. Previously templates were
  // paused first, so a business past the limit had every recurring schedule stopped
  // and was then refused — leaving a permanently half-applied state that no retry
  // could finish, and an error message that never mentioned the pause. Reading a
  // count has no side effects, so proving we can finish costs nothing and the
  // refusal is now genuinely a no-op.
  const preflight = await scan()
  if (preflight.incompleteReason) {
    return { ok: false, cancelledRouteCount: 0, pausedTemplateCount: 0, failedRoutes: [], failedTemplates: [], incompleteReason: preflight.incompleteReason }
  }

  const matchingTemplates = templates.filter(t => t.active && sameBusiness(t.businessName, input.businessKey))
  let pausedTemplateCount = 0
  const failedTemplates: string[] = []
  for (const template of matchingTemplates) {
    try {
      await deps.saveTemplate({ ...template, active: false })
      pausedTemplateCount++
    } catch {
      failedTemplates.push(template.label || template.id)
    }
  }
  if (failedTemplates.length) {
    return { ok: false, cancelledRouteCount: 0, pausedTemplateCount, failedRoutes: [], failedTemplates }
  }

  let cancelledRouteCount = 0
  const failedRoutes = new Set<string>()

  // Routes are re-read only AFTER schedules are paused — the preflight above was a
  // count, not the working set. Re-check once more after the first sweep so a
  // generator that was already in flight cannot leave a late route alive behind an
  // archived contract, and keep the completeness guard on every read.
  for (let sweep = 0; sweep < 2; sweep++) {
    const scanned = await scan()
    if (scanned.incompleteReason) {
      return { ok: false, cancelledRouteCount, pausedTemplateCount, failedRoutes: [], failedTemplates: [], incompleteReason: scanned.incompleteReason }
    }
    const matchingRoutes = scanned.routes.filter(r => isFutureContractRoute(r, input.businessKey, input.today))
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

  const finalScan = await scan()
  if (finalScan.incompleteReason) {
    return { ok: false, cancelledRouteCount, pausedTemplateCount, failedRoutes: [], failedTemplates: [], incompleteReason: finalScan.incompleteReason }
  }
  const stillLive = finalScan.routes.filter(r => isFutureContractRoute(r, input.businessKey, input.today))
  for (const route of stillLive) failedRoutes.add(route.routeNumber)
  if (failedRoutes.size) {
    return { ok: false, cancelledRouteCount, pausedTemplateCount, failedRoutes: [...failedRoutes], failedTemplates: [] }
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
  return { ok: true, business, cancelledRouteCount, pausedTemplateCount, failedRoutes: [], failedTemplates: [] }
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
