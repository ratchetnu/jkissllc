// ── Operion Shadow Alerting — filters, facets, summary (PURE) ────────────────
//
// The Alerts page's severity / policy / model / deployment / business / status / search /
// date filters resolve HERE, at the route layer — never in the client and never in the
// alert engine. Mirrors shadow-facets.ts exactly, for the same reason: the browser must
// never re-derive counts the server already knows.
//
// No I/O, no clock (callers pass `now` where a window is involved), fully unit-tested.

import type { AlertSeverity, AlertPolicyType, AlertStatus, ShadowAlert } from './shadow-alert-types'
import { ALL_POLICY_TYPES, SEVERITY_RANK } from './shadow-alert-types'

export type AlertFilter = {
  severity?: AlertSeverity
  /** Minimum severity — INFO shows everything, CRITICAL shows only criticals. */
  minSeverity?: AlertSeverity
  policyType?: AlertPolicyType
  status?: AlertStatus
  model?: string
  deployment?: string
  business?: string
  unread?: boolean
  /** Free text over id, reason, policy, scope, and related booking ids. */
  q?: string
  from?: number             // lastDetectedAt lower bound (inclusive)
  to?: number               // upper bound (exclusive)
}

export type AlertFacetOption = { value: string; label: string; count: number }
export type AlertFacets = {
  severities: AlertFacetOption[]
  policyTypes: AlertFacetOption[]
  statuses: AlertFacetOption[]
  models: AlertFacetOption[]
  deployments: AlertFacetOption[]
  businesses: AlertFacetOption[]
}

export type AlertSummary = {
  total: number
  open: number
  acknowledged: number
  resolved: number
  muted: number
  expired: number
  /** Everything still demanding owner attention (OPEN + ACKNOWLEDGED). */
  active: number
  unread: number
  /** Open + unacknowledged CRITICALs — the number that belongs on a badge. */
  openCritical: number
  escalated: number
  bySeverity: Record<AlertSeverity, number>
  byPolicyType: Record<string, number>
  /** Most recent lastDetectedAt across all alerts, or null when there are none. */
  lastDetectedAt: number | null
}

const SEVERITIES: AlertSeverity[] = ['CRITICAL', 'ERROR', 'WARNING', 'INFO']
const STATUSES: AlertStatus[] = ['OPEN', 'ACKNOWLEDGED', 'MUTED', 'RESOLVED', 'EXPIRED']

const isActive = (a: ShadowAlert) => a.status === 'OPEN' || a.status === 'ACKNOWLEDGED'
export const prettyPolicyType = (t: string): string => t.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
const modelLabel = (m: string): string => m.split('/').pop() ?? m

// ── filtering ────────────────────────────────────────────────────────────────

export function applyAlertFilter(alerts: ShadowAlert[], f: AlertFilter): ShadowAlert[] {
  const q = f.q?.trim().toLowerCase()
  return alerts.filter((a) => {
    if (f.severity && a.severity !== f.severity) return false
    if (f.minSeverity && SEVERITY_RANK[a.severity] < SEVERITY_RANK[f.minSeverity]) return false
    if (f.policyType && a.policyType !== f.policyType) return false
    if (f.status && a.status !== f.status) return false
    if (f.model && a.model !== f.model) return false
    if (f.deployment && a.deployment !== f.deployment) return false
    if (f.business && a.business !== f.business) return false
    if (typeof f.unread === 'boolean' && a.unread !== f.unread) return false
    if (typeof f.from === 'number' && a.lastDetectedAt < f.from) return false
    if (typeof f.to === 'number' && a.lastDetectedAt >= f.to) return false
    if (q) {
      const hay = [a.id, a.reason, a.policyId, a.policyType, a.scopeKey, a.model ?? '', a.deployment ?? '', ...a.relatedBookingIds]
        .join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

/** Severity first, then most-recently-detected. The thing most likely to hurt sits on top. */
export function sortAlerts(alerts: ShadowAlert[]): ShadowAlert[] {
  return [...alerts].sort((x, y) =>
    SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity] ||
    y.lastDetectedAt - x.lastDetectedAt ||
    x.id.localeCompare(y.id))
}

// ── facets ───────────────────────────────────────────────────────────────────

function tally(pairs: Array<[string, string]>): AlertFacetOption[] {
  const m = new Map<string, { label: string; count: number }>()
  for (const [value, label] of pairs) {
    const e = m.get(value)
    if (e) e.count++
    else m.set(value, { label, count: 1 })
  }
  return [...m.entries()].map(([value, { label, count }]) => ({ value, label, count })).sort((a, b) => b.count - a.count)
}

/** Enumerated over the FULL set, like extractFacets — options must not vanish when a
 *  filter is active, or the owner cannot navigate back out of a dead end. */
export function alertFacets(alerts: ShadowAlert[]): AlertFacets {
  return {
    severities: tally(alerts.map((a) => [a.severity, a.severity])),
    policyTypes: tally(alerts.map((a) => [a.policyType, prettyPolicyType(a.policyType)])),
    statuses: tally(alerts.map((a) => [a.status, a.status])),
    models: tally(alerts.flatMap((a) => (a.model ? [[a.model, modelLabel(a.model)] as [string, string]] : []))),
    deployments: tally(alerts.flatMap((a) => (a.deployment ? [[a.deployment, a.deployment] as [string, string]] : []))),
    // Always empty today — V2ShadowJob carries no businessId (single-tenant). Kept so the
    // dimension lights up automatically once jobs are tenant-tagged.
    businesses: tally(alerts.flatMap((a) => (a.business ? [[a.business, a.business] as [string, string]] : []))),
  }
}

// ── summary ──────────────────────────────────────────────────────────────────

export function summarizeAlerts(alerts: ShadowAlert[]): AlertSummary {
  const bySeverity = { INFO: 0, WARNING: 0, ERROR: 0, CRITICAL: 0 } as Record<AlertSeverity, number>
  const byPolicyType: Record<string, number> = {}
  let open = 0, acknowledged = 0, resolved = 0, muted = 0, expired = 0, unread = 0, escalated = 0, openCritical = 0
  let lastDetectedAt: number | null = null

  for (const a of alerts) {
    bySeverity[a.severity] = (bySeverity[a.severity] ?? 0) + 1
    byPolicyType[a.policyType] = (byPolicyType[a.policyType] ?? 0) + 1
    if (a.status === 'OPEN') open++
    if (a.status === 'ACKNOWLEDGED') acknowledged++
    if (a.status === 'RESOLVED') resolved++
    if (a.status === 'MUTED') muted++
    if (a.status === 'EXPIRED') expired++
    if (a.unread) unread++
    if (a.escalatedAt) escalated++
    if (a.status === 'OPEN' && a.severity === 'CRITICAL') openCritical++
    if (lastDetectedAt === null || a.lastDetectedAt > lastDetectedAt) lastDetectedAt = a.lastDetectedAt
  }

  return {
    total: alerts.length,
    open, acknowledged, resolved, muted, expired,
    active: alerts.filter(isActive).length,
    unread, openCritical, escalated, bySeverity, byPolicyType, lastDetectedAt,
  }
}

// ── query string → typed filter (route + client share this contract) ─────────

const isSeverity = (v: string | null): v is AlertSeverity => !!v && (SEVERITIES as string[]).includes(v)
const isStatus = (v: string | null): v is AlertStatus => !!v && (STATUSES as string[]).includes(v)
const isPolicyType = (v: string | null): v is AlertPolicyType => !!v && (ALL_POLICY_TYPES as readonly string[]).includes(v)

export function parseAlertFilter(sp: URLSearchParams): AlertFilter {
  const num = (k: string): number | undefined => {
    const v = sp.get(k)
    if (!v) return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const str = (k: string): string | undefined => {
    const v = sp.get(k)?.trim()
    return v ? v : undefined
  }
  const unreadRaw = sp.get('unread')
  return {
    severity: isSeverity(sp.get('severity')) ? (sp.get('severity') as AlertSeverity) : undefined,
    minSeverity: isSeverity(sp.get('minSeverity')) ? (sp.get('minSeverity') as AlertSeverity) : undefined,
    policyType: isPolicyType(sp.get('policyType')) ? (sp.get('policyType') as AlertPolicyType) : undefined,
    status: isStatus(sp.get('status')) ? (sp.get('status') as AlertStatus) : undefined,
    model: str('model'),
    deployment: str('deployment'),
    business: str('business'),
    unread: unreadRaw === '1' || unreadRaw === 'true' ? true : unreadRaw === '0' || unreadRaw === 'false' ? false : undefined,
    q: str('q'),
    from: num('from'),
    to: num('to'),
  }
}

// ── export (owner takes an alert off-platform) ───────────────────────────────

/** A flat, spreadsheet-friendly row. Carries NO raw model output — an alert export is
 *  evidence about the model, not a copy of what it said about a customer's property. */
export function alertToExportRow(a: ShadowAlert): Record<string, string | number> {
  return {
    id: a.id,
    severity: a.severity,
    status: a.status,
    policy: a.policyType,
    scope: a.scopeKey,
    model: a.model ?? '',
    deployment: a.deployment ?? '',
    reason: a.reason,
    observed: a.observed,
    threshold: a.threshold,
    baseline: a.comparison ?? '',
    sampleSize: a.sampleSize,
    occurrences: a.occurrences,
    firstDetected: new Date(a.firstDetectedAt).toISOString(),
    lastDetected: new Date(a.lastDetectedAt).toISOString(),
    acknowledgedBy: a.acknowledgedBy ?? '',
    resolvedBy: a.resolvedBy ?? '',
    resolvedReason: a.resolvedReason ?? '',
    relatedBookings: a.relatedBookingIds.join(' '),
    readinessTier: a.readiness?.tier ?? '',
  }
}

const csvCell = (v: string | number): string => {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function alertsToCsv(alerts: ShadowAlert[]): string {
  const rows = alerts.map(alertToExportRow)
  const headers = Object.keys(alertToExportRow({ ...EMPTY_ALERT_SHAPE }))
  return [headers.join(','), ...rows.map((r) => headers.map((h) => csvCell(r[h] ?? '')).join(','))].join('\n')
}

// Header order must be stable even when the alert list is empty, so the CSV a filter
// produces always has the same columns.
const EMPTY_ALERT_SHAPE: ShadowAlert = {
  alertVersion: 1, id: '', policyId: '', policyType: 'critical_false_negative', severity: 'INFO',
  status: 'OPEN', dedupKey: '', scopeKey: '', reason: '', observed: 0, threshold: 0, comparison: null,
  sampleSize: 0, firstDetectedAt: 0, lastDetectedAt: 0, occurrences: 0, relatedBookingIds: [],
  relatedTraceIds: [], readiness: null, notes: [], unread: false,
}
