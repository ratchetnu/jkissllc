// Increment 3B.2C — read-only Publish Review UI tests. Pure view helpers +
// server-rendered content assertions (react-dom/server, no jsdom) + a static
// read-only guarantee for the drawer. No network, no writes.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { showReviewRelease, orUnavailable, verificationAgeLabel, overallReviewBanner } from '../app/admin/operations/release/publish-review-view'
import { PublishReviewContent } from '../app/admin/operations/release/PublishReviewDrawer'
import type { PublishReview } from '../app/lib/platform/release/publish-review'

// ── Pure helpers ─────────────────────────────────────────────────────────────
test('entry: Review release shows only for the publish (ready_to_publish) action', () => {
  assert.equal(showReviewRelease('publish'), true)
  assert.equal(showReviewRelease('update'), false)
  assert.equal(showReviewRelease('check'), false)
  assert.equal(showReviewRelease('set_up'), false)
})

test('orUnavailable / verificationAgeLabel never invent values', () => {
  assert.equal(orUnavailable(undefined), 'Unavailable')
  assert.equal(orUnavailable(''), 'Unavailable')
  assert.equal(orUnavailable('1.1.0'), '1.1.0')
  assert.equal(orUnavailable(0), '0')
  assert.equal(verificationAgeLabel(undefined), 'Unavailable')
  assert.equal(verificationAgeLabel(30_000), 'just now')
  assert.equal(verificationAgeLabel(5 * 60_000), '5m ago')
  assert.equal(verificationAgeLabel(3 * 3600_000), '3h ago')
})

const mockReview = (over: Partial<PublishReview> = {}): PublishReview => ({
  business: { id: 'supercharged', name: 'Supercharged Enterprises', edition: 'branded_clone', releaseStatus: 'Ready to publish', testOnly: false },
  version: { current: '1.0.0', candidate: '1.1.0', releaseType: 'minor', candidateCommit: 'newsha7', sourceBranch: 'operion/upd-9' },
  preview: { deploymentId: 'dpl_prev', url: 'https://preview.example', verified: true, readyState: 'READY' },
  verification: { checks: [{ name: 'typecheck', state: 'pass' }, { name: 'e2e', state: 'skip' }], verifiedAt: 1000, verificationAgeMs: 60_000, fresh: true },
  filesChanged: { fileCount: 0, summary: 'diff read at execution time', migrations: false, envChanges: false, rollbackSupported: true, available: false },
  rollback: { targetDeploymentId: undefined, targetVersion: '1.0.0', strategy: 'instant_promote', ready: false, warning: 'No captured production deployment yet.' },
  eligibility: { eligible: false, passed: 2, warnings: 1, failed: 1, items: [{ label: 'Owner permission', state: 'pass' }, { label: 'Promotion flag enabled', state: 'fail' }, { label: 'Preview note', state: 'warn' }], blockingReasons: [{ code: 'PROMOTION_DISABLED', message: 'OPERION_PRODUCTION_PROMOTION_ENABLED is off' }] },
  risk: { level: 'info', title: 'Low risk', detail: 'Reversible; no migration.' },
  audit: { willRecord: ['Owner: owner', 'Business: Supercharged Enterprises (supercharged)', 'Version: 1.0.0 → 1.1.0'], correlationId: 'rel-supercharged-newsha7' },
  evaluatedAt: 2000,
  ...over,
})

test('banner: eligible / warnings / ineligible / test-only, no "approved"/"published" language', () => {
  assert.equal(overallReviewBanner(mockReview({ business: { id: 'x', name: 'X', testOnly: true } }), []).title, 'Test-only business')
  assert.equal(overallReviewBanner(mockReview(), []).title, 'Not eligible to publish')          // flag off
  const eligibleClean = mockReview({ eligibility: { eligible: true, passed: 3, warnings: 0, failed: 0, items: [] }, rollback: { targetVersion: '1.0.0', strategy: 'instant_promote', ready: true } })
  const b = overallReviewBanner(eligibleClean, [])
  assert.equal(b.title, 'Eligible for review')
  assert.equal(b.level, 'success')
  for (const banner of [overallReviewBanner(mockReview(), []), b]) {
    assert.equal(/approved|published/i.test(banner.title + (banner.detail ?? '')), false)
  }
})

// ── Render: PublishReviewContent ─────────────────────────────────────────────
test('content renders all sections + Unavailable + audit label; no write controls', () => {
  const html = renderToStaticMarkup(h(PublishReviewContent, { review: mockReview(), warnings: ['candidate commit unavailable'] }))
  for (const s of ['Business', 'Version comparison', 'Preview verification', 'Eligibility', 'Change summary', 'Rollback readiness', 'Audit preview']) {
    assert.ok(html.includes(s), `missing section: ${s}`)
  }
  assert.match(html, /no audit record has been created/)
  assert.match(html, /Unavailable/)                 // missing prod deployment / diff render Unavailable
  assert.match(html, /PROMOTION_DISABLED/)           // blocking reason code shown
  assert.match(html, /Passed:/)                      // eligibility checklist semantics (word, not color)
  assert.match(html, /Failed:/)
  // READ-ONLY: no action/execution controls anywhere in the content
  for (const forbidden of ['Publish to Production', 'Approve', 'Confirm', 'Roll Back', 'Rollback now', 'Retry']) {
    assert.equal(html.includes(forbidden), false, `content must not contain "${forbidden}"`)
  }
  assert.equal(/<button/i.test(html), false)          // the content itself has NO buttons at all
})

test('content: fully-unavailable payload degrades gracefully (no throw, shows Unavailable)', () => {
  const bare = mockReview({
    version: { current: undefined, candidate: undefined, candidateCommit: undefined, sourceBranch: undefined },
    preview: { verified: false }, verification: { checks: [], fresh: false },
    rollback: { strategy: 'none', ready: false }, audit: { willRecord: [] },
  })
  const html = renderToStaticMarkup(h(PublishReviewContent, { review: bare, warnings: [] }))
  assert.match(html, /Unavailable/)
  assert.ok(html.includes('Audit preview'))
})

// ── Static read-only guarantee for the drawer ───────────────────────────────
test('drawer is read-only: only a no-store GET, no writes/execution/secrets', () => {
  const src = readFileSync(new URL('../app/admin/operations/release/PublishReviewDrawer.tsx', import.meta.url), 'utf8')
  assert.match(src, /publish-review/)                 // hits the read endpoint
  assert.match(src, /cache: 'no-store'/)              // respects no-store
  assert.match(src, /AbortController/)                // aborts stale requests
  assert.equal(/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(src), false, 'no mutating fetch')
  for (const forbidden of ['/approve', '/update', 'preparePreview', 'approveProduction', 'dispatchWorkflow', 'onPublish']) {
    assert.equal(src.includes(forbidden), false, `drawer must not reference ${forbidden}`)
  }
})
