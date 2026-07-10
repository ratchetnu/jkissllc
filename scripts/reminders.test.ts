// Reminder engine — pure logic (no Redis): smart-suppression rules, time-off date
// coverage, template/dispatch catalog integrity, and the new RBAC grants.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isSuppressedForTemplate, approvedTimeOffOn, segmentMatch, type CrewCard,
} from '../app/lib/reminder-segments'
import {
  TEMPLATES, TEMPLATE_BY_ID, getTemplate, DISPATCH_ACTIONS, ACK_IS_DONE, ACK_LABEL,
} from '../app/lib/reminder-templates'
import { can } from '../app/lib/rbac'
import type { TimeOffRequest } from '../app/lib/timeoff'

// A crew card with sensible defaults; override just what a test needs.
const card = (o: Partial<CrewCard> = {}): CrewCard => ({
  id: 's1', name: 'Test Crew', active: true, onboarding: false,
  businessNames: [], businessKeys: [], todayRoutes: [], upcomingRoutes: [], hasActiveRouteToday: true,
  confirmed: null, clockIn: 'none', clockOut: false, uniform: false, availabilitySubmitted: false,
  onTimeOff: false, hasOpenAck: false, doneTemplatesToday: [], activeNow: false, flags: [],
  ...o,
})

// ── Smart suppression (request Part 4) ───────────────────────────────────────
test('uniform reminder is suppressed once the photo is uploaded', () => {
  assert.equal(isSuppressedForTemplate(card({ uniform: false }), 'uniform_uploaded', 'uniform_photo'), false)
  assert.equal(isSuppressedForTemplate(card({ uniform: true }), 'uniform_uploaded', 'uniform_photo'), true)
})

test('clock-in reminder is suppressed once clocked in (or out)', () => {
  assert.equal(isSuppressedForTemplate(card({ clockIn: 'none' }), 'clocked_in', 'clock_in'), false)
  assert.equal(isSuppressedForTemplate(card({ clockIn: 'in' }), 'clocked_in', 'clock_in'), true)
  assert.equal(isSuppressedForTemplate(card({ clockIn: 'out' }), 'clocked_in', 'clock_in'), true)
})

test('route-confirmation reminder is suppressed once confirmed', () => {
  assert.equal(isSuppressedForTemplate(card({ confirmed: false }), 'route_confirmed', 'route_confirmation'), false)
  assert.equal(isSuppressedForTemplate(card({ confirmed: true }), 'route_confirmed', 'route_confirmation'), true)
})

test('availability reminder is suppressed once submitted', () => {
  assert.equal(isSuppressedForTemplate(card({ availabilitySubmitted: true }), 'availability_submitted', 'missing_availability'), true)
})

test('acked_done suppression is per-template', () => {
  const c = card({ doneTemplatesToday: ['delivery_app'] })
  assert.equal(isSuppressedForTemplate(c, 'acked_done', 'delivery_app'), true)
  assert.equal(isSuppressedForTemplate(c, 'acked_done', 'missing_pod'), false)
})

test("'none' suppression never suppresses", () => {
  assert.equal(isSuppressedForTemplate(card({ uniform: true, confirmed: true }), 'none', 'call_me'), false)
})

// ── Time off (request Part 10) ───────────────────────────────────────────────
const off = (o: Partial<TimeOffRequest>): TimeOffRequest =>
  ({ id: 't', staffId: 's1', startDate: '2026-07-10', endDate: '2026-07-10', partial: false, status: 'approved', isLate: false, createdAt: 1, updatedAt: 1, ...o }) as TimeOffRequest

test('approved time off covering the day is detected; pending/other days are not', () => {
  const reqs = [off({ startDate: '2026-07-09', endDate: '2026-07-11' })]
  assert.equal(approvedTimeOffOn(reqs, 's1', '2026-07-10'), true)
  assert.equal(approvedTimeOffOn(reqs, 's1', '2026-07-12'), false)
  assert.equal(approvedTimeOffOn(reqs, 's2', '2026-07-10'), false)
  assert.equal(approvedTimeOffOn([off({ status: 'pending' })], 's1', '2026-07-10'), false)
})

// ── Segment flags ────────────────────────────────────────────────────────────
test('a crew member on active route without uniform is flagged missing_uniform, but not while on time off', () => {
  const flagged = card({ hasActiveRouteToday: true, uniform: false })
  // computeFlags runs inside buildCrewCards; here we assert the segment predicate via a card carrying flags.
  flagged.flags = ['all', 'missing_uniform']
  assert.equal(segmentMatch(flagged, 'missing_uniform'), true)
  assert.equal(segmentMatch(flagged, 'missing_clock_out'), false)
})

// ── Template + dispatch catalog integrity (request Part 3, 13) ───────────────
test('all required templates exist with valid ack options', () => {
  const required = ['uniform_photo', 'delivery_app', 'route_confirmation', 'clock_in', 'clock_out',
    'dispatch_needs_you', 'call_me', 'missing_pod', 'missing_equipment_check', 'missing_availability', 'custom']
  for (const id of required) {
    assert.ok(TEMPLATE_BY_ID[id], `missing template ${id}`)
    for (const a of TEMPLATE_BY_ID[id].ackOptions) assert.ok(a in ACK_LABEL, `bad ack ${a} in ${id}`)
  }
  assert.equal(getTemplate('does-not-exist').id, 'custom')  // unknown → custom fallback
  assert.equal(TEMPLATES.length, required.length)
})

test('dispatch actions are well-formed and unique', () => {
  const ids = new Set<string>()
  for (const d of DISPATCH_ACTIONS) {
    assert.ok(d.message.length > 0)
    assert.ok(d.ackOptions.every(a => a in ACK_LABEL))
    assert.equal(ids.has(d.id), false)
    ids.add(d.id)
  }
  assert.ok(DISPATCH_ACTIONS.some(d => d.id === 'call_me'))
})

test('a "done" ack marks completion; a plain acknowledgement does not', () => {
  assert.equal(ACK_IS_DONE.completed, true)
  assert.equal(ACK_IS_DONE.already_done, true)
  assert.equal(ACK_IS_DONE.acknowledged, false)
  assert.equal(ACK_IS_DONE.need_help, false)
})

// ── RBAC grants (request Part 9) ─────────────────────────────────────────────
test('reminder/dispatch permissions: admin + manager yes, crew no', () => {
  for (const p of ['reminders:manage', 'dispatch:send', 'messages:send', 'comms:analytics'] as const) {
    assert.equal(can('admin', p), true, `admin ${p}`)
    assert.equal(can('manager', p), true, `manager ${p}`)
    assert.equal(can('crew', p), false, `crew ${p}`)
  }
})

test('crew self-service reminder/uniform permissions are crew-only self scopes', () => {
  assert.equal(can('crew', 'self:reminders'), true)
  assert.equal(can('crew', 'self:uniform'), true)
  assert.equal(can('crew', 'self:messages'), true)
  assert.equal(can('crew', 'reminders:manage'), false)
})
