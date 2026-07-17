// The communication service (Phase 4). ONE entry point — dispatchComm — that turns
// (event, context) into rendered, validated, safety-checked, logged, provider-sent
// messages. It reuses the existing rails end to end: sms.ts (Twilio, with its own
// opt-out + suppression), booking-emails.ts emailRaw (Resend), and messages.ts as
// the ledger. It never introduces a second provider.
//
// Safety applied in order: send-mode gate → idempotency/duplicate → per-channel
// contact check → opt-out → quiet hours → send (with retries) → ledger + audit.
//
// dispatchComm takes an injectable `deps` bag so unit tests exercise the full
// decision tree with fakes — no real provider call, no Redis. Defaults wire to
// production implementations.

import { sendSmsDetailed, toE164, type SmsDetail } from '../sms'
import { emailRaw, type EmailResult } from '../booking-emails'
import { recordMessage } from '../messages'
import { redis } from '../redis'
import { recordAudit } from '../audit'
import type { CommContext } from './context'
import type { CommChannel, CommEvent } from './events'
import { getEventDef } from './events'
import { renderTemplate } from './templates'
import { isSmsOptedOut, isEmailOptedOut } from './optout'
import {
  resolveSendMode, inQuietHours, idempotencyKey, DUP_WINDOW_MS, MAX_ATTEMPTS,
  type SendMode,
} from './policy'

export type ChannelStatus = 'sent' | 'failed' | 'simulated' | 'suppressed' | 'skipped'

export type ChannelOutcome = {
  channel: CommChannel
  status: ChannelStatus
  providerId?: string
  error?: string
  reason?: string   // why suppressed/skipped (no_phone, opted_out, quiet_hours, …)
  attempts?: number
}

export type DispatchResult = {
  event: CommEvent
  mode: SendMode
  idempotencyKey: string
  duplicate: boolean
  missingVars: string[]
  outcomes: ChannelOutcome[]
  loggedMessageIds: string[]
}

// The trigger source — used for the marketing auto-send guard and audit trail.
export type CommTrigger = 'manual' | 'automation' | 'system'

export type DispatchOptions = {
  channels?: CommChannel[]      // override the event's default channel set
  idempotencyKey?: string       // explicit key for precise duplicate control
  allowQuietHours?: boolean     // let a reminder through during quiet hours
  actor?: string                // who initiated (ledger + audit)
  actorRole?: string
  trigger?: CommTrigger         // default 'manual'
  mode?: SendMode               // force a mode (tests / dry-run)
  now?: number
}

// Injectable seams. Defaults call the real modules.
export type CommDeps = {
  now: () => number
  sendSms: (to: string | undefined | null, body: string) => Promise<SmsDetail>
  sendEmail: (args: { to: string[]; subject: string; html: string; replyTo?: string }) => Promise<EmailResult>
  isSmsOptedOut: (phone?: string | null) => Promise<boolean>
  isEmailOptedOut: (email?: string | null) => Promise<boolean>
  claim: (key: string, ttlMs: number) => Promise<boolean>   // atomic idempotency claim
  record: (msg: Parameters<typeof recordMessage>[0]) => Promise<{ id: string }>
  audit: (a: Parameters<typeof recordAudit>[0]) => Promise<unknown>
}

const defaultDeps: CommDeps = {
  now: () => Date.now(),
  sendSms: sendSmsDetailed,
  sendEmail: emailRaw,
  isSmsOptedOut,
  isEmailOptedOut,
  claim: (key, ttlMs) => redis.setNxPx(key, '1', ttlMs),
  record: recordMessage,
  audit: recordAudit,
}

function isRetryable(d: SmsDetail): boolean {
  // Retry only transient failures: network error (no httpStatus) or 5xx. A 4xx
  // (bad number, opted out, auth) will never succeed on retry — don't hammer it.
  if (d.ok) return false
  return d.httpStatus === undefined || d.httpStatus >= 500
}

async function sendSmsWithRetry(
  deps: CommDeps, to: string, body: string,
): Promise<{ detail: SmsDetail; attempts: number }> {
  let detail = await deps.sendSms(to, body)
  let attempts = 1
  while (!detail.ok && isRetryable(detail) && attempts < MAX_ATTEMPTS) {
    detail = await deps.sendSms(to, body)
    attempts++
  }
  return { detail, attempts }
}

export async function dispatchComm(
  event: CommEvent,
  ctx: CommContext,
  opts: DispatchOptions = {},
  depsOverride?: Partial<CommDeps>,
): Promise<DispatchResult> {
  const deps: CommDeps = { ...defaultDeps, ...(depsOverride ?? {}) }
  const def = getEventDef(event)
  const now = opts.now ?? deps.now()
  const mode = resolveSendMode(opts.mode)
  const trigger: CommTrigger = opts.trigger ?? 'manual'

  const channels: CommChannel[] = (opts.channels?.length ? opts.channels : def.channels)
    .filter(ch => def.channels.includes(ch))

  const rendered = renderTemplate(event, ctx, channels)
  const key = idempotencyKey(event, ctx, opts.idempotencyKey)

  const base: DispatchResult = {
    event, mode, idempotencyKey: key, duplicate: false,
    missingVars: rendered.missing, outcomes: [], loggedMessageIds: [],
  }

  // Marketing auto-send guard: never auto-send a marketing message. (No event in
  // the catalog is marketing today; this keeps the guarantee if one is ever added.)
  if (def.marketing && trigger === 'automation') {
    base.outcomes = channels.map(channel => ({ channel, status: 'suppressed' as const, reason: 'marketing_autosend_blocked' }))
    return base
  }

  // Send-mode gate: 'off' short-circuits with no idempotency burn, no ledger write.
  if (mode === 'off') {
    base.outcomes = channels.map(channel => ({ channel, status: 'suppressed' as const, reason: 'send_mode_off' }))
    return base
  }

  // Idempotency / duplicate prevention: claim once per (key) within the window.
  // A lost claim means an identical message already went out recently → skip.
  const won = await deps.claim(key, DUP_WINDOW_MS)
  if (!won) {
    base.duplicate = true
    base.outcomes = channels.map(channel => ({ channel, status: 'skipped' as const, reason: 'duplicate' }))
    return base
  }

  const reminderQuiet = def.reminder && !opts.allowQuietHours && inQuietHours(now)

  for (const channel of channels) {
    if (channel === 'sms') {
      const dest = toE164(ctx.phone ?? '')
      if (!dest) { base.outcomes.push({ channel, status: 'skipped', reason: 'no_phone' }); continue }
      if (await deps.isSmsOptedOut(dest)) { base.outcomes.push({ channel, status: 'suppressed', reason: 'sms_opted_out' }); continue }
      if (reminderQuiet) { base.outcomes.push({ channel, status: 'suppressed', reason: 'quiet_hours' }); continue }
      const body = rendered.sms ?? ''
      if (!body.trim()) { base.outcomes.push({ channel, status: 'skipped', reason: 'empty_body' }); continue }

      if (mode === 'test') {
        const id = await logMessage(deps, { event, channel: 'sms', provider: 'twilio', to: dest, body, ctx, opts, status: 'queued', simulated: true })
        base.outcomes.push({ channel, status: 'simulated', attempts: 0 })
        if (id) base.loggedMessageIds.push(id)
        continue
      }
      // live
      const { detail, attempts } = await sendSmsWithRetry(deps, dest, body)
      const id = await logMessage(deps, {
        event, channel: 'sms', provider: 'twilio', to: dest, body, ctx, opts,
        status: detail.ok ? 'sent' : 'failed', providerMessageId: detail.ok ? detail.sid : undefined,
      })
      if (id) base.loggedMessageIds.push(id)
      base.outcomes.push({
        channel, status: detail.ok ? 'sent' : 'failed', attempts,
        providerId: detail.ok ? detail.sid : undefined,
        error: detail.ok ? undefined : detail.error,
      })
    } else if (channel === 'email') {
      const email = ctx.email
      if (!email) { base.outcomes.push({ channel, status: 'skipped', reason: 'no_email' }); continue }
      if (await deps.isEmailOptedOut(email)) { base.outcomes.push({ channel, status: 'suppressed', reason: 'email_opted_out' }); continue }
      if (reminderQuiet) { base.outcomes.push({ channel, status: 'suppressed', reason: 'quiet_hours' }); continue }
      const em = rendered.email
      if (!em) { base.outcomes.push({ channel, status: 'skipped', reason: 'no_email_template' }); continue }

      if (mode === 'test') {
        const id = await logMessage(deps, { event, channel: 'email', provider: 'resend', to: email, subject: em.subject, body: em.subject, ctx, opts, status: 'queued', simulated: true })
        base.outcomes.push({ channel, status: 'simulated', attempts: 0 })
        if (id) base.loggedMessageIds.push(id)
        continue
      }
      // live
      const res = await deps.sendEmail({ to: [email], subject: em.subject, html: em.html, replyTo: undefined })
      const id = await logMessage(deps, {
        event, channel: 'email', provider: 'resend', to: email, subject: em.subject, body: em.subject, ctx, opts,
        status: res.ok ? 'sent' : 'failed', providerMessageId: res.ok ? res.id : undefined,
      })
      if (id) base.loggedMessageIds.push(id)
      base.outcomes.push({
        channel, status: res.ok ? 'sent' : 'failed', attempts: 1,
        providerId: res.ok ? res.id : undefined, error: res.ok ? undefined : res.error,
      })
    }
  }

  // Audit only real sends (live). Best-effort; never fails the dispatch.
  if (mode === 'live') {
    const sent = base.outcomes.filter(o => o.status === 'sent').map(o => o.channel)
    try {
      await deps.audit({
        actor: opts.actor ?? 'system', actorRole: opts.actorRole ?? 'system',
        action: 'comm.dispatched', entity: 'comm', entityId: key,
        summary: `${def.label} → ${ctx.customerName ?? ctx.phone ?? ctx.email ?? 'recipient'} (${sent.join(', ') || 'no channel'})`,
        meta: { event, trigger, channels: base.outcomes },
      })
    } catch { /* audit is best-effort */ }
  }

  return base
}

// Write one row to the shared communications ledger (messages.ts). Tagged so the
// history view can tell comms-layer sends apart and identify simulated ones.
async function logMessage(
  deps: CommDeps,
  a: {
    event: CommEvent; channel: 'sms' | 'email'; provider: 'twilio' | 'resend'
    to: string; subject?: string; body: string; ctx: CommContext; opts: DispatchOptions
    status: 'queued' | 'sent' | 'failed'; providerMessageId?: string; simulated?: boolean
  },
): Promise<string | null> {
  const tags = ['comms', `event:${a.event}`]
  if (a.simulated) tags.push('simulated')
  if (a.opts.actor) tags.push(`by:${a.opts.actor}`)
  try {
    const m = await deps.record({
      direction: 'outbound', channel: a.channel, provider: a.provider,
      providerMessageId: a.providerMessageId,
      to: a.to, subject: a.subject, body: a.body,
      customerId: a.ctx.customerId, customerName: a.ctx.customerName,
      customerPhone: a.channel === 'sms' ? a.to : undefined,
      customerEmail: a.channel === 'email' ? a.to : undefined,
      bookingToken: a.ctx.bookingId, bookingNumber: a.ctx.bookingNumber,
      jobId: a.ctx.jobId, quoteId: a.ctx.quoteId,
      status: a.status, tags,
    })
    return m.id
  } catch (e) {
    console.error('[comms] ledger write failed', e)
    return null
  }
}
