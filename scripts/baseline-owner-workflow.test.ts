// ── The owner-facing baseline workflow ──────────────────────────────────────
//
// What an owner is asked for, what Operion reads itself, and what may be written.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolveStartingVersion, STARTING_VERSION_CHOICES, prereleaseAllowedForChannel } from '../app/lib/platform/release/starting-version'
import { mapJobToProgress } from '../app/lib/platform/release/progress'

const ROUTE = 'app/api/admin/release/businesses/[id]/baseline-adoption/route.ts'
const PANEL = 'app/admin/operations/release/BaselineAdoptionPanel.tsx'
const route = () => readFileSync(ROUTE, 'utf8')
const panel = () => readFileSync(PANEL, 'utf8')

// ── The owner supplies a version and nothing else ──────────────────────────

test('the owner is asked for a version and a confirmation — no technical fields remain', () => {
  const src = panel()
  for (const gone of ['manifestHash', 'schemaEvidence', 'setFlags', 'deploymentReference', 'healthReference', 'parseFlags']) {
    assert.ok(!src.includes(gone), `the form still asks the owner for ${gone}`)
  }
  // A commit field is the specific thing that produced the observed defect.
  assert.ok(!/setCommit|value=\{commit\}/.test(src), 'the owner can still type a commit')
})

test('the stale stored commit is never offered to the browser as an editable starting point', () => {
  const src = route()
  assert.ok(!/deployedCommit: business\.currentCommit/.test(src),
    'the GET still pre-fills the stored commit, which is stale for anything deployed outside the pipeline')
  assert.match(src, /recordedCommit: business\.currentCommit/, 'it is exposed as a read-only record instead')
})

test('check_evidence builds the evidence server-side; nothing but the version comes from the client', () => {
  const src = route()
  const block = src.slice(src.indexOf("if (action === 'check_evidence')"), src.indexOf("if (action === 'dry_run')"))
  assert.match(block, /collectBaselineEvidence\(/)
  assert.match(block, /deployedCommit: report\.live\?\.fullCommit/, 'the commit comes from the live reading')
  assert.match(block, /capabilityManifestHash: report\.capabilityManifestHash/)
  assert.match(block, /schemaMigrationState: report\.schemaMigrationState/)
  // The only client-derived inputs permitted anywhere in that block.
  const clientReads = [...block.matchAll(/body\?\.(\w+)/g)].map((m) => m[1]).sort()
  assert.deepEqual([...new Set(clientReads)], ['customVersion', 'startingVersionChoice'])
})

test('checking evidence performs no writes', () => {
  const src = route()
  const block = src.slice(src.indexOf("if (action === 'check_evidence')"), src.indexOf("if (action === 'dry_run')"))
  for (const writer of ['saveBusiness', 'adoptBaseline', 'saveBaselineAdoption', 'recordPlatformAudit', 'saveUpdate']) {
    assert.ok(!block.includes(writer), `check_evidence calls ${writer}`)
  }
})

test('adoption remains the sole write path, behind the signed receipt and typed phrase', () => {
  const src = route()
  assert.match(src, /if \(action !== 'adopt'\) return/)
  assert.match(src, /approvalToken/)
  assert.match(src, /confirmationPhrase/)
})

// ── Authorization and tenancy ──────────────────────────────────────────────

test('every method requires the platform owner, inside a tenant route', () => {
  const src = route()
  assert.equal((src.match(/requirePlatformOwner\(req\)/g) ?? []).length, 2, 'both GET and POST')
  assert.equal((src.match(/withTenantRoute\(/g) ?? []).length, 2)
  // The owner check must come before any business read.
  const post = src.slice(src.indexOf('export const POST'))
  assert.ok(post.indexOf('requirePlatformOwner') < post.indexOf('getBusiness'), 'business is read before authorization')
})

test('adoption records the acting owner and refuses without an identity', () => {
  const src = route()
  assert.match(src, /const actor = \(await getPrincipal\(req\)\)\?\.sub/)
  assert.match(src, /if \(!actor\) return NextResponse\.json\([^)]*401/)
})

// ── The deliberate version choice ──────────────────────────────────────────

test('no choice is made for the owner — there is no default', () => {
  const unmade = resolveStartingVersion({})
  assert.equal(unmade.ok, false)
  assert.equal((unmade as { reason: string }).reason, 'no_choice_made')
  assert.match((unmade as { detail: string }).detail, /will not choose for you/i)
  // And the panel starts with nothing selected.
  assert.match(panel(), /useState<string>\(''\)\s*\/\/ deliberately no default/)
})

test('0.1.0 and 1.0.0 are both offered, and each explains what it MEANS', () => {
  const ids = STARTING_VERSION_CHOICES.map((c) => c.id)
  assert.deepEqual(ids, ['zero_one', 'one_zero', 'custom'])
  const zero = STARTING_VERSION_CHOICES[0]
  const one = STARTING_VERSION_CHOICES[1]
  assert.equal(zero.version, '0.1.0')
  assert.equal(one.version, '1.0.0')
  for (const c of STARTING_VERSION_CHOICES) {
    assert.ok(c.meaning.length > 40, `${c.id} does not explain what it means`)
    assert.ok(c.pickWhen.length > 40, `${c.id} does not say when to pick it`)
    assert.ok(!/semver|major|minor|patch bump/i.test(c.pickWhen), `${c.id} explains in jargon`)
  }
  assert.match(one.meaning, /stable/i)
  assert.match(zero.meaning, /not yet promising|stable/i)
})

test('each offered choice resolves to its version', () => {
  assert.equal((resolveStartingVersion({ choice: 'zero_one' }) as { version: string }).version, '0.1.0')
  assert.equal((resolveStartingVersion({ choice: 'one_zero' }) as { version: string }).version, '1.0.0')
  assert.equal((resolveStartingVersion({ choice: 'custom', customVersion: ' 2.3.0 ' }) as { version: string }).version, '2.3.0')
})

test('a malformed custom version is refused in plain language', () => {
  for (const bad of ['1.4', 'latest', 'v1', '', 'one']) {
    const r = resolveStartingVersion({ choice: 'custom', customVersion: bad })
    assert.equal(r.ok, false, bad)
    assert.match((r as { detail: string }).detail, /three numbers separated by dots/i)
  }
})

test('a prerelease baseline is refused on channels that cannot carry one', () => {
  const r = resolveStartingVersion({ choice: 'custom', customVersion: '1.0.0-rc.1', allowPrerelease: false })
  assert.equal(r.ok, false)
  assert.equal((r as { reason: string }).reason, 'prerelease_not_allowed')
  assert.equal(resolveStartingVersion({ choice: 'custom', customVersion: '1.0.0-rc.1', allowPrerelease: true }).ok, true)
  // `custom` is not in the version policy's channel union and carries no guarantee.
  assert.equal(prereleaseAllowedForChannel('custom'), false)
  assert.equal(prereleaseAllowedForChannel('stable'), false)
  assert.equal(prereleaseAllowedForChannel('beta'), true)
})

// ── The confirmation screen ────────────────────────────────────────────────

test('the confirmation screen shows the six facts and says adopting changes nothing', () => {
  const src = panel()
  for (const row of ['Starting version', 'Live commit', 'Production deployment', 'Verified', 'Features detected', 'Data structure']) {
    assert.ok(src.includes(row), `the confirmation screen omits "${row}"`)
  }
  assert.match(src, /does not deploy anything and does not change the site/i)
  assert.match(src, /Type <span style=\{mono\}>\{state\?\.baseline\.confirmationPhrase\}/, 'an explicit typed confirmation is required')
})

test('changing the decision invalidates a completed check', () => {
  // Otherwise an owner could check evidence for 1.0.0, switch to 0.1.0, and confirm a
  // version that was never checked.
  const src = panel()
  assert.match(src, /const invalidate = useCallback\(\(\) => \{ setReport\(null\); setDryRun\(null\); setStage\('choose'\) \}/)
  // Both inputs the owner can touch — the choice itself and the custom number.
  assert.match(src, /onChange=\{\(\) => \{ setChoice\(c\.id\); invalidate\(\) \}\}/)
  assert.match(src, /onChange=\{\(e\) => \{ setCustomVersion\(e\.target\.value\); invalidate\(\) \}\}/)
  // And confirmation is reachable only through a check that set it.
  assert.match(src, /if \(result\.ok\) setStage\('confirm'\)/)
})

test('technical detail is disclosed, not displayed', () => {
  const src = panel()
  assert.match(src, /Technical details/)
  assert.match(src, /showTechnical/)
  const disclosure = src.slice(src.indexOf('showTechnical && ('))
  assert.match(disclosure.slice(0, 600), /i\.technical/, 'raw diagnostics live inside the disclosure')
})

// ── Archived updates are not active workflows ──────────────────────────────

test('an archived update mid-flight is terminal, not "Preparing test"', () => {
  for (const status of ['creating_branch', 'applying_update', 'testing', 'preview_deploying', 'queued']) {
    const p = mapJobToProgress(status, { hasJob: true, updateStatus: 'archived' })
    assert.equal(p.running, false, `${status} still animates`)
    assert.equal(p.archived, true, status)
    assert.equal(p.canRetry, false, status)
    assert.match(p.message, /archived/i, status)
    assert.ok(!/Preparing the update|Running checks|Deploying a preview/.test(p.message), `${status} still reads as an active step`)
  }
})

test('a cancelled update mid-flight is treated the same way', () => {
  const p = mapJobToProgress('applying_update', { hasJob: true, updateStatus: 'cancelled' })
  assert.equal(p.archived, true)
  assert.equal(p.running, false)
  assert.match(p.message, /cancelled/i)
})

test('a LIVE update is untouched by the archived branch', () => {
  const p = mapJobToProgress('applying_update', { hasJob: true, updateStatus: 'approved' })
  assert.equal(p.running, true)
  assert.equal(p.archived, undefined)
  assert.match(p.message, /Preparing the update/)
})

test('an archived update that FAILED keeps its existing blocked treatment', () => {
  // The defect was a workflow that looked alive, never the failure path — which
  // already reported correctly and must not regress.
  const p = mapJobToProgress('failed', { hasJob: true, updateStatus: 'archived', failureCategory: 'apply_failed', attemptCount: 4 })
  assert.equal(p.canRetry, false)
  assert.equal(p.blocked, true)
  assert.match(p.message, /archived/i)
})

test('the Release Center renders an archived summary instead of the live step rail', () => {
  const src = readFileSync('app/admin/operations/release/page.tsx', 'utf8')
  assert.match(src, /prog\?\.archived \? \(/, 'the archived branch is taken before the rail renders')
  assert.match(src, /Archived update/)
  assert.match(src, /Choose another update/, 'and offers the one action that helps')
  // The rail must be inside the else branch, not rendered alongside.
  const archivedAt = src.indexOf('prog?.archived ? (')
  const railAt = src.indexOf('LIVE_STEPS : STEPS).map')
  assert.ok(archivedAt > 0 && railAt > archivedAt, 'the rail should sit in the non-archived branch')
})
