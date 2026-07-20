import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

import { effectiveJobPhase } from '../app/lib/platform/release/projection'
import { syncProductAllowed } from '../app/lib/platform/sync/service'

const ROOT = path.resolve(import.meta.dirname, '..')

test('newest completed or cancelled attempt clears an older failure from current status', () => {
  assert.equal(effectiveJobPhase({ status: 'cancelled', updatedAt: 300 }), 'none')
  assert.equal(effectiveJobPhase({ status: 'completed', updatedAt: 300 }), 'none')
})

test('a failed attempt remains current until a newer provider check supersedes it', () => {
  assert.equal(effectiveJobPhase({ status: 'failed', updatedAt: 200 }, 199), 'failed')
  assert.equal(effectiveJobPhase({ status: 'failed', updatedAt: 200 }, 200), 'none')
  assert.equal(effectiveJobPhase({ status: 'failed', updatedAt: 200 }, 201), 'none')
})

test('active automation still controls current status while it is running', () => {
  assert.equal(effectiveJobPhase({ status: 'testing', updatedAt: 200 }, 300), 'running')
  assert.equal(effectiveJobPhase({ status: 'preview_deploying', updatedAt: 200 }, 300), 'preview_deploying')
  assert.equal(effectiveJobPhase({ status: 'awaiting_owner_review', updatedAt: 200 }, 300), 'awaiting_approval')
})

test('production reconciliation can be enabled for Supercharged only', () => {
  const env = { OPERION_SYNC_PRODUCT_IDS: 'supercharged' }
  assert.equal(syncProductAllowed('supercharged', env), true)
  assert.equal(syncProductAllowed('jkiss', env), false)
  assert.equal(syncProductAllowed('claimguard', env), false)
  assert.equal(syncProductAllowed('anything', {}), true)
})

test('Release Center current-state control reconciles only Supercharged and refreshes the business projection', () => {
  const page = fs.readFileSync(path.join(ROOT, 'app/admin/operations/release/page.tsx'), 'utf8')
  assert.match(page, /Check Supercharged/)
  assert.match(page, /fetch\('\/api\/admin\/platform\/sync\/products\/supercharged\/reconcile'/)
  assert.doesNotMatch(page, /action: 'reconcile-all'/)
  assert.match(page, /setRefreshNonce\(n => n \+ 1\)/)
  assert.match(page, /<Businesses refreshNonce=\{refreshNonce\}/)
})
