import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '../../_lib/session'
import { sendImmediate } from '../../../../lib/reminder-engine'
import { buildCrewCards, filterBySegment } from '../../../../lib/reminder-segments'
import {
  getTemplate, DISPATCH_ACTIONS, ALL_CHANNELS,
  type ReminderChannel, type AckKind, type SegmentId,
} from '../../../../lib/reminder-templates'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const ALL_ACKS: AckKind[] = ['acknowledged', 'completed', 'calling', 'need_help', 'already_done', 'having_issues', 'unable']
const strArr = (v: unknown): string[] => Array.isArray(v) ? v.filter(x => typeof x === 'string').map(x => (x as string).trim()).filter(Boolean).slice(0, 1000) : []

// Immediate send: Command Center bulk (request Part 14) + Dispatch quick-blast
// (request Part 13). One endpoint, `origin` = 'dispatch' | 'bulk'. Recipients come
// from explicit staffIds and/or a live segment and/or businesses; dispatch bypasses
// suppression, bulk may opt in.
export async function POST(req: NextRequest) {
  const who = await requirePermission(req, 'messages:send')
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({})) as Record<string, unknown>

  const origin = body.origin === 'dispatch' ? 'dispatch' as const : 'bulk' as const
  if (origin === 'dispatch') {
    const disp = await requirePermission(req, 'dispatch:send')
    if (disp instanceof NextResponse) return disp
  }

  // Message source: a dispatch action, a template, or a fully custom message.
  let title = S(body.title, 120)
  let message = S(body.message, 1000)
  let templateId = S(body.templateId, 60) || 'custom'
  let ackOptions = (Array.isArray(body.ackOptions) ? body.ackOptions : []).filter((a): a is AckKind => ALL_ACKS.includes(a as AckKind))

  const dispatchId = S(body.dispatchId, 60)
  if (dispatchId) {
    const d = DISPATCH_ACTIONS.find(x => x.id === dispatchId)
    if (!d) return NextResponse.json({ error: 'unknown_dispatch_action' }, { status: 400 })
    title = title || d.label
    message = message || d.message
    ackOptions = ackOptions.length ? ackOptions : d.ackOptions
    templateId = 'custom'
  } else if (body.templateId) {
    const t = getTemplate(templateId)
    title = title || t.label
    message = message || t.defaultMessage
    ackOptions = ackOptions.length ? ackOptions : t.ackOptions
  }
  if (!title) return NextResponse.json({ error: 'A title is required.' }, { status: 400 })
  if (!message) return NextResponse.json({ error: 'A message is required.' }, { status: 400 })

  const channels = (Array.isArray(body.channels) ? body.channels : [])
    .filter((c): c is ReminderChannel => ALL_CHANNELS.includes(c as ReminderChannel))
  const finalChannels = channels.length ? Array.from(new Set(channels)) : (['inapp', 'sms'] as ReminderChannel[])
  const requireAck = typeof body.requireAck === 'boolean' ? body.requireAck : origin === 'dispatch'

  // Resolve recipients.
  let staffIds = strArr(body.staffIds)
  const segment = S(body.segment, 40) as SegmentId
  const businessKeys = new Set(strArr(body.businessKeys))
  if (segment || businessKeys.size) {
    const cards = await buildCrewCards()
    const fromSeg = segment ? filterBySegment(cards, segment).map(c => c.id) : []
    const fromBiz = businessKeys.size ? cards.filter(c => c.businessKeys.some(k => businessKeys.has(k))).map(c => c.id) : []
    staffIds = Array.from(new Set([...staffIds, ...fromSeg, ...fromBiz]))
  }
  if (!staffIds.length) return NextResponse.json({ error: 'Select at least one crew member.' }, { status: 400 })

  const { sent, instances } = await sendImmediate({
    staffIds, title, message, channels: finalChannels,
    requireAck, ackOptions: ackOptions.length ? ackOptions : ['acknowledged'],
    templateId, origin, createdBy: who.sub, createdByRole: who.role,
    suppress: origin === 'bulk' ? body.suppress === true : false,
  })

  return NextResponse.json({
    ok: true, sent, requested: staffIds.length,
    instances: instances.map(i => ({ id: i.id, staffId: i.staffId, staffName: i.staffName, channels: i.channelResults })),
  })
}
