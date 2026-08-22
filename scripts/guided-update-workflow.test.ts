// ── The guided Operion → target update workflow ─────────────────────────────
//
// Two halves:
//   1. deriveGuidedState — the pure narrative. One stage, one headline, ONE
//      action, derived entirely from server-held records so the flow survives a
//      refresh or a logout.
//   2. A source-level audit of the UI, in the style of wizard-a11y.test.ts: no
//      blocking window.confirm anywhere in this workflow, an accessible dialog,
//      and no double-submit path.
//
// The property that matters most, asserted repeatedly below: SIMPLIFYING THE
// NARRATION MUST NOT SIMPLIFY THE GATES. The guided module performs no writes and
// grants nothing — it names existing, separately-authorized endpoints.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  deriveGuidedState, typedConfirmationSatisfied, firstBlockingGate, GUIDED_TOTAL_STEPS,
  type GuidedInput,
} from '../app/lib/platform/automation/guided-flow'
import { classifyPreflight, type PreflightGate, type PreflightResult } from '../app/lib/platform/automation/preflight'

const here = dirname(fileURLToPath(import.meta.url))
const read = (...p: string[]) => readFileSync(join(here, '..', ...p), 'utf8')

// Fixtures go through the real classifier rather than hand-asserting a verdict, so a
// test can never describe a gate set the production code would read differently.
const preflight = (gates: PreflightGate[]): PreflightResult =>
  ({ ok: gates.every(g => g.ok || !g.blocking), gates, ...classifyPreflight(gates) })
const OK_PREFLIGHT: PreflightResult = preflight([{ id: 'automation_enabled', label: 'Automation enabled', ok: true, blocking: true, gateClass: 'platform' }])
const base = (over: Partial<GuidedInput> = {}): GuidedInput => ({
  update: { key: 'UPD-9001', title: 'Security fix' },
  business: { id: 'supercharged', name: 'Supercharged', slug: 'supercharged' },
  preflight: OK_PREFLIGHT,
  job: null,
  approval: { state: 'none' },
  publish: { state: 'idle', requiredPhrase: 'PUBLISH SUPERCHARGED TO PRODUCTION' },
  ...over,
})
const job = (status: string, over: Record<string, unknown> = {}) =>
  ({ id: 'AUTO-1', status, ...over }) as unknown as NonNullable<GuidedInput['job']>

// ── The happy path, one step at a time ───────────────────────────────────────

test('nothing selected → the first step asks for a choice, and offers no action', () => {
  const s = deriveGuidedState({ update: null, business: null, preflight: null, job: null, approval: null, publish: null })
  assert.equal(s.stage, 'choose')
  assert.equal(s.primary, null)
  assert.equal(s.totalSteps, GUIDED_TOTAL_STEPS)
})

test('ready → ONE primary action, and it is the send-to-Preview one', () => {
  const s = deriveGuidedState(base())
  assert.equal(s.stage, 'ready_to_send')
  assert.equal(s.primary?.id, 'send_preview')
  assert.match(s.primary!.label, /Supercharged Preview/)
  assert.equal(s.primary?.endpoint, '/api/admin/platform/automation')
  assert.match(s.detail, /Nothing goes live/)
})

test('in flight → NO action at all, so there is nothing to double-click', () => {
  for (const status of ['queued', 'creating_branch', 'applying_update', 'testing', 'preview_deploying']) {
    const s = deriveGuidedState(base({ job: job(status) }))
    assert.equal(s.primary, null, `${status} must offer no action`)
    assert.ok(['sending', 'previewing'].includes(s.stage), `${status} → ${s.stage}`)
  }
})

test('preview passed → "Review Preview", and NOT a publish button', () => {
  const s = deriveGuidedState(base({ job: job('awaiting_owner_review', { previewUrl: 'https://p.vercel.app' }) }))
  assert.equal(s.stage, 'review_preview')
  assert.equal(s.primary?.id, 'open_review')
  assert.notEqual(s.primary?.id, 'publish', 'publish must not be reachable before an approval exists')
})

test('only AFTER an approval exists does publish appear — and it demands a typed phrase', () => {
  const s = deriveGuidedState(base({
    job: job('awaiting_owner_review', { previewUrl: 'https://p.vercel.app' }),
    approval: { state: 'active' },
  }))
  assert.equal(s.stage, 'confirm_production')
  assert.equal(s.primary?.id, 'publish')
  assert.equal(s.primary?.requiresTypedConfirmation, true)
  assert.equal(s.primary?.phrase, 'PUBLISH SUPERCHARGED TO PRODUCTION')
  assert.equal(s.primary?.endpoint, '/api/admin/release/businesses/supercharged/publish')
})

test('publishing and verifying offer nothing; only a verified publish says "Live"', () => {
  assert.equal(deriveGuidedState(base({ publish: { state: 'publishing' } })).stage, 'publishing')
  assert.equal(deriveGuidedState(base({ publish: { state: 'verifying' } })).stage, 'verifying')
  const live = deriveGuidedState(base({ publish: { state: 'ready' } }))
  assert.equal(live.stage, 'live')
  assert.match(live.headline, /Live in Supercharged/)
  assert.equal(live.primary, null)
})

test('"Live" is never claimed from an unconfirmed promotion', () => {
  const unconfirmed = deriveGuidedState(base({ publish: { state: 'unconfirmed' } }))
  assert.equal(unconfirmed.stage, 'verifying')
  assert.notEqual(unconfirmed.stage, 'live')
})

// ── One blocker, one recovery ────────────────────────────────────────────────

test('a blocking gate becomes ONE plain sentence with no internal vocabulary', () => {
  const failing = preflight([
    { id: 'automation_enabled', label: 'Automation enabled', ok: true, blocking: true, gateClass: 'platform' },
    { id: 'target_configured', label: 'Target automation configured', ok: false, blocking: true, reason: 'target GitHub App install / repo / workflow not configured (status must be "ready")', gateClass: 'platform' },
    { id: 'preview_provider', label: 'Preview provider configured', ok: false, blocking: true, gateClass: 'platform' },
  ])
  const s = deriveGuidedState(base({ preflight: failing }))
  assert.equal(s.stage, 'blocked')
  assert.ok(s.blocker)
  // The plain text must not leak gate ids, env var names, or status enums.
  for (const jargon of ['configurationStatus', 'OPERION_', 'preflight', 'githubInstallationId', 'not_configured']) {
    assert.ok(!s.blocker!.plain.includes(jargon), `blocker text leaked "${jargon}"`)
  }
  assert.ok(s.blocker!.recovery, 'a blocker always names one thing to do')
  // The technical detail is still there — moved to Advanced, not deleted.
  assert.equal(s.advanced.failedGates.length, 2)
  assert.equal(s.advanced.failedGates[0].id, 'target_configured')
})

test('a failed preview says nothing was published, and offers exactly one retry', () => {
  const s = deriveGuidedState(base({ job: job('failed', { failureSummary: 'tests failed on the target' }) }))
  assert.equal(s.stage, 'failed')
  assert.match(s.blocker!.plain, /Nothing was published/)
  assert.equal(s.blocker!.recovery.id, 'retry_preview')
  assert.equal(s.primary, null, 'a failure offers recovery, not forward motion')
})

test('a failed PUBLISH offers rollback, and says the target is still on its old build', () => {
  const s = deriveGuidedState(base({ publish: { state: 'failed', failureReason: 'promotion rejected' } }))
  assert.equal(s.blocker!.recovery.id, 'rollback')
  assert.equal(s.blocker!.recovery.destructive, true)
  assert.match(s.blocker!.plain, /previous build|nothing was half-applied/i)
})

test('rollback outranks every forward stage — it can never be hidden behind progress', () => {
  const s = deriveGuidedState(base({
    job: job('rollback_required'),
    publish: { state: 'ready' },   // a stale "ready" must not win
    approval: { state: 'active' },
  }))
  assert.equal(s.stage, 'rollback_required')
})

// ── The gates are narrated, not weakened ─────────────────────────────────────

test('the guided module never names a mutating endpoint it invented', () => {
  const endpoints = new Set<string>()
  const collect = (i: GuidedInput) => {
    const s = deriveGuidedState(i)
    if (s.primary?.endpoint) endpoints.add(s.primary.endpoint)
    if (s.blocker?.recovery.endpoint) endpoints.add(s.blocker.recovery.endpoint)
  }
  collect(base())
  collect(base({ job: job('awaiting_owner_review'), approval: { state: 'active' } }))
  collect(base({ job: job('failed') }))
  collect(base({ publish: { state: 'failed' } }))
  // Every one of these already existed and enforces owner-only auth, eligibility and
  // the typed phrase server-side. None is new, and none belongs to this module.
  for (const e of endpoints) {
    assert.ok(
      e === '/api/admin/platform/automation' ||
      /^\/api\/admin\/platform\/automation\/[^/]+$/.test(e) ||
      /^\/api\/admin\/release\/businesses\/[^/]+\/(publish|rollback|approval)$/.test(e),
      `unexpected endpoint ${e}`,
    )
  }
})

test('the typed phrase is compared exactly — case and spacing forgiven, words are not', () => {
  const phrase = 'PUBLISH SUPERCHARGED TO PRODUCTION'
  assert.equal(typedConfirmationSatisfied('publish supercharged to production', phrase), true)
  assert.equal(typedConfirmationSatisfied('  PUBLISH   SUPERCHARGED TO PRODUCTION ', phrase), true)
  assert.equal(typedConfirmationSatisfied('PUBLISH TO PRODUCTION', phrase), false)
  assert.equal(typedConfirmationSatisfied('PUBLISH SUPERCHARGED', phrase), false)
  assert.equal(typedConfirmationSatisfied('yes', phrase), false)
  // No phrase = nothing satisfies it. Never fail open.
  assert.equal(typedConfirmationSatisfied('', undefined), false)
  assert.equal(typedConfirmationSatisfied('anything', undefined), false)
})

test('firstBlockingGate ignores advisory gates', () => {
  const advisoryOnly = preflight([
    { id: 'capability_activation', label: 'Optional features', ok: false, blocking: false, reason: 'dormant', gateClass: 'capability' },
    { id: 'rollback_documented', label: 'Rollback path documented', ok: false, blocking: false, gateClass: 'documentation' },
  ])
  assert.equal(firstBlockingGate(advisoryOnly), null)
  assert.equal(deriveGuidedState(base({ preflight: advisoryOnly })).stage, 'ready_to_send')
})

test('a dormant optional feature is SURFACED but never blocks the send', () => {
  const s = deriveGuidedState(base({
    capabilityImpact: {
      installs: true, dormant: true, affectedCapabilities: ['sms-delivery'],
      activationRequirements: [], missingCapabilityCode: [],
      rationale: 'Installs now and stays dormant: every optional feature it touches is switched off on this target.',
    },
  }))
  assert.equal(s.stage, 'ready_to_send')
  assert.equal(s.primary?.id, 'send_preview')
  assert.match(s.capabilityNote!, /dormant/)
})

// ── Source-level UI audit ────────────────────────────────────────────────────

const GUIDED = read('app', 'admin', 'operations', 'platform', 'GuidedDeploy.tsx')
const DIALOG = read('app', 'admin', 'operations', 'platform', 'ConfirmDialog.tsx')
const PLATFORM_PAGE = read('app', 'admin', 'operations', 'platform', 'page.tsx')

test('NO blocking window.confirm survives anywhere in this workflow', () => {
  for (const [name, src] of [['GuidedDeploy', GUIDED], ['ConfirmDialog', DIALOG], ['platform/page', PLATFORM_PAGE]] as const) {
    // Match a CALL, not the word: `confirm(` / `window.confirm(`. Comments in these
    // files legitimately discuss why window.confirm was removed.
    const withoutComments = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    assert.ok(!/(^|[^.\w])confirm\s*\(/.test(withoutComments), `${name} still calls confirm()`)
    assert.ok(!/window\.confirm/.test(withoutComments), `${name} still calls window.confirm`)
  }
})

test('the dialog is a real dialog: role, modality, labelling, and focus handling', () => {
  assert.match(DIALOG, /role="dialog"/)
  assert.match(DIALOG, /aria-modal="true"/)
  assert.match(DIALOG, /aria-labelledby=\{titleId\}/)
  assert.match(DIALOG, /aria-describedby=\{descId\}/)
  // Focus moves in on mount and back out on unmount.
  assert.match(DIALOG, /restoreTo\.current = document\.activeElement/)
  assert.match(DIALOG, /restoreTo\.current\?\.focus\?\.\(\)/)
  // Tab is trapped.
  assert.match(DIALOG, /e\.key !== 'Tab'/)
  assert.match(DIALOG, /e\.shiftKey && document\.activeElement === first/)
  // Escape cancels.
  assert.match(DIALOG, /e\.key === 'Escape'/)
})

test('errors are ANNOUNCED, not just coloured', () => {
  assert.match(DIALOG, /role="alert"/)
  assert.match(GUIDED, /role="alert"/)
  // Progress that changes without user action is announced politely.
  assert.match(GUIDED, /aria-live="polite"/)
})

test('a double-click cannot submit twice', () => {
  // The confirm button is disabled for the whole request, and re-enabled only on failure.
  assert.match(DIALOG, /const confirmDisabled = busy \|\| !phraseOk/)
  assert.match(DIALOG, /disabled=\{confirmDisabled\}/)
  assert.match(DIALOG, /aria-disabled=\{confirmDisabled\}/)
  assert.match(DIALOG, /if \(confirmDisabled\) return/)
  // And the guided view keeps at most one state request in flight.
  assert.match(GUIDED, /if \(inflight\.current\) return/)
})

test('backdrop and Escape can only CANCEL — neither path can confirm', () => {
  const backdropHandler = DIALOG.match(/onMouseDown=\{[^}]*\}/)?.[0] ?? ''
  assert.match(backdropHandler, /onCancel\(\)/)
  assert.ok(!/onConfirm/.test(backdropHandler), 'the backdrop must never confirm')
})

test('a phrase-gated dialog cannot be confirmed before the phrase matches', () => {
  assert.match(DIALOG, /const phraseOk = !requiredPhrase \|\| normalize\(typed\) === normalize\(requiredPhrase\)/)
})

test('the guided view keeps owner-only controls behind the owner-only endpoints', () => {
  // It reads and writes ONLY /api/admin/*, every one of which requires the platform
  // owner. There is no client-side authorization decision to bypass.
  for (const m of GUIDED.matchAll(/api\(`([^`]+)`/g)) {
    assert.ok(m[1].startsWith('/api/admin/'), `unexpected endpoint ${m[1]}`)
  }
})

test('internal status names stay behind the Advanced disclosure', () => {
  // The raw job/publish/gate vocabulary appears only inside <details>.
  const advanced = GUIDED.slice(GUIDED.indexOf('<details'))
  for (const token of ['advanced.jobStatus', 'advanced.publishStatus', 'advanced.failedGates']) {
    assert.ok(advanced.includes(token), `${token} should live in Advanced`)
    assert.equal(GUIDED.indexOf(token) >= GUIDED.indexOf('<details'), true, `${token} leaked into the normal path`)
  }
})

test('the guided form controls have real labels', () => {
  for (const id of ['guided-update', 'guided-target']) {
    assert.ok(GUIDED.includes(`htmlFor="${id}"`), `${id} has no <label htmlFor>`)
    assert.ok(GUIDED.includes(`id="${id}"`), `${id} is not on a control`)
  }
})
