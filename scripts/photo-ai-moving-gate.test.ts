// Photo-AI eligibility gate: moving behind a flag, junk untouched.
//
// The gate is the ONLY thing that kept moving bookings out of the AI path — the
// pipeline, storage, status machine, admin display and review workflow already
// existed. A completed moving job (JK-B-1001) was replayed through the pipeline
// successfully, so this widens eligibility rather than building anything.
import assert from 'node:assert/strict'
import test from 'node:test'

import { supportsPhotoAi } from '../app/lib/book-now-ai'
import { JUNK_SERVICE_TYPES, MOVING_SERVICE_TYPES, type ServiceType } from '../app/lib/bookings'

const FLAG = 'AI_PHOTO_ESTIMATE_MOVING'
const withFlag = <T>(on: boolean, fn: () => T): T => {
  const prev = process.env[FLAG]
  if (on) process.env[FLAG] = '1'; else delete process.env[FLAG]
  try { return fn() } finally {
    if (prev === undefined) delete process.env[FLAG]; else process.env[FLAG] = prev
  }
}

test('junk bookings stay eligible regardless of the moving flag', () => {
  for (const serviceType of JUNK_SERVICE_TYPES) {
    assert.equal(withFlag(false, () => supportsPhotoAi({ serviceType })), true, `${serviceType} flag off`)
    assert.equal(withFlag(true, () => supportsPhotoAi({ serviceType })), true, `${serviceType} flag on`)
  }
})

test('moving bookings are NOT eligible while the flag is off — the default', () => {
  for (const serviceType of MOVING_SERVICE_TYPES) {
    assert.equal(withFlag(false, () => supportsPhotoAi({ serviceType })), false, serviceType)
  }
})

test('moving bookings become eligible only when the flag is on', () => {
  for (const serviceType of MOVING_SERVICE_TYPES) {
    assert.equal(withFlag(true, () => supportsPhotoAi({ serviceType })), true, serviceType)
  }
})

test('unsupported services are never eligible, flag or no flag', () => {
  const other = 'other' as ServiceType
  assert.equal(withFlag(false, () => supportsPhotoAi({ serviceType: other })), false)
  assert.equal(withFlag(true, () => supportsPhotoAi({ serviceType: other })), false,
    'the moving flag must not widen eligibility beyond the moving family')
})

test('the flag defaults OFF, so Production behaviour is unchanged by this deploy', () => {
  delete process.env[FLAG]
  assert.equal(supportsPhotoAi({ serviceType: 'moving' }), false)
  assert.equal(supportsPhotoAi({ serviceType: 'junk-removal' }), true)
})
