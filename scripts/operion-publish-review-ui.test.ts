// Increment 3B.2C — read-only Publish Review UI tests. Pure view helpers +
// server-rendered content assertions (react-dom/server, no jsdom) + a static
// read-only guarantee for the drawer. No network, no writes.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  showReviewRelease, orUnavailable, verificationAgeLabel, overallReviewBanner,
  summaryMetrics, groupedWarnings, eligibilityPill, previewPill, rollbackPill, riskToTone, highRiskCount, splitFileList,
} from '../app/admin/operations/release/publish-review-view'
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

// ── Render: PublishReviewContent (compact dashboard) ─────────────────────────
test('content renders all sections + Unavailable + audit label; no write controls', () => {
  const html = renderToStaticMarkup(h(PublishReviewContent, { review: mockReview(), warnings: ['candidate commit unavailable'] }))
  // IA: dashboard groups content into these titled sections (Deployment holds the preview).
  for (const s of ['Business', 'Version comparison', 'Deployment', 'Eligibility', 'Change summary', 'Rollback readiness', 'Audit preview', 'Provider warnings']) {
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
  // The ONLY buttons in the content are disclosure toggles + tabs — never action buttons.
  const buttons = html.match(/<button[^>]*>/g) ?? []
  assert.ok(buttons.length > 0, 'dashboard uses disclosure/tab buttons')
  for (const b of buttons) {
    assert.ok(/aria-expanded=|role="tab"/.test(b), `every content button must be a disclosure or tab: ${b}`)
  }
})

test('dashboard: summary metrics + sticky top bar render; expand/collapse defaults are correct', () => {
  const html = renderToStaticMarkup(h(PublishReviewContent, { review: mockReview(), warnings: [] }))
  for (const label of ['Files changed', 'High-risk files', 'Warnings', 'Blocking issues', 'Preview', 'Rollback']) {
    assert.ok(html.includes(label), `missing summary metric: ${label}`)
  }
  assert.ok(html.includes('Production'), 'environment shown in the top bar')
  // Eligibility + Risk expanded by default; detail sections collapsed by default.
  assert.match(html, /aria-expanded="true"/)
  assert.match(html, /aria-expanded="false"/)
  // Change summary exposes tabs (roving) to cut clutter.
  assert.match(html, /role="tablist"/)
  assert.match(html, /role="tab"/)
  // Collapsible panels expose a labelled region for AT.
  assert.match(html, /role="region"/)
  // Heading hierarchy: business name h2, section disclosures wrapped in h3.
  assert.match(html, /<h2[^>]*>Supercharged Enterprises<\/h2>/)
  assert.match(html, /<h3[^>]*><button/)
})

test('dashboard: file list is capped (never a giant list) — first few shown + remainder counted', () => {
  // The Files tab renders lazily (only when selected), and even then caps the visible head
  // at FILE_PREVIEW_LIMIT with an accessible "+N more" disclosure for the rest.
  const many = Array.from({ length: 20 }, (_, i) => `app/file-${i}.ts`)
  const s = splitFileList(many)
  assert.equal(s.shown.length, 8)                     // FILE_PREVIEW_LIMIT
  assert.equal(s.shown[0], 'app/file-0.ts')
  assert.equal(s.remaining, 12)                       // 20 − 8
  // Inactive/collapsed detail lists are NOT rendered by default (perf): the Statistics tab
  // is active, so the 20-path list is absent from the initial markup.
  const review = mockReview({ filesChanged: { fileCount: 20, additions: 20, deletions: 5, migrations: false, envChanges: false, rollbackSupported: true, available: true, changedFilePaths: many, summary: '20 files' } })
  const html = renderToStaticMarkup(h(PublishReviewContent, { review, warnings: [] }))
  assert.equal(html.includes('app/file-19.ts'), false, 'giant list not rendered while its tab is inactive')
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

test('theme: drawer uses only dark app tokens — no light --surface / #fff / white / Canvas', () => {
  const src = readFileSync(new URL('../app/admin/operations/release/PublishReviewDrawer.tsx', import.meta.url), 'utf8')
  // --surface / --surface-2/3 are the LIGHT content tokens (white); the app is dark and uses
  // --card / --bg. This bar previously used --surface and rendered white in the dark drawer.
  assert.equal(/var\(--surface(-\d)?\b/.test(src), false, 'must not use the light --surface token')
  assert.equal(/#fff\b|#ffffff\b|Canvas\b/i.test(src), false, 'no hard-coded light fallback colors')
  assert.equal(/background:\s*['"]white['"]/i.test(src), false, 'no literal white background')
  // The sticky summary is an opaque card surface (matches sibling cards, covers scroll).
  assert.match(src, /background: 'var\(--card\)'/)
})

test('theme: summary card renders on the dark card token, not the light surface token', () => {
  const html = renderToStaticMarkup(h(PublishReviewContent, { review: mockReview(), warnings: [] }))
  assert.match(html, /background:var\(--card\)/)      // opaque dark card surface present
  assert.equal(/var\(--surface(-\d)?\)/.test(html), false, 'light surface token never reaches the DOM')
})

// ── Dashboard derivation helpers (pure) ──────────────────────────────────────
test('summaryMetrics: six cards, values degrade to Unavailable, tones reflect state', () => {
  const m = summaryMetrics(mockReview(), ['w1'])
  assert.deepEqual(m.map((x) => x.key), ['files', 'highRisk', 'warnings', 'blocking', 'preview', 'rollback'])
  assert.equal(m.find((x) => x.key === 'files')!.value, 'Unavailable')      // filesChanged.available === false
  assert.equal(m.find((x) => x.key === 'blocking')!.value, '1')             // eligibility.failed === 1
  assert.equal(m.find((x) => x.key === 'blocking')!.tone, 'bad')
  assert.equal(m.find((x) => x.key === 'warnings')!.value, '1')             // one informational warning
  assert.equal(m.find((x) => x.key === 'rollback')!.value, 'Not ready')
})

test('summaryMetrics: enriched review shows real counts', () => {
  const review = mockReview({
    filesChanged: { fileCount: 3, additions: 12, deletions: 4, migrations: true, envChanges: false, rollbackSupported: true, available: true, summary: '3 files', highRiskDetails: [{ category: 'migration', file: 'db/x.sql' }] },
    eligibility: { eligible: true, passed: 3, warnings: 0, failed: 0, items: [] },
    rollback: { targetVersion: '1.0.0', targetDeploymentId: 'dpl_x', targetCommit: 'abc', targetDeployedAt: 1000, strategy: 'instant_promote', ready: true, metadataComplete: true },
  })
  const m = summaryMetrics(review, [])
  assert.equal(m.find((x) => x.key === 'files')!.value, '3')
  assert.equal(m.find((x) => x.key === 'highRisk')!.value, '1')
  assert.equal(m.find((x) => x.key === 'highRisk')!.tone, 'bad')
  assert.equal(m.find((x) => x.key === 'blocking')!.value, '0')
  assert.equal(m.find((x) => x.key === 'rollback')!.value, 'Ready')
})

test('groupedWarnings: separates blockers from informational + de-dupes', () => {
  const g = groupedWarnings(mockReview(), ['a', 'a', 'b'])
  assert.equal(g.blocking.length, 1)                       // PROMOTION_DISABLED
  assert.deepEqual(g.informational, ['a', 'b'])            // deduped
})

test('pills + riskToTone + highRiskCount + splitFileList', () => {
  assert.equal(riskToTone('destructive'), 'bad')
  assert.equal(riskToTone('success'), 'good')
  assert.equal(riskToTone('warning'), 'warn')
  assert.equal(riskToTone('info'), 'info')
  assert.equal(eligibilityPill(mockReview()).tone, 'bad')  // 1 failed
  assert.equal(previewPill(mockReview()).label, 'Verified')
  assert.equal(rollbackPill(mockReview()).label, 'Not ready')
  assert.equal(highRiskCount(mockReview()), null)          // filesChanged has no highRisk info
  const s = splitFileList(['a', 'b', 'c'], 2)
  assert.deepEqual(s.shown, ['a', 'b'])
  assert.equal(s.remaining, 1)
})

// ── Static read-only guarantee for the drawer ───────────────────────────────
test('drawer is read-only: only a no-store GET, no writes/execution/secrets', () => {
  const src = readFileSync(new URL('../app/admin/operations/release/PublishReviewDrawer.tsx', import.meta.url), 'utf8')
  assert.match(src, /publish-review/)                 // hits the read endpoint
  assert.match(src, /cache: 'no-store'/)              // respects no-store
  assert.match(src, /AbortController/)                // aborts stale requests
  assert.equal(/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(src), false, 'no mutating fetch')
  // No inline execution in the drawer itself. `onPublish=` (handler prop) — not the composed
  // <ProductionPublishPanel/> component name — is what would signal an inline write control.
  for (const forbidden of ['/approve', '/update', 'preparePreview', 'approveProduction', 'dispatchWorkflow', 'onPublish=', 'onApprove=']) {
    assert.equal(src.includes(forbidden), false, `drawer must not reference ${forbidden}`)
  }
})
