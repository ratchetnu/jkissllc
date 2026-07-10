import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../_lib/session'
import {
  listClaims, saveClaim, getClaim, generateClaimId, nextClaimNumber,
  snapshotFromRoute, snapshotFromBusiness, pushClaimAudit,
  CLAIM_STATUS_LABEL, CLAIM_TYPE_LABEL,
  type ClaimRecord, type ClaimType,
} from '../../../lib/claims'
import { computeClaimsReport, type ClaimFilters } from '../../../lib/claims-report'
import { parseMoneyCents } from '../../../lib/finance'
import { getBusiness, bizKey } from '../../../lib/businesses'
import { getRouteByToken } from '../../../lib/routes'
import { centralToday, isDateStr } from '../../../lib/dates'

const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const isClaimType = (v: string): v is ClaimType => v in CLAIM_TYPE_LABEL

export async function GET(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const q = new URL(req.url).searchParams
    const claims = await listClaims(1000)

    // One record, in full — used by the claim detail page.
    const id = S(q.get('id'), 80)
    if (id) {
      const c = claims.find(x => x.id === id) ?? (await getClaim(id))
      if (!c) return NextResponse.json({ error: 'Claim not found.' }, { status: 404 })
      return NextResponse.json({ claim: c })
    }

    const filters: ClaimFilters = {
      start: S(q.get('start'), 20) || undefined,
      end: S(q.get('end'), 20) || undefined,
      businessKey: S(q.get('businessKey'), 200) || undefined,
      staffId: S(q.get('staffId'), 80) || undefined,
      status: (S(q.get('status'), 40) || 'all') as ClaimFilters['status'],
    }
    const report = computeClaimsReport(claims, filters)

    // The list view never needs the full audit/ledger payload of every claim.
    const items = claims.map(c => ({
      id: c.id, claimNumber: c.claimNumber, status: c.status, claimType: c.claimType,
      businessKey: c.businessKey, businessName: c.businessName,
      routeToken: c.routeToken, routeNumber: c.routeNumber,
      claimDate: c.claimDate, reportedDate: c.reportedDate,
      description: c.description, totalCents: c.totalCents,
      assignments: c.assignments,
      attachmentCount: c.attachments.filter(a => !a.removedAt).length,
      createdAt: c.createdAt, updatedAt: c.updatedAt,
    }))

    return NextResponse.json({ items, report, statusLabels: CLAIM_STATUS_LABEL, typeLabels: CLAIM_TYPE_LABEL })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'list failed'
    if (msg === 'UPSTASH_NOT_CONFIGURED') return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    console.error('[admin/claims GET]', err)
    return NextResponse.json({ error: 'list failed' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const b = await req.json().catch(() => ({}))

  const totalCents = parseMoneyCents(b.total)
  if (totalCents == null) return NextResponse.json({ error: 'Claim amount must be a positive dollar amount.' }, { status: 400 })
  if (totalCents === 0) return NextResponse.json({ error: 'A claim needs an amount.' }, { status: 400 })

  const description = S(b.description, 4000)
  if (!description) return NextResponse.json({ error: 'Describe what happened.' }, { status: 400 })

  const claimType = S(b.claimType, 40)
  if (!isClaimType(claimType)) return NextResponse.json({ error: 'Pick a claim type.' }, { status: 400 })

  const today = centralToday()
  const claimDate = isDateStr(S(b.claimDate, 20)) ? S(b.claimDate, 20) : today
  const reportedDate = isDateStr(S(b.reportedDate, 20)) ? S(b.reportedDate, 20) : today
  if (reportedDate < claimDate) {
    return NextResponse.json({ error: "A claim can't be reported before it happened." }, { status: 400 })
  }

  try {
    // Created from a completed route: everything the route already knows is copied
    // and frozen, so the owner never re-keys it. See snapshotFromRoute.
    const routeToken = S(b.routeToken, 200)
    let snapshot, businessName: string, routeNumber: string | undefined

    if (routeToken) {
      const route = await getRouteByToken(routeToken)
      if (!route) return NextResponse.json({ error: 'That route no longer exists.' }, { status: 404 })
      const biz = await getBusiness(bizKey(route.businessName)).catch(() => null)
      snapshot = snapshotFromRoute(route, biz)
      businessName = route.businessName
      routeNumber = route.routeNumber
    } else {
      businessName = S(b.businessName, 200)
      if (!businessName) return NextResponse.json({ error: 'Pick the business this claim is for.' }, { status: 400 })
      const biz = await getBusiness(bizKey(businessName)).catch(() => null)
      snapshot = snapshotFromBusiness(businessName, biz)
    }

    const now = Date.now()
    const claim: ClaimRecord = {
      id: generateClaimId(),
      claimNumber: await nextClaimNumber(),
      status: 'new',
      claimType,
      businessKey: bizKey(businessName),
      businessName,
      routeToken: routeToken || undefined,
      routeNumber,
      claimDate,
      reportedDate,
      reportedBy: S(b.reportedBy, 200) || undefined,
      responseDeadline: isDateStr(S(b.responseDeadline, 20)) ? S(b.responseDeadline, 20) : undefined,
      description,
      totalCents,
      attachments: [],
      internalNotes: S(b.internalNotes, 4000) || undefined,
      businessContact: S(b.businessContact, 200) || snapshot.businessContactName,
      assignments: [],
      snapshot,
      audit: [],
      createdAt: now,
      updatedAt: now,
    }
    pushClaimAudit(claim, 'admin', `Claim opened for ${(totalCents / 100).toFixed(2)}`, routeNumber ? `from route ${routeNumber}` : undefined)

    await saveClaim(claim)
    return NextResponse.json({ ok: true, claim })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'create failed'
    if (msg === 'UPSTASH_NOT_CONFIGURED') return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    console.error('[admin/claims POST]', err)
    return NextResponse.json({ error: 'create failed' }, { status: 500 })
  }
}
