'use client'

import { useCallback, useEffect, useState } from 'react'

// Shared claims loader + client types. Same shape as useOps: a short module cache
// so moving between the claims list, a business and a crew member doesn't refetch,
// and reload() forces a fresh pull after a mutation.
//
// These types mirror lib/claims. They stay narrow on purpose — a page should not be
// able to render a field the API doesn't send.

export type LedgerEntry = {
  id: string; at: number; kind: 'scheduled' | 'payment' | 'waiver' | 'adjustment'
  direction: 'credit' | 'debit'; amountCents: number; periodDate: string; note?: string; actor: string
}

export type ClaimAssignment = {
  staffId: string; name: string; role?: string
  responsibilityCents: number; responsibilityPct?: number
  weeklyDeductionCents?: number
  startDate?: string; endDate?: string; nextDeductionOn?: string; lastDeductionOn?: string
  status: 'pending' | 'active' | 'paused' | 'completed' | 'waived'
  pausedReason?: string; waivedReason?: string
  ledger: LedgerEntry[]
}

export type ClaimAttachment = {
  id: string; kind: 'photo' | 'video' | 'document'; url: string; name?: string
  addedAt: number; removedAt?: number
}

export type ClaimSnapshot = {
  at: number
  businessName: string; businessContactName?: string; businessContactPhone?: string
  businessPriceCents?: number; priceSource?: string
  routeToken?: string; routeNumber?: string; routeDate?: string; reportAddress?: string
  routePayoutCents?: number; routeProfitCents?: number | null
  crew: { staffId: string; name: string; role?: string; payCents?: number }[]
}

export type ClaimListItem = {
  id: string; claimNumber: string; status: string; claimType: string
  businessKey: string; businessName: string
  routeToken?: string; routeNumber?: string
  claimDate: string; reportedDate: string
  reportedBy?: string; responseDeadline?: string
  description: string; totalCents: number
  assignments: ClaimAssignment[]
  attachmentCount: number
  createdAt: number; updatedAt: number
}

export type Claim = ClaimListItem & {
  attachments: ClaimAttachment[]
  internalNotes?: string; businessContact?: string; resolutionNotes?: string; closedAt?: number
  snapshot: ClaimSnapshot
  audit: { at: number; actor: string; action: string; note?: string }[]
}

export type ClaimGroup = { key: string; label: string; claimCount: number; totalCents: number; recoveredCents: number; outstandingCents: number }

export type ClaimsReport = {
  claimCount: number; openCount: number; closedCount: number
  thisMonthCount: number; thisMonthCents: number
  totalCents: number; assignedCents: number; absorbedCents: number
  recoveredCents: number; waivedCents: number; outstandingCents: number
  averageCents: number; largestCents: number
  largest?: { claimNumber: string; businessName: string; totalCents: number }
  byBusiness: ClaimGroup[]; byCrew: ClaimGroup[]
  trend: { month: string; claimCount: number; totalCents: number }[]
}

type Data = { items: ClaimListItem[]; report: ClaimsReport }

let cache: { at: number; data: Data } | null = null
let inflight: Promise<Data> | null = null

export function invalidateClaims() { cache = null }

async function fetchClaims(force = false): Promise<Data> {
  if (!force && cache && Date.now() - cache.at < 10_000) return cache.data
  if (inflight) return inflight
  inflight = fetch('/api/admin/claims', { credentials: 'same-origin' })
    .then(r => r.json())
    .then((d): Data => ({ items: Array.isArray(d.items) ? d.items : [], report: d.report }))
    .then(data => { cache = { at: Date.now(), data }; inflight = null; return data })
    .catch(e => { inflight = null; throw e })
  return inflight
}

export function useClaims() {
  const [data, setData] = useState<Data | null>(cache?.data ?? null)
  const [loading, setLoading] = useState(!cache)
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    setLoading(true); setError('')
    try { setData(await fetchClaims(true)) } catch { setError('Couldn’t load claims.') } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    let alive = true
    fetchClaims()
      .then(d => { if (alive) { setData(d); setLoading(false) } })
      .catch(() => { if (alive) { setError('Couldn’t load claims.'); setLoading(false) } })
    return () => { alive = false }
  }, [])

  return { claims: data?.items ?? [], report: data?.report, loading, error, reload }
}

// ── Derived, client-side (mirrors lib/claims — display only) ─────────────────
export const creditedCents = (a: ClaimAssignment) =>
  a.ledger.reduce((s, e) => s + (e.direction === 'credit' ? e.amountCents : -e.amountCents), 0)
export const remainingCents = (a: ClaimAssignment) => Math.max(0, a.responsibilityCents - creditedCents(a))
export const recoveredCents = (a: ClaimAssignment) =>
  a.ledger.reduce((s, e) => s + ((e.kind === 'scheduled' || e.kind === 'payment') && e.direction === 'credit' ? e.amountCents : 0), 0)
export const claimOutstanding = (c: Pick<ClaimListItem, 'assignments'>) => c.assignments.reduce((s, a) => s + remainingCents(a), 0)
export const assignedTotal = (c: Pick<ClaimListItem, 'assignments'>) => c.assignments.reduce((s, a) => s + a.responsibilityCents, 0)

/** PATCH a claim. Returns the error message, or null on success. */
export async function patchClaim(id: string, body: Record<string, unknown>): Promise<string | null> {
  try {
    const res = await fetch(`/api/admin/claims/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(body),
    })
    const d = await res.json()

    // The server refuses to close a claim with money still owed until we confirm.
    if (res.status === 409 && d.warning) {
      if (!confirm(d.message)) return null
      return patchClaim(id, { ...body, acknowledgeOutstanding: true })
    }
    if (!res.ok) return d.error || 'Action failed.'
    invalidateClaims()
    return null
  } catch { return 'Network error.' }
}
