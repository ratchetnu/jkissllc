import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission, requireAdmin } from '../_lib/session'
import { can } from '../../../lib/rbac'
import { listStaff, saveStaff, deleteStaff, redactStaffForViewer, type Staff, type PayKind, type PayHistoryEntry } from '../../../lib/staff'
import { bizKey } from '../../../lib/businesses'
import { parseMoneyCents } from '../../../lib/finance'
import { repriceCrewRoutes, repriceCandidates, isApplyTo, type ApplyTo } from '../../../lib/route-reprice'

const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

// Merge a W-9 patch (1099 readiness). Absent = keep existing. We store only the
// last 4 of the TIN — never the full SSN/EIN.
const W9_STATUSES = ['not_collected', 'on_file', 'verified'] as const
function parseW9(patch: unknown, existing: Staff['w9']): Staff['w9'] {
  if (!patch || typeof patch !== 'object') return existing
  const p = patch as Record<string, unknown>
  const status = (W9_STATUSES as readonly string[]).includes(String(p.status)) ? p.status as NonNullable<Staff['w9']>['status'] : (existing?.status ?? 'not_collected')
  const tinRaw = typeof p.tinLast4 === 'string' ? p.tinLast4.replace(/\D/g, '').slice(-4) : undefined
  return {
    status,
    addressComplete: typeof p.addressComplete === 'boolean' ? p.addressComplete : existing?.addressComplete,
    tinLast4: tinRaw !== undefined ? (tinRaw || undefined) : existing?.tinLast4,
    collectedAt: status !== 'not_collected' ? (existing?.collectedAt ?? Date.now()) : existing?.collectedAt,
  }
}
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)
const PAY_KINDS: PayKind[] = ['driver', 'helper', 'contractor', 'employee']
const isPayKind = (v: unknown): v is PayKind => typeof v === 'string' && (PAY_KINDS as string[]).includes(v)

// Two crew members are "same pay" only if every business override matches too.
const sameRates = (a: Record<string, number> | undefined, b: Record<string, number> | undefined): boolean => {
  const ka = Object.keys(a ?? {}), kb = Object.keys(b ?? {})
  return ka.length === kb.length && ka.every(k => a?.[k] === b?.[k])
}

export const GET = withTenantRoute(async (req: NextRequest) => {
  // Read the crew directory — admin + manager (crew:view). Writes below stay admin-only.
  const who = await requirePermission(req, 'crew:view')
  if (who instanceof NextResponse) return who
  // Pay/tax fields ride on the Staff record but are governed by pay:view:all / tax:view.
  // A manager holds crew:view (this gate) but neither of those, so redact for them.
  const canSeePay = can(who.role, 'pay:view:all')
  const canSeeTax = can(who.role, 'tax:view')
  // ?candidates=<staffId> lists the live routes a pay change could apply to — that
  // surfaces route pay, so it's for pay-viewers (the admin pay editor) only.
  const candidatesFor = new URL(req.url).searchParams.get('candidates')
  if (candidatesFor) {
    if (!canSeePay) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    return NextResponse.json({ ok: true, items: await repriceCandidates({ staffId: candidatesFor }) })
  }
  const items = await listStaff()
  return NextResponse.json({ ok: true, items: items.map((s) => redactStaffForViewer(s, { pay: canSeePay, tax: canSeeTax })) })
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  // Crew records + pay settings are admin-only (crew:manage / pay:configure).
  // Managers assign crew to routes via the routes API, not here.
  const who = await requireAdmin(req)
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({}))
  const name = S(body.name, 80)
  if (!name) return NextResponse.json({ error: 'A name is required.' }, { status: 400 })

  const id = typeof body.id === 'string' && body.id ? body.id : crypto.randomUUID()
  const now = Date.now()
  const existing = body.id ? (await listStaff()).find(s => s.id === body.id) : undefined

  // ── Pay settings ──
  // `defaultPay` is a dollar amount. Absent = leave as-is; empty = clear it.
  let defaultPayCents = existing?.defaultPayCents
  if (body.defaultPay !== undefined) {
    const raw = S(body.defaultPay, 40)
    if (!raw) defaultPayCents = undefined
    else {
      const cents = parseMoneyCents(raw)
      if (cents == null) return NextResponse.json({ error: 'Default route pay must be a positive dollar amount.' }, { status: 400 })
      defaultPayCents = cents
    }
  }

  // `payByBusiness` arrives as { "<business name>": "<dollars>" }; stored keyed by
  // bizKey so it joins against route.businessName however it's cased.
  let payByBusiness = existing?.payByBusiness
  if (body.payByBusiness !== undefined) {
    if (body.payByBusiness === null) payByBusiness = undefined
    else if (typeof body.payByBusiness !== 'object') {
      return NextResponse.json({ error: 'Business-specific pay must be an object.' }, { status: 400 })
    } else {
      const out: Record<string, number> = {}
      for (const [bizName, raw] of Object.entries(body.payByBusiness as Record<string, unknown>)) {
        const label = S(bizName, 200)
        if (!label) continue
        if (raw === '' || raw === null) continue           // blank = remove the override
        const cents = parseMoneyCents(raw)
        if (cents == null) return NextResponse.json({ error: `Pay for ${label} must be a positive dollar amount.` }, { status: 400 })
        out[bizKey(label)] = cents
      }
      payByBusiness = Object.keys(out).length ? out : undefined
    }
  }

  const payActive = typeof body.payActive === 'boolean' ? body.payActive : (existing?.payActive ?? true)
  if (payActive && defaultPayCents === undefined && !payByBusiness && body.defaultPay !== undefined) {
    return NextResponse.json({ error: 'Set a default route pay, or mark this pay inactive.' }, { status: 400 })
  }

  const payKind = isPayKind(body.payKind) ? body.payKind : existing?.payKind
  const payNotes = body.payNotes !== undefined ? (S(body.payNotes, 1000) || undefined) : existing?.payNotes
  const payEffectiveDate = body.payEffectiveDate !== undefined
    ? (isDate(S(body.payEffectiveDate, 20)) ? S(body.payEffectiveDate, 20) : undefined)
    : existing?.payEffectiveDate

  const payChanged = existing
    ? existing.defaultPayCents !== defaultPayCents || !sameRates(existing.payByBusiness, payByBusiness) || (existing.payActive ?? true) !== payActive
    : defaultPayCents !== undefined || payByBusiness !== undefined

  const payHistory: PayHistoryEntry[] = [...(existing?.payHistory ?? [])]
  if (payChanged) {
    payHistory.push({ at: now, defaultPayCents, payByBusiness, effectiveDate: payEffectiveDate, active: payActive, notes: payNotes })
    if (payHistory.length > 50) payHistory.splice(0, payHistory.length - 50)
  }

  const staff: Staff = {
    id, name,
    phone: typeof body.phone === 'string' ? body.phone.trim().slice(0, 40) || undefined : existing?.phone,
    role: typeof body.role === 'string' ? body.role.trim().slice(0, 60) || undefined : existing?.role,
    photoUrl: typeof body.photoUrl === 'string' ? body.photoUrl.trim().slice(0, 600) || undefined : existing?.photoUrl,
    active: body.active !== false && body.active !== 'false',
    // Absent in the request = leave as-is; present = the toggle's new value.
    usesTimeclock: typeof body.usesTimeclock === 'boolean' ? body.usesTimeclock : existing?.usesTimeclock,
    payKind,
    defaultPayCents,
    payByBusiness,
    payNotes,
    payEffectiveDate,
    payActive,
    payHistory: payHistory.length ? payHistory : undefined,
    // Preserve fields the edit form doesn't carry (were silently dropped before).
    email: existing?.email,
    applicantId: existing?.applicantId,
    onboarding: existing?.onboarding,
    w9: parseW9(body.w9, existing?.w9),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await saveStaff(staff)

  // Apply the new pay to routes already on the board. Default 'none'. Completed
  // routes keep the pay they ran at; a pay typed in by hand for one route wins.
  let reprice = null
  if (payChanged) {
    const applyTo: ApplyTo = isApplyTo(body.applyTo) ? body.applyTo : 'none'
    const tokens = Array.isArray(body.routeTokens) ? (body.routeTokens as unknown[]).filter((t): t is string => typeof t === 'string') : []
    try { reprice = await repriceCrewRoutes(staff, applyTo, tokens) }
    catch { reprice = null /* the rate saved; re-pricing is best-effort */ }
  }

  return NextResponse.json({ ok: true, staff, reprice })
})

export const DELETE = withTenantRoute(async (req: NextRequest) => {
  const who = await requireAdmin(req)
  if (who instanceof NextResponse) return who
  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  await deleteStaff(id)
  return NextResponse.json({ ok: true })
})
