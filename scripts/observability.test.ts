// Observability: redaction proves secrets/PII never reach a log sink.
import assert from 'node:assert/strict'
import test from 'node:test'

import { redactFields, redactString } from '../app/lib/platform/observability/redact'
import { createLogger, type LogRecord } from '../app/lib/platform/observability/logger'

test('sensitive keys are masked regardless of value', () => {
  const out = redactFields({ password: 'hunter2', token: 'abc', authorization: 'Bearer x', apiKey: 'k', tenantId: 'jkiss' }) as Record<string, string>
  assert.equal(out.password, '[REDACTED]')
  assert.equal(out.token, '[REDACTED]')
  assert.equal(out.authorization, '[REDACTED]')
  assert.equal(out.apiKey, '[REDACTED]')
  assert.equal(out.tenantId, 'jkiss', 'non-sensitive fields pass through')
})

test('sensitive value shapes are masked even under innocuous keys', () => {
  assert.match(redactString('call me at 817-909-4312'), /\[REDACTED:phone\]/)
  assert.match(redactString('email a@b.com'), /\[REDACTED:email\]/)
  assert.match(redactString('Authorization: Bearer abcdef1234567890'), /\[REDACTED:bearer\]/)
  assert.match(redactString('ssn 123-45-6789'), /\[REDACTED:ssn\]/)
  assert.match(redactString('tok deadbeefdeadbeefdeadbeefdeadbeef'), /\[REDACTED:hex\]/)
})

test('nested objects are recursively redacted', () => {
  const out = redactFields({ user: { secret: 's', name: 'A' }, list: [{ password: 'p' }] }) as { user: Record<string, string>; list: Record<string, string>[] }
  assert.equal(out.user.secret, '[REDACTED]')
  assert.equal(out.user.name, 'A')
  assert.equal(out.list[0].password, '[REDACTED]')
})

test('the logger never emits a raw secret to its sink', () => {
  const records: LogRecord[] = []
  const log = createLogger((r) => records.push(r))
  log.info('login for user a@b.com', { password: 'hunter2', tenantId: 'jkiss' })
  const r = records[0]
  assert.equal((r.fields as Record<string, string>).password, '[REDACTED]')
  assert.equal((r.fields as Record<string, string>).tenantId, 'jkiss')
  assert.match(r.msg, /\[REDACTED:email\]/)
  assert.ok(!JSON.stringify(r).includes('hunter2'), 'secret must never appear anywhere in the record')
})

test('child logger merges base context', () => {
  const records: LogRecord[] = []
  const log = createLogger((r) => records.push(r)).child({ tenantId: 'jkiss', correlationId: 'c1' })
  log.warn('x', { workerId: 'ai-coo' })
  const f = records[0].fields as Record<string, string>
  assert.equal(f.tenantId, 'jkiss')
  assert.equal(f.correlationId, 'c1')
  assert.equal(f.workerId, 'ai-coo')
})
