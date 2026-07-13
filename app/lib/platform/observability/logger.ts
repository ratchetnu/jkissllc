// ── Structured logging abstraction ───────────────────────────────────────────
//
// A thin, provider-agnostic structured logger. Every record is JSON with the
// standard correlation fields (tenant, actor, worker, event, approval,
// correlation ids) and is redacted before it leaves the process. The sink is
// injectable so a future provider (Sentry, a log platform) is a one-line swap —
// no call-site changes. See 12-observability-and-operations.md.

import { redactFields, redactString } from './redact'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogContext = {
  tenantId?: string
  actorId?: string
  workerId?: string
  eventId?: string
  approvalId?: string
  correlationId?: string
  route?: string
}

export type LogRecord = {
  level: LogLevel
  msg: string
  fields: Record<string, unknown>
}

export type LogSink = (record: LogRecord) => void

// Default sink: structured JSON to the appropriate console stream. Redaction has
// already happened by the time a record reaches a sink.
export const consoleSink: LogSink = (r) => {
  const line = JSON.stringify({ level: r.level, msg: r.msg, ...r.fields })
  if (r.level === 'error') console.error(line)
  else if (r.level === 'warn') console.warn(line)
  else console.log(line)
}

export type Logger = {
  debug(msg: string, ctx?: LogContext & Record<string, unknown>): void
  info(msg: string, ctx?: LogContext & Record<string, unknown>): void
  warn(msg: string, ctx?: LogContext & Record<string, unknown>): void
  error(msg: string, ctx?: LogContext & Record<string, unknown>): void
  child(base: LogContext): Logger
}

export function createLogger(sink: LogSink = consoleSink, base: LogContext = {}): Logger {
  const emit = (level: LogLevel, msg: string, ctx?: Record<string, unknown>) => {
    const fields = redactFields({ ...base, ...(ctx ?? {}) })
    sink({ level, msg: redactString(msg), fields })
  }
  return {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
    child: (childBase) => createLogger(sink, { ...base, ...childBase }),
  }
}

/** The default process logger. */
export const logger = createLogger()
