// ─────────────────────────────────────────────────────────────────────────────
// Centralized operational alerting for CRITICAL production failures.
//
// One fail-soft entry point — `alert(input)` — with:
//   • severity levels INFO / WARNING / ERROR / CRITICAL
//   • ONLY safe operational context (type, severity, timestamp, booking ref,
//     tenant, route/worker, error CLASS, retry count, build id, correlation id).
//     Never customer records, payment details, photo URLs, tokens, secrets, or
//     raw stack traces — every string field is defensively redacted + truncated.
//   • deduplication (a failing worker can't storm: the same signature is
//     suppressed for a severity-scaled window).
//   • a provider abstraction that uses the safest ALREADY-configured path:
//     Slack webhook → owner email → structured console (always, the fallback).
//
// Pure formatting/redaction/dedup-key are separated from I/O so they unit-test
// with no network. If no provider env is set, the abstraction still runs and logs
// a structured line; the one config step to enable real delivery is documented in
// `alertProviderStatus()`.
// ─────────────────────────────────────────────────────────────────────────────

import { redis } from './redis'
import { emailRaw } from './booking-emails'

export type Severity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL'
const SEVERITY_RANK: Record<Severity, number> = { INFO: 0, WARNING: 1, ERROR: 2, CRITICAL: 3 }

// Dedup window per severity (ms) — CRITICAL re-alerts fastest, INFO slowest.
const DEDUP_WINDOW_MS: Record<Severity, number> = {
  CRITICAL: 2 * 60_000, ERROR: 5 * 60_000, WARNING: 15 * 60_000, INFO: 60 * 60_000,
}

export type AlertInput = {
  type: string                 // stable event slug, e.g. 'final_analysis_failed'
  severity: Severity
  message?: string             // short human summary (redacted)
  booking?: string             // SAFE ref — bookingNumber or a short token prefix
  tenantId?: string
  route?: string               // API route or worker name
  worker?: string
  errorClass?: string          // safe classification, NEVER a raw stack/message
  retryCount?: number
  correlationId?: string       // request/trace id
  meta?: Record<string, string | number | boolean>
}

export type Environment = 'prod' | 'preview' | 'development' | 'local'

export type AlertPayload = {
  type: string
  severity: Severity
  message: string
  at: string                   // ISO
  build: string
  environment: Environment     // prod vs preview (derived from VERCEL_ENV/VERCEL_URL)
  correlationId: string        // always present — generated if the caller had none
  booking?: string
  tenantId?: string
  route?: string
  worker?: string
  errorClass?: string
  retryCount?: number
  meta?: Record<string, string | number | boolean>
}

// ── Environment + correlation id ─────────────────────────────────────────────
// Prod vs preview so an alert reader instantly knows whether it's real traffic.
export function envLabel(): Environment {
  const e = process.env.VERCEL_ENV
  if (e === 'production') return 'prod'
  if (e === 'preview') return 'preview'
  if (e === 'development') return 'development'
  return process.env.VERCEL_URL ? 'preview' : 'local'
}

// Correlation id when the caller didn't supply one, so a single failure can be
// traced across logs. Short + delimited so redaction never eats it.
function genCorrelationId(): string {
  try {
    const g = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
    if (g?.randomUUID) return `cid_${g.randomUUID()}`
  } catch { /* fall through */ }
  return `cid_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

// ── Redaction (pure) ─────────────────────────────────────────────────────────
const SECRETY = [
  /https?:\/\/\S+/gi,                       // URLs (incl. photo/blob links)
  /\b[A-Za-z0-9+/]{24,}={0,2}\b/g,          // long base64 (tokens/keys)
  /\b[0-9a-f]{24,}\b/gi,                     // long hex (tokens/ids)
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // emails
  /\b(sk|pk|rk|whsec|Bearer)[_\s-]?[A-Za-z0-9_-]+/gi,    // key-ish prefixes
]
export function redactString(v: string, max = 200): string {
  let s = String(v)
  for (const re of SECRETY) s = s.replace(re, '[redacted]')
  return s.length > max ? s.slice(0, max) + '…' : s
}
function redactMeta(meta?: Record<string, string | number | boolean>): Record<string, string | number | boolean> | undefined {
  if (!meta) return undefined
  const out: Record<string, string | number | boolean> = {}
  for (const [k, val] of Object.entries(meta)) {
    if (typeof val === 'string') out[k] = redactString(val, 120)
    else if (typeof val === 'number' || typeof val === 'boolean') out[k] = val
  }
  return out
}

export function buildId(): string {
  return process.env.VERCEL_DEPLOYMENT_ID
    || process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8)
    || process.env.VERCEL_URL
    || 'local'
}

// ── Format (pure) ────────────────────────────────────────────────────────────
export function formatAlert(input: AlertInput, ctx: { now: string; build: string; environment?: Environment }): AlertPayload {
  return {
    type: redactString(input.type, 60),
    severity: input.severity,
    message: redactString(input.message ?? input.type, 200),
    at: ctx.now,
    build: ctx.build,
    environment: ctx.environment ?? envLabel(),
    // Always present: use the caller's id, otherwise mint one so the failure is traceable.
    correlationId: redactString(input.correlationId ?? genCorrelationId(), 80),
    booking: input.booking ? redactString(input.booking, 40) : undefined,
    tenantId: input.tenantId ? redactString(input.tenantId, 40) : undefined,
    route: input.route ? redactString(input.route, 80) : undefined,
    worker: input.worker ? redactString(input.worker, 80) : undefined,
    errorClass: input.errorClass ? redactString(input.errorClass, 80) : undefined,
    retryCount: typeof input.retryCount === 'number' ? input.retryCount : undefined,
    meta: redactMeta(input.meta),
  }
}

// ── Dedup key (pure) — signature that ignores volatile fields ────────────────
export function dedupKey(input: AlertInput): string {
  return `alert:dd:${input.severity}:${input.type}:${input.booking ?? ''}:${input.route ?? input.worker ?? ''}`
}

// ── Provider abstraction ─────────────────────────────────────────────────────
export type AlertProvider = 'slack' | 'email' | 'console' | 'none'

// Recipient for the email fallback. ALERT_EMAIL_TO is the dedicated override;
// OWNER_EMAIL is the sensible default. (Note: OWNER_ALERT_EMAIL in owner-alerts
// is a boolean on/off flag, NOT an address — deliberately not used here.)
export function alertEmailTo(): string | undefined {
  return process.env.ALERT_EMAIL_TO || process.env.OWNER_EMAIL || undefined
}

// Reports the provider that will ACTUALLY be attempted first, in priority order:
// Slack webhook → owner email (Resend) → structured console (always available).
export function alertProviderStatus(): { provider: AlertProvider; configHint?: string } {
  if (process.env.ALERT_SLACK_WEBHOOK_URL) return { provider: 'slack' }
  if (process.env.RESEND_API_KEY && alertEmailTo()) return { provider: 'email' }
  return { provider: 'console', configHint: 'Set ALERT_SLACK_WEBHOOK_URL (Slack Incoming Webhook), or RESEND_API_KEY + ALERT_EMAIL_TO/OWNER_EMAIL, to enable real-time alert delivery; falls back to structured console logs (Vercel logs) meanwhile.' }
}

function summaryLine(payload: AlertPayload): string {
  return [
    payload.booking && `booking ${payload.booking}`,
    payload.tenantId && `tenant ${payload.tenantId}`,
    payload.route && `route ${payload.route}`,
    payload.worker && `worker ${payload.worker}`,
    payload.errorClass && `class ${payload.errorClass}`,
    payload.retryCount != null && `retry ${payload.retryCount}`,
    `env ${payload.environment}`,
    `build ${payload.build}`,
    `cid ${payload.correlationId}`,
  ].filter(Boolean).join(' · ')
}

async function deliverSlack(payload: AlertPayload, url: string): Promise<boolean> {
  const emoji = payload.severity === 'CRITICAL' ? '🔴' : payload.severity === 'ERROR' ? '🟠' : payload.severity === 'WARNING' ? '🟡' : '🔵'
  const lines = [
    `${emoji} *${payload.severity}* · \`${payload.type}\` · _${payload.environment}_`,
    payload.message,
    summaryLine(payload),
  ].filter(Boolean)
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: lines.join('\n') }) })
  return res.ok
}

function esc(v: string): string {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Email fallback — reuses the existing Resend sender (emailRaw). The payload is
// already redacted/truncated, so this can never leak secrets. Returns true only
// if Resend actually accepted it (emailRaw inspects the provider {error}).
async function deliverEmail(payload: AlertPayload, to: string): Promise<boolean> {
  const subject = `[${payload.environment}] ${payload.severity} · ${payload.type}`
  const html =
    `<p style="font-size:15px;margin:0 0 6px"><strong>${esc(payload.severity)}</strong> · <code>${esc(payload.type)}</code> · ${esc(payload.environment)}</p>` +
    `<p style="font-size:14px;color:#333;margin:0 0 12px">${esc(payload.message)}</p>` +
    `<p style="font-size:12px;color:#666;white-space:pre-wrap;margin:0">${esc(summaryLine(payload))}<br/>at ${esc(payload.at)}</p>`
  const res = await emailRaw({ to: [to], subject, html })
  return res.ok
}

// Low-level senders are injectable so the delivery chain unit-tests without any
// real Slack/email network (defaults are the real ones).
export type DeliverIO = {
  slack?: (p: AlertPayload, url: string) => Promise<boolean>
  email?: (p: AlertPayload, to: string) => Promise<boolean>
  log?: (line: string) => void
}

// The default delivery chain: Slack → email → structured console (captured by
// Vercel logs). Never throws — a delivery failure at any step logs and falls
// through, and the console line is ALWAYS emitted last as the durable record.
export async function defaultDeliver(payload: AlertPayload, io: DeliverIO = {}): Promise<AlertProvider> {
  const slack = io.slack ?? deliverSlack
  const email = io.email ?? deliverEmail
  const log = io.log ?? ((line: string) => console.error(line))
  try {
    if (process.env.ALERT_SLACK_WEBHOOK_URL) {
      if (await slack(payload, process.env.ALERT_SLACK_WEBHOOK_URL)) return 'slack'
    }
  } catch (e) {
    try { console.error('[ALERT] slack-delivery-failed', String(e).slice(0, 120)) } catch { /* noop */ }
  }
  try {
    const to = alertEmailTo()
    if (process.env.RESEND_API_KEY && to) {
      if (await email(payload, to)) return 'email'
    }
  } catch (e) {
    try { console.error('[ALERT] email-delivery-failed', String(e).slice(0, 120)) } catch { /* noop */ }
  }
  // Structured, greppable fallback — always emitted.
  log(`[ALERT] ${JSON.stringify(payload)}`)
  return 'console'
}

// ── Orchestration (fail-soft) ────────────────────────────────────────────────
export type AlertDeps = {
  now?: () => number
  build?: string
  shouldSend?: (key: string, windowMs: number) => Promise<boolean>  // dedup gate
  deliver?: (payload: AlertPayload) => Promise<AlertProvider>
}

// Default dedup via KV: first caller in the window wins (setNxPx), rest suppressed.
async function defaultShouldSend(key: string, windowMs: number): Promise<boolean> {
  try { return await redis.setNxPx(key, '1', windowMs) } catch { return true /* never block an alert on a KV hiccup */ }
}

/**
 * Fire an operational alert. NEVER throws (a broken alert path must not break the
 * request/worker). Returns the outcome for callers/tests that care.
 */
export async function alert(input: AlertInput, deps: AlertDeps = {}): Promise<{ sent: boolean; provider: AlertProvider; deduped: boolean }> {
  try {
    const nowIso = new Date(deps.now ? deps.now() : Date.now()).toISOString()
    const payload = formatAlert(input, { now: nowIso, build: deps.build ?? buildId(), environment: envLabel() })
    const gate = deps.shouldSend ?? defaultShouldSend
    const fresh = await gate(dedupKey(input), DEDUP_WINDOW_MS[input.severity])
    if (!fresh) return { sent: false, provider: 'none', deduped: true }
    const deliver = deps.deliver ?? defaultDeliver
    const provider = await deliver(payload)
    return { sent: provider !== 'none', provider, deduped: false }
  } catch (e) {
    try { console.error('[ALERT] delivery-failed', String(e).slice(0, 120)) } catch { /* noop */ }
    return { sent: false, provider: 'none', deduped: false }
  }
}

export const isSeverityAtLeast = (s: Severity, min: Severity) => SEVERITY_RANK[s] >= SEVERITY_RANK[min]
