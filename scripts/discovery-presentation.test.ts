// ── What an owner is TOLD about a discovered update (D2, D3, D4) ────────────
//
// Discovery files a record for every merge to main, so the words on the page are
// not cosmetic: they are the only thing standing between "detected automatically,
// nobody has looked at it" and an owner reading the ledger as a queue of things
// already on their way out.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  updateBucket, groupUpdates, statusLabel, STATUS_LABEL,
  matchesStatusFilter, statusFilterLabel, STATUS_FILTERS, BUCKET_ORDER, BUCKET_BLURB,
} from '../app/lib/platform/updates/business-view'
import { touchesStoredData, touchesSecretSurface, discoveredUpdateFromGitHub } from '../app/lib/platform/updates/discovery'
import type { PlatformUpdate } from '../app/lib/platform/updates/types'

// ── D2: what counts as touching stored data ────────────────────────────────
//
// The shipped regex required a path SEPARATOR around the keyword, so every
// hyphenated name — the repo's actual convention — was invisible to it. These are
// asserted as a matrix rather than a sample, because the failure mode is silent:
// a missed file does not error, it just means the record says no migration is
// involved and that rollback is safe.

const MIGRATION_POSITIVE = [
  'migrations/001_add_column.sql',
  'db/migrations/2026-add-index.ts',
  'scripts/migrate-bookings.ts',
  'scripts/booking-migration.ts',
  'scripts/booking_migration.ts',
  'app/lib/tenant-migration.ts',
  'app/lib/tenant_migration.ts',
  'scripts/pay-backfill.ts',
  'scripts/pay_backfill.ts',
  'scripts/backfill-capabilities.mjs',
  'prisma/schema.prisma',
  'app/lib/db/schema.ts',
  'schema/booking.ts',
  'app/lib/migrate.ts',
]

const MIGRATION_NEGATIVE = [
  'app/lib/ai/analysis-schema.ts',        // an AI response shape, not stored data
  'app/lib/ai/analysis-schema-v2.ts',
  'app/lib/confirmation-schema.ts',
  'docs/operations/07-migration-safety-checklist.md',  // documentation ABOUT migrations
  'docs/backfill.md',
  'app/components/Migrating.tsx',         // substring only
  'app/lib/immigration-notes.ts',         // substring only — must not match
  'app/lib/schematic.ts',
  'app/lib/booking.ts',
  'app/api/book/route.ts',
  'README.md',
]

test('D2: every migration-shaped path is classified as touching stored data', () => {
  for (const path of MIGRATION_POSITIVE) {
    assert.equal(touchesStoredData(path), true, `MISSED: ${path} would be filed as needing no migration`)
  }
})

test('D2: ordinary code and docs are NOT classified as touching stored data', () => {
  for (const path of MIGRATION_NEGATIVE) {
    assert.equal(touchesStoredData(path), false, `FALSE POSITIVE: ${path}`)
  }
})

test('D2: secret-surface classification is conservative, and documented as advisory', () => {
  for (const path of ['app/lib/secrets.ts', 'app/lib/provider-config.ts', 'config/credentials.ts', 'app/lib/env-config.ts', 'app/lib/secret_store.ts']) {
    assert.equal(touchesSecretSurface(path), true, `MISSED: ${path}`)
  }
  for (const path of ['docs/secrets.md', 'app/lib/secretary.ts', 'app/lib/booking.ts']) {
    assert.equal(touchesSecretSurface(path), false, `FALSE POSITIVE: ${path}`)
  }
})

const payload = (files: string[], truncated = false) => ({
  deliveryId: 'd1', repository: 'ratchetnu/jkissllc', ref: 'refs/heads/main',
  before: 'b'.repeat(40), after: 'a'.repeat(40), title: 'feat: x', commitMessage: 'feat: x',
  changedFiles: files, changedFileCount: files.length, filesTruncated: truncated,
  workflowRunId: '1',
})
const build = (files: string[], truncated = false) =>
  discoveredUpdateFromGitHub(payload(files, truncated), { key: 'UPD-TEST', sourceBusinessId: 'jkiss', sourceBranch: 'main', now: 1 })

test('D2: a migration in the changeset sets migrationRequired and withdraws the rollback claim', () => {
  const u = build(['scripts/booking-migration.ts', 'app/lib/x.ts'])
  assert.equal(u.migrationRequired, true)
  assert.equal(u.rollbackSupported, false, 'a data migration means rolling back code does not undo it')
  assert.match(u.ownerNotes ?? '', /migration/i, 'and the owner is told why')
})

test('D2: a plain code change claims neither', () => {
  const u = build(['app/lib/booking.ts', 'app/components/Card.tsx'])
  assert.equal(u.migrationRequired, false)
  assert.equal(u.secretRequired, false)
  assert.equal(u.rollbackSupported, true)
})

test('D2: a TRUNCATED file list is treated as unknown scope, not as a clean changeset', () => {
  // The dangerous case: GitHub caps the file list, the visible files look harmless,
  // and the record would otherwise assert "no migration, rollback is safe" about a
  // changeset it never saw.
  const u = build(['app/lib/booking.ts'], true)
  assert.equal(u.migrationRequired, true)
  assert.equal(u.secretRequired, true)
  assert.equal(u.rollbackSupported, false)
  assert.match(u.ownerNotes ?? '', /truncat|not fully|unknown/i)
})

test('D2: a discovered record never claims to be reviewed, whatever it touches', () => {
  for (const files of [['app/lib/x.ts'], ['migrations/1.sql'], ['app/lib/secrets.ts']]) {
    const u = build(files)
    assert.equal(u.status, 'discovered')
    for (const [field, v] of Object.entries(u.validation)) assert.equal(v, 'unknown', field)
  }
})

// ── D3: the discovered state has words of its own ──────────────────────────

test('D3: `discovered` gets its own bucket, listed first', () => {
  assert.equal(updateBucket('discovered'), 'Found automatically')
  assert.equal(BUCKET_ORDER[0], 'Found automatically')
})

test('D3: the bucket blurb says detected, unreviewed, and going nowhere', () => {
  const blurb = BUCKET_BLURB['Found automatically'].toLowerCase()
  assert.match(blurb, /detect/, 'says it was found automatically')
  assert.match(blurb, /review|look/, 'says nobody has reviewed it')
  assert.match(blurb, /waiting|nobody has (reviewed|approved)/, 'says nobody approved or sent it')
  // The regression this exists to prevent: `discovered` fell into "Queued", which
  // tells an owner it is on its way out.
  assert.ok(!/queue|sending|on its way|deploying/.test(blurb), `implies deployment: ${blurb}`)
  assert.notEqual(updateBucket('discovered'), 'Queued')
})

test('D3: the status label is human and does not imply progress', () => {
  assert.equal(statusLabel('discovered'), 'Needs review')
  assert.ok(!/queue|deploy|sent|approv/i.test(STATUS_LABEL.discovered))
  // Raw fallback for any status not in the table — never a crash, never a raw slug
  // with underscores on screen.
  assert.equal(statusLabel('some_new_status'), 'some new status')
})

test('D3: grouping puts a discovered update in its own section, alone', () => {
  const upd = (key: string, status: string) => ({ key, status, title: key } as unknown as PlatformUpdate)
  const groups = groupUpdates([upd('UPD-1', 'discovered'), upd('UPD-2', 'approved'), upd('UPD-3', 'fully_deployed')])
  assert.deepEqual(groups['Found automatically'].map(u => u.key), ['UPD-1'])
  assert.ok(!groups.Queued.some(u => u.key === 'UPD-1'))
})

// ── D4: the filter can select it ───────────────────────────────────────────

test('D4: `discovered` is an offered filter option with an accessible label', () => {
  assert.ok(STATUS_FILTERS.includes('discovered'))
  assert.equal(statusFilterLabel('discovered'), 'Needs review')
  assert.equal(statusFilterLabel('all'), 'All')
  assert.equal(statusFilterLabel('pending'), 'Anything open')
})

test('D4: selecting it returns exactly the discovered rows', () => {
  const rows = [
    { status: 'discovered' }, { status: 'discovered' }, { status: 'approved' },
    { status: 'fully_deployed' }, { status: 'archived' }, { status: 'cancelled' }, { status: 'blocked' },
  ]
  const count = (f: string) => rows.filter(r => matchesStatusFilter(r.status, f)).length
  assert.equal(count('discovered'), 2)
  assert.equal(count('all'), 7)
  assert.equal(count('pending'), 4, 'open = discovered ×2 + approved + blocked')
})

test('D4: discovered rows remain visible under `pending` and `all`', () => {
  assert.equal(matchesStatusFilter('discovered', 'pending'), true, 'adding the filter must not hide it from the default view')
  assert.equal(matchesStatusFilter('discovered', 'all'), true)
})

test('D4: no existing filter changed meaning', () => {
  // Pinned so a later edit to the filter list cannot quietly redefine one of the
  // options an owner already relies on.
  const expected: Record<string, string[]> = {
    approved: ['approved'], blocked: ['blocked'], failed: ['failed'],
    partially_deployed: ['partially_deployed'], fully_deployed: ['fully_deployed'], archived: ['archived'],
  }
  const universe = ['discovered', 'approved', 'blocked', 'failed', 'partially_deployed', 'fully_deployed', 'archived', 'cancelled', 'queued']
  for (const [filter, want] of Object.entries(expected)) {
    assert.deepEqual(universe.filter(s => matchesStatusFilter(s, filter)), want, filter)
  }
  assert.deepEqual(
    universe.filter(s => matchesStatusFilter(s, 'pending')),
    ['discovered', 'approved', 'blocked', 'failed', 'partially_deployed', 'queued'],
  )
})

test('D4: the page renders the shared filter list and labels the control', () => {
  // The list and the predicate live in business-view so they are testable; this
  // asserts the page actually uses them rather than re-deriving its own.
  const src = readFileSync(new URL('../app/admin/operations/platform/page.tsx', import.meta.url), 'utf8')
  assert.match(src, /STATUS_FILTERS\.map/, 'the option list comes from the shared constant')
  assert.match(src, /matchesStatusFilter\(u\.status, filter\)/, 'the rows use the shared predicate')
  assert.match(src, /htmlFor="update-status-filter"/, 'the label is associated with the control')
  assert.match(src, /id="update-status-filter"/)
  assert.match(src, /aria-label="Filter updates by status"/, 'and it has an accessible name of its own')
  assert.ok(!/nice\(u\.status\)/.test(src), 'no raw status slug is rendered any more')
})

test('D4: the mobile audit actually visits the platform page', () => {
  const src = readFileSync(new URL('./mobile-overflow-audit.mjs', import.meta.url), 'utf8')
  assert.match(src, /'\/admin\/operations\/platform'/, 'the route is in the audit list')
  // Without an `owner` row in the role matrix, `auth: 'owner'` can be satisfied by
  // nobody, so the route would report BLOCKED_AUTH for every viewport and still
  // look like it was covered.
  const classify = readFileSync(new URL('./mobile-audit-classify.mjs', import.meta.url), 'utf8')
  assert.match(classify, /owner:\s*\['owner'\]/, 'and an owner route can actually be measured')
})
