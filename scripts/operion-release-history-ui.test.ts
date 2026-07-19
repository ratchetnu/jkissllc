// Increment 3B.6 — Release History UI tests: pure view helpers + SSR render of the details
// content (react-dom/server, no jsdom) + a static read-only/execution guard. No network, no writes.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  releaseStatusTone, releaseStatusLabel, releaseKindLabel, historyTimeAgo, RELEASE_STATUS_FILTER_OPTIONS,
} from '../app/admin/operations/release/release-history-view'
import { ReleaseDetailsContent } from '../app/admin/operations/release/ReleaseDetailsDrawer'
import type { ReleaseHistoryEntry } from '../app/lib/platform/release/release-history'

// ── View helpers ──────────────────────────────────────────────────────────────
test('releaseStatusTone/Label map every status', () => {
  assert.equal(releaseStatusTone('published'), 'good')
  assert.equal(releaseStatusTone('rolled_back'), 'warn')
  assert.equal(releaseStatusTone('publish_failed'), 'bad')
  assert.equal(releaseStatusTone('rollback_failed'), 'bad')
  assert.equal(releaseStatusTone('publishing'), 'info')
  assert.equal(releaseStatusLabel('publish_failed'), 'Publish failed')
  assert.equal(releaseStatusLabel('rolled_back'), 'Rolled back')
  assert.equal(releaseKindLabel('rollback'), 'Rollback')
  assert.equal(releaseKindLabel('publish'), 'Publish')
})
test('historyTimeAgo is deterministic on now', () => {
  const now = 10_000_000
  assert.equal(historyTimeAgo(undefined, now), 'Unavailable')
  assert.equal(historyTimeAgo(now - 30_000, now), 'just now')
  assert.equal(historyTimeAgo(now - 5 * 60_000, now), '5m ago')
  assert.equal(historyTimeAgo(now - 3 * 3600_000, now), '3h ago')
})
test('status filter options cover the terminal statuses', () => {
  assert.deepEqual(RELEASE_STATUS_FILTER_OPTIONS.map((o) => o.value), ['published', 'publish_failed', 'rolled_back', 'rollback_failed'])
})

// ── SSR render of the details content ────────────────────────────────────────
const entry: ReleaseHistoryEntry = {
  id: 'PUB-1001', kind: 'publish', at: 2_000_000, businessId: 'supercharged', businessSlug: 'supercharged',
  commit: 'abc1234', environment: 'production', deploymentId: 'dpl_x', sourceDeploymentId: 'dpl_prev',
  status: 'published', mode: 'simulated', approvalId: 'APRV-1', approvingOwner: 'owner', approvalAt: 1_900_000,
  publishAt: 2_000_500, startedBy: 'owner', rolledBackByRollbackId: 'RBK-1',
}

test('ReleaseDetailsContent renders all sections + audit timeline', () => {
  const details = {
    release: entry,
    auditTrail: [
      { id: 'PAUD-1', at: 1_900_000, action: 'approval.created', summary: 'approved', actor: 'owner' },
      { id: 'PAUD-2', at: 2_000_500, action: 'publish.completed', summary: 'done', actor: 'owner' },
    ],
  }
  const html = renderToStaticMarkup(h(ReleaseDetailsContent, { details }))
  for (const s of ['Deployment', 'Approval', 'Publish metadata', 'Audit trail']) assert.ok(html.includes(s), `missing section ${s}`)
  assert.match(html, /approval\.created/)
  assert.match(html, /publish\.completed/)
  assert.match(html, /Published/)              // status badge label
  assert.match(html, /Simulated/)              // mode badge
  assert.match(html, /RBK-1/)                   // rollback relationship shown
})

test('ReleaseDetailsContent degrades gracefully with an empty audit trail', () => {
  const html = renderToStaticMarkup(h(ReleaseDetailsContent, { details: { release: { ...entry, kind: 'rollback', status: 'rolled_back' }, auditTrail: [] } }))
  assert.match(html, /No audit events recorded/)
  assert.match(html, /Rollback/)
})

// ── Static guard: history/details are read-only; rollback is the only execution ─
function src(rel: string) { return readFileSync(new URL(rel, import.meta.url), 'utf8') }
test('history + details are read-only (single GET; no mutating fetch)', () => {
  for (const f of ['../app/admin/operations/release/ReleaseHistoryPanel.tsx', '../app/admin/operations/release/ReleaseDetailsDrawer.tsx']) {
    const s = src(f)
    assert.match(s, /cache: 'no-store'/)
    assert.equal(/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(s), false, `${f} must not issue a mutating fetch`)
  }
})
test('rollback is the only execution control, owner+typed-confirm gated', () => {
  const s = src('../app/admin/operations/release/RollbackPanel.tsx')
  assert.match(s, /method: 'POST'/)                 // the one execution call
  assert.match(s, /TypedConfirm/)                   // typed confirmation required
  assert.match(s, /requiredPhrase/)
  assert.equal(s.includes('promoteProduction') || s.includes('dispatchWorkflow'), false)  // no direct provider write in the client
})
