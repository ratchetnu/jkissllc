// Uniform photo review status — pure helpers (no Redis).
import assert from 'node:assert/strict'
import test from 'node:test'
import { uniformStatus, uniformNeedsResubmit, type UniformPhoto } from '../app/lib/uniform'

const photo = (o: Partial<UniformPhoto>): UniformPhoto =>
  ({ staffId: 's1', date: '2026-07-17', url: 'https://blob/x.jpg', uploadedAt: 1, ...o })

test('legacy records (no status) read as submitted', () => {
  assert.equal(uniformStatus(photo({})), 'submitted')
  assert.equal(uniformStatus(null), 'submitted')
})

test('explicit status is preserved', () => {
  assert.equal(uniformStatus(photo({ status: 'approved' })), 'approved')
  assert.equal(uniformStatus(photo({ status: 'rejected' })), 'rejected')
})

test('only a rejected photo asks the crew member to resubmit', () => {
  assert.equal(uniformNeedsResubmit(photo({ status: 'rejected' })), true)
  assert.equal(uniformNeedsResubmit(photo({ status: 'submitted' })), false)
  assert.equal(uniformNeedsResubmit(photo({ status: 'approved' })), false)
  assert.equal(uniformNeedsResubmit(photo({})), false, 'legacy submitted is not a resubmit prompt')
  assert.equal(uniformNeedsResubmit(null), false)
})
