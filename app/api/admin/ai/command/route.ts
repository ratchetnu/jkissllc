import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../../_lib/session'
import { aiText } from '../../../../lib/ai'
import { listBusinesses } from '../../../../lib/businesses'
import { listStaff } from '../../../../lib/staff'
import { listRoutes } from '../../../../lib/routes'
import { listClaims, isTerminal } from '../../../../lib/claims'
import { centralToday, addDaysStr } from '../../../../lib/dates'

export const maxDuration = 30

// POST /api/admin/ai/command — the natural-language layer behind the ⌘K command
// palette. It maps a free-text request to ONE server-defined navigation target, or
// answers a quick factual question from the provided data.
//
// Safety: the model never emits a URL. It may only return the `id` of a target from
// a server-built allowlist; the server maps that id → href. So a hallucinated route
// is impossible — an unknown id just falls back to a plain search. Answers are drawn
// only from the compact data summary we pass in; the prompt forbids inventing facts.
type Target = { id: string; label: string; href: string; hint?: string }

const STATIC_TARGETS: Target[] = [
  { id: 'home', label: 'Home', href: '/admin/operations' },
  { id: 'ops', label: 'All operations / routes', href: '/admin/operations/list' },
  { id: 'ops-upcoming', label: "Upcoming routes (today, tomorrow, later)", href: '/admin/operations/list?filter=upcoming' },
  { id: 'ops-attention', label: 'Routes needing attention (unconfirmed, declined, understaffed)', href: '/admin/operations/list?filter=attention' },
  { id: 'ops-completed', label: 'Completed routes', href: '/admin/operations/list?filter=completed' },
  { id: 'new', label: 'Create a new route / assignment / recurring route', href: '/admin/operations/new' },
  { id: 'crew', label: 'Crew members and applicants', href: '/admin/operations/employees' },
  { id: 'businesses', label: 'Businesses / clients', href: '/admin/operations/businesses' },
  { id: 'equipment', label: 'Equipment (trucks & gear)', href: '/admin/operations/equipment' },
  { id: 'claims', label: 'Claims (damage, disputes, ClaimGuard)', href: '/admin/operations/claims' },
  { id: 'messages', label: 'Messages / inbox', href: '/admin/operations/messages' },
  { id: 'finance', label: 'Finance, money, revenue, profitability, pay report', href: '/admin/operations/finance' },
  { id: 'invoices', label: 'Client invoices / billing', href: '/admin/routes/invoices' },
  { id: 'pay', label: 'Crew pay statement / payroll report', href: '/admin/routes/pay' },
  { id: 'settings', label: 'Settings', href: '/admin/operations/settings' },
]

const S = (v: unknown, max = 400): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status })

export async function POST(req: NextRequest) {
  if (!(await requireSession(req))) return bad('unauthorized', 401)
  const body = await req.json().catch(() => ({}))
  const query = S(body.query, 400)
  if (!query) return bad('Ask me something.')

  try {
    const [businesses, staff, routes, claims] = await Promise.all([
      listBusinesses(500), listStaff(200), listRoutes(500), listClaims(500),
    ])

    // Dynamic targets: real businesses, crew, and near-term routes. Every href is
    // server-built here — the model only ever echoes an id back.
    const dynamic: Target[] = []
    for (const b of businesses.slice(0, 60)) dynamic.push({ id: `biz:${b.key}`, label: `Business: ${b.name}`, href: '/admin/operations/businesses' })
    for (const s of staff.filter(x => x.active).slice(0, 60)) dynamic.push({ id: `crew:${s.id}`, label: `Crew member: ${s.name}${s.role ? ` (${s.role})` : ''}`, href: '/admin/operations/employees' })

    const today = centralToday()
    const tomorrow = addDaysStr(today, 1)
    for (const r of routes.filter(r => r.routeDate >= today && !['cancelled', 'completed'].includes(r.status)).slice(0, 40))
      dynamic.push({ id: `route:${r.token}`, label: `Route ${r.routeNumber} · ${r.businessName} · ${r.routeDate}`, href: `/admin/operations/${r.token}` })

    const targets = [...STATIC_TARGETS, ...dynamic]

    // Compact data summary for factual answers (counts only — no PII beyond names).
    const openClaims = claims.filter(c => !isTerminal(c.status))
    const summary = {
      today, tomorrow,
      routes: {
        today: routes.filter(r => r.routeDate === today && r.status !== 'cancelled').length,
        tomorrow: routes.filter(r => r.routeDate === tomorrow && r.status !== 'cancelled').length,
        unconfirmedUpcoming: routes.filter(r => r.routeDate >= today && (r.status === 'assigned' || r.status === 'text_sent')).length,
      },
      crewActive: staff.filter(s => s.active).length,
      businesses: businesses.length,
      openClaims: openClaims.length,
    }

    const r = await aiText({
      system:
        'You are the command bar for OpsPilot, a logistics operations platform. Map the user\'s request to exactly ONE target from the TARGETS list, or answer a short factual question using ONLY the DATA provided. ' +
        'Respond with a single minified JSON object and nothing else. To navigate: {"targetId":"<id from TARGETS>"}. To answer: {"answer":"<one or two sentences>"}. ' +
        'Never invent ids, routes, names, numbers, or facts. If nothing fits, return {"targetId":"ops"}. Prefer navigation over answering when the user clearly wants to go somewhere or do something.',
      prompt:
        `USER REQUEST: ${query}\n\n` +
        `TARGETS (id — description):\n${targets.map(t => `${t.id} — ${t.label}`).join('\n')}\n\n` +
        `DATA (for factual answers only):\n${JSON.stringify(summary)}`,
      maxOutputTokens: 200,
      temperature: 0.1,
    })
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 503 })

    // Tolerant parse — pull the first {...} even if the model wrapped it.
    const match = r.text.match(/\{[\s\S]*\}/)
    let parsed: { targetId?: string; answer?: string } = {}
    try { parsed = match ? JSON.parse(match[0]) : {} } catch { /* fall through */ }

    if (parsed.targetId) {
      const t = targets.find(x => x.id === parsed.targetId)
      if (t) return NextResponse.json({ ok: true, kind: 'navigate', href: t.href, label: t.label })
    }
    if (parsed.answer) return NextResponse.json({ ok: true, kind: 'answer', answer: S(parsed.answer, 500) })

    // Couldn't resolve — send them to the full operations list as a safe default.
    return NextResponse.json({ ok: true, kind: 'navigate', href: '/admin/operations/list', label: 'All operations' })
  } catch (e) {
    console.error('[ai/command]', e)
    return bad('Command failed — please try again.', 500)
  }
}
