// Operion Shadow — facets + server-side filtering (pure) tests.
import assert from 'node:assert/strict'
import test from 'node:test'
import { extractFacets, applyShadowFilter, parseShadowFilter, jobDeployment, jobModel } from '../app/lib/estimation/shadow-facets'
import type { V2ShadowJob } from '../app/lib/estimation/shadow-types'

const job = (over: Partial<V2ShadowJob> = {}): V2ShadowJob => ({
  jobVersion: 1, bookingId: 'bk', shadowJobId: 'vs', status: 'completed', idempotencyKey: 'k',
  estimatorVersion: 2, imageCount: 1, attempts: 1, createdBy: 'auto', updatedAt: 1000, ...over,
})

test('jobDeployment matches the modelScorecard grouping key', () => {
  const j = job({ model: 'anthropic/claude', promptVersion: 2, estimatorVersion: 3 })
  assert.equal(jobDeployment(j), 'anthropic/claude|2|3')
  assert.equal(jobModel(job({})), 'unknown')
})

test('extractFacets tallies distinct models/deployments with counts, sorted by frequency', () => {
  const jobs = [
    job({ model: 'anthropic/a', promptVersion: 1, estimatorVersion: 2 }),
    job({ model: 'anthropic/a', promptVersion: 1, estimatorVersion: 2 }),
    job({ model: 'openai/b', promptVersion: 1, estimatorVersion: 2 }),
  ]
  const f = extractFacets(jobs)
  assert.equal(f.models.length, 2)
  assert.equal(f.models[0].value, 'anthropic/a')   // most frequent first
  assert.equal(f.models[0].count, 2)
  assert.equal(f.models[0].label, 'a')             // display = last path segment
  assert.equal(f.deployments.length, 2)
  assert.equal(f.businesses.length, 0)             // no tenant field today
})

test('applyShadowFilter narrows by model + deployment + date; unset dims are no-ops', () => {
  const jobs = [
    job({ bookingId: '1', model: 'm1', promptVersion: 1, estimatorVersion: 2, completedAt: 1000 }),
    job({ bookingId: '2', model: 'm2', promptVersion: 1, estimatorVersion: 2, completedAt: 5000 }),
    job({ bookingId: '3', model: 'm1', promptVersion: 9, estimatorVersion: 2, completedAt: 9000 }),
  ]
  assert.equal(applyShadowFilter(jobs, {}).length, 3)                               // no-op
  assert.equal(applyShadowFilter(jobs, { model: 'm1' }).length, 2)
  assert.equal(applyShadowFilter(jobs, { deployment: 'm1|1|2' }).length, 1)         // model+version combo
  assert.deepEqual(applyShadowFilter(jobs, { from: 2000, to: 9000 }).map((j) => j.bookingId), ['2'])  // to is exclusive
  assert.equal(applyShadowFilter(jobs, { business: 'acme' }).length, 0)            // no business tags → empty
})

test('parseShadowFilter reads typed values and ignores junk', () => {
  const f = parseShadowFilter(new URLSearchParams('model=m1&deployment=m1%7C1%7C2&from=1000&to=abc&business='))
  assert.equal(f.model, 'm1')
  assert.equal(f.deployment, 'm1|1|2')
  assert.equal(f.from, 1000)
  assert.equal(f.to, undefined)      // non-numeric dropped
  assert.equal(f.business, undefined) // empty dropped
})
