// Increment 3B.2A — deliberate-action framework tests. Pure logic + server-rendered
// markup assertions (react-dom/server; no jsdom) covering a11y roles, screen-reader
// labels, the typed-confirm gate, and the drawer's initial disabled state. Full DOM
// interaction (typing, focus movement) is exercised via the pure gate + the focus trap
// already implemented in the design-system Drawer; jsdom/Playwright interaction tests
// are a separate follow-up (consistent with the repo's current test posture).
import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  matchesConfirmation, riskPresentation, canConfirmDeliberateAction, summarizeChecklist,
  checklistStateLabel, checklistStateGlyph, type ChecklistItem,
} from '../app/components/ui/deliberate-action-logic'
import { RiskBanner, EligibilityChecklist, TypedConfirm, DeliberateActionDrawer } from '../app/components/ui/deliberate-action'

// ── Pure: typed confirmation ─────────────────────────────────────────────────
test('matchesConfirmation: exact after trim; empty requirement never matches', () => {
  assert.equal(matchesConfirmation('Supercharged Enterprises', 'Supercharged Enterprises'), true)
  assert.equal(matchesConfirmation('  Supercharged Enterprises  ', 'Supercharged Enterprises'), true) // trims
  assert.equal(matchesConfirmation('supercharged enterprises', 'Supercharged Enterprises'), false)    // case-sensitive default
  assert.equal(matchesConfirmation('supercharged enterprises', 'Supercharged Enterprises', { caseSensitive: false }), true)
  assert.equal(matchesConfirmation('', ''), false)
  assert.equal(matchesConfirmation('anything', ''), false)
  assert.equal(matchesConfirmation(undefined, 'X'), false)
})

// ── Pure: risk presentation roles ────────────────────────────────────────────
test('riskPresentation: problems announce as alert; info/success as status', () => {
  assert.equal(riskPresentation('destructive').role, 'alert')
  assert.equal(riskPresentation('warning').role, 'alert')
  assert.equal(riskPresentation('info').role, 'status')
  assert.equal(riskPresentation('success').role, 'status')
  assert.equal(riskPresentation('destructive').icon, 'danger')
})

// ── Pure: checklist helpers + summary ────────────────────────────────────────
test('checklist: state labels/glyphs + summary counts', () => {
  assert.equal(checklistStateLabel('pass'), 'Passed')
  assert.equal(checklistStateLabel('warn'), 'Warning')
  assert.equal(checklistStateLabel('fail'), 'Failed')
  assert.equal(checklistStateGlyph('pass'), '✓')
  const items: ChecklistItem[] = [
    { label: 'a', state: 'pass' }, { label: 'b', state: 'pass' },
    { label: 'c', state: 'warn' }, { label: 'd', state: 'fail' },
  ]
  const s = summarizeChecklist(items)
  assert.deepEqual({ total: s.total, passed: s.passed, warnings: s.warnings, failed: s.failed, allPassed: s.allPassed },
    { total: 4, passed: 2, warnings: 1, failed: 1, allPassed: false })
  assert.equal(summarizeChecklist([{ label: 'x', state: 'pass' }]).allPassed, true)
  assert.equal(summarizeChecklist([]).allPassed, false)
})

// ── Pure: the deliberate-action gate ─────────────────────────────────────────
test('canConfirmDeliberateAction: needs match, not loading, no blocking failures', () => {
  assert.equal(canConfirmDeliberateAction({ confirmed: true }), true)
  assert.equal(canConfirmDeliberateAction({ confirmed: false }), false)
  assert.equal(canConfirmDeliberateAction({ confirmed: true, loading: true }), false)
  assert.equal(canConfirmDeliberateAction({ confirmed: true, blockingFailures: 1 }), false)
})

// ── Render: RiskBanner ───────────────────────────────────────────────────────
test('RiskBanner renders the correct role + title', () => {
  const bad = renderToStaticMarkup(h(RiskBanner, { level: 'destructive', title: 'Irreversible' }))
  assert.match(bad, /role="alert"/)
  assert.match(bad, /Irreversible/)
  const info = renderToStaticMarkup(h(RiskBanner, { level: 'info', title: 'Heads up' }))
  assert.match(info, /role="status"/)
})

// ── Render: EligibilityChecklist (screen-reader words, not color-only) ───────
test('EligibilityChecklist renders state words + summary; is a list', () => {
  const html = renderToStaticMarkup(h(EligibilityChecklist, { items: [
    { label: 'Owner permission', state: 'pass' },
    { label: 'Verification fresh', state: 'warn', detail: 'older than 24h' },
    { label: 'No drift', state: 'fail' },
  ] as ChecklistItem[] }))
  assert.match(html, /<ul/)
  assert.match(html, /Passed:/)
  assert.match(html, /Warning:/)
  assert.match(html, /Failed:/)
  assert.match(html, /1 of 3 passed/)
  assert.match(html, /older than 24h/)
})

// ── Render: TypedConfirm (label wiring + confirmed state) ─────────────────────
test('TypedConfirm wires label/hint and reflects a matched value', () => {
  const empty = renderToStaticMarkup(h(TypedConfirm, { requiredValue: 'jkiss', value: '', onChange: () => {} }))
  assert.match(empty, /aria-describedby=/)
  assert.match(empty, /Enter/)             // hint prompts to type the value
  const matched = renderToStaticMarkup(h(TypedConfirm, { requiredValue: 'jkiss', value: 'jkiss', onChange: () => {} }))
  assert.match(matched, /Confirmed\./)
})

// ── Render: DeliberateActionDrawer (dialog semantics + disabled until confirmed) ──
test('DeliberateActionDrawer: dialog semantics, warning, and confirm disabled initially', () => {
  const html = renderToStaticMarkup(h(DeliberateActionDrawer, {
    open: true, onClose: () => {}, title: 'Publish to Production',
    warning: { level: 'destructive', title: 'This goes live' },
    confirm: { requiredValue: 'jkiss' }, confirmLabel: 'Publish', onConfirm: () => {},
  }))
  assert.match(html, /role="dialog"/)
  assert.match(html, /aria-modal="true"/)
  assert.match(html, /This goes live/)
  assert.match(html, /aria-disabled="true"/)   // confirm gate closed until the name is typed
  assert.match(html, /Publish/)
  assert.match(html, /Cancel/)
})

test('DeliberateActionDrawer: closed renders nothing', () => {
  const html = renderToStaticMarkup(h(DeliberateActionDrawer, { open: false, onClose: () => {}, title: 'X', onConfirm: () => {} }))
  assert.equal(html, '')
})
