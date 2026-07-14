import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireSession } from '../_lib/session'
import {
  listInvoices, saveInvoice, generateFromRoutes, uninvoicedRoutes,
  generateToken, nextInvoiceNumber, subtotalCents, type RouteInvoice,
} from '../../../lib/route-invoices'
import { parsePayCents } from '../../../lib/route-pay'

const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)

export const GET = withTenantRoute(async (req: NextRequest) => {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const url = new URL(req.url)

  // Preview: how many uninvoiced completed routes a client has in a window.
  if (url.searchParams.get('preview') === '1') {
    const business = S(url.searchParams.get('business'), 200)
    const start = S(url.searchParams.get('start'), 10)
    const end = S(url.searchParams.get('end'), 10)
    if (!business || !isDate(start) || !isDate(end)) return NextResponse.json({ count: 0, suggestedCents: 0 })
    const routes = await uninvoicedRoutes(business, start, end)
    const suggestedCents = routes.reduce((s, r) => s + (parsePayCents(r.payRate) ?? 0), 0)
    return NextResponse.json({ count: routes.length, suggestedCents })
  }

  try {
    const items = await listInvoices()
    return NextResponse.json({ items: items.map(i => ({ ...i, subtotalCents: subtotalCents(i) })) })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'list failed'
    if (msg === 'UPSTASH_NOT_CONFIGURED') return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    console.error('[route-invoices GET]', err)
    return NextResponse.json({ error: 'list failed' }, { status: 500 })
  }
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const b = await req.json().catch(() => ({}))
  const action = S(b.action, 40) || 'generate'
  const businessName = S(b.businessName, 200)
  if (!businessName) return NextResponse.json({ error: 'Business/client name is required.' }, { status: 400 })
  const clientName = S(b.clientName, 160) || undefined
  const clientEmail = S(b.clientEmail, 200) || undefined

  if (action === 'blank') {
    const now = Date.now()
    const inv: RouteInvoice = {
      token: generateToken(), invoiceNumber: await nextInvoiceNumber(), businessName,
      clientName, clientEmail, lines: [], status: 'draft', amountPaidCents: 0, createdAt: now, updatedAt: now,
    }
    await saveInvoice(inv)
    return NextResponse.json({ ok: true, invoice: inv })
  }

  // Default: generate from completed routes in a period.
  const start = S(b.start, 10), end = S(b.end, 10)
  if (!isDate(start) || !isDate(end)) return NextResponse.json({ error: 'A valid period (start and end date) is required.' }, { status: 400 })
  const res = await generateFromRoutes(businessName, start, end, { clientName, clientEmail })
  if ('error' in res) return NextResponse.json({ error: res.error }, { status: 400 })
  return NextResponse.json({ ok: true, invoice: res.invoice, count: res.count })
})
