// Crew documents — the access gate and sealing defaults. Pure (no Redis).
import assert from 'node:assert/strict'
import test from 'node:test'
import { canAccess, defaultSealed, newCrewDocId } from '../app/lib/crew-documents'

test('library documents are readable by any crew member', () => {
  assert.equal(canAccess({ scope: 'library' }, 'anyone'), true)
  assert.equal(canAccess({ scope: 'library', staffId: undefined }, 's2'), true)
})

test('staff documents are readable only by their owner', () => {
  assert.equal(canAccess({ scope: 'staff', staffId: 's1' }, 's1'), true)
  assert.equal(canAccess({ scope: 'staff', staffId: 's1' }, 's2'), false, 'another crew member cannot read it')
  assert.equal(canAccess({ scope: 'staff', staffId: undefined }, 's1'), false, 'malformed staff doc denies')
})

test('personal tax + agreement docs seal by default; shared reference does not', () => {
  assert.equal(defaultSealed('tax', 'staff'), true)
  assert.equal(defaultSealed('agreement', 'staff'), true)
  assert.equal(defaultSealed('policy', 'staff'), false)
  assert.equal(defaultSealed('training', 'staff'), false)
  // Library scope is shared with everyone, so never sealed regardless of category.
  assert.equal(defaultSealed('agreement', 'library'), false)
  assert.equal(defaultSealed('tax', 'library'), false)
})

test('document ids are prefixed and unique', () => {
  const a = newCrewDocId()
  const b = newCrewDocId()
  assert.match(a, /^cd_[a-f0-9]{18}$/)
  assert.notEqual(a, b)
})
