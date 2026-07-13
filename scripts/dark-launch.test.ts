// Dark-launch comparison: mismatch classification + summary tallying.
import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyMismatch, recordComparison, newSummary } from '../app/lib/platform/tenancy/dark-launch'

test('equal values are not a mismatch', () => {
  assert.equal(classifyMismatch('x', 'x'), null)
  assert.equal(classifyMismatch(null, null), null)
})

test('missing / stale tenant copies are classified', () => {
  assert.equal(classifyMismatch('legacy', null), 'missing-tenant-copy')
  assert.equal(classifyMismatch(null, 'tenant'), 'stale-tenant-copy')
})

test('serialization-only differences are distinguished from value differences', () => {
  assert.equal(classifyMismatch('{"a":1,"b":2}', '{"b":2,"a":1}'), 'serialization-mismatch')
  assert.equal(classifyMismatch('{"a":1}', '{"a":2}'), 'value-mismatch')
  assert.equal(classifyMismatch('plain-a', 'plain-b'), 'value-mismatch')
})

test('recordComparison tallies a summary and never throws on values', () => {
  const s = newSummary()
  assert.equal(recordComparison('bk:1', 'jkiss', 'x', 'x', { summary: s }), null)
  assert.equal(recordComparison('bk:1', 'jkiss', 'a', null, { summary: s }), 'missing-tenant-copy')
  assert.equal(recordComparison('bk:1', 'jkiss', '{"a":1}', '{"a":2}', { summary: s }), 'value-mismatch')
  assert.equal(s.ok, 1)
  assert.equal(s['missing-tenant-copy'], 1)
  assert.equal(s['value-mismatch'], 1)
})
