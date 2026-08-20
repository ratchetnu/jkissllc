import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { historicalReplacementSeed, payCorrectionTimesheetHref } from '../app/lib/pay-correction-workflow'

const correction = {
  id: 'pc_one', staffId: 'crew & one', statementNumber: 'JK-PS-1001',
  periodStart: '2026-01-05', periodEnd: '2026-01-11', message: 'The hours are short.',
}

test('an approved request opens a crew-and-period-filtered time correction surface', () => {
  assert.equal(
    payCorrectionTimesheetHref(correction),
    '/admin/operations/timesheets?staffId=crew+%26+one&start=2026-01-05&end=2026-01-11',
  )
})

test('statement dates fill legacy requests that did not save their own period', () => {
  const legacy = { ...correction, periodStart: undefined, periodEnd: undefined }
  const statement = {
    staffId: legacy.staffId, statementNumber: 'JK-PS-1001', periodStart: '2025-12-29', periodEnd: '2026-01-04',
    statementSource: 'historical_manual' as const,
  }
  assert.match(payCorrectionTimesheetHref(legacy, statement), /start=2025-12-29&end=2026-01-04$/)
  assert.deepEqual(historicalReplacementSeed(legacy, statement), {
    correctionId: 'pc_one', staffId: 'crew & one', periodStart: '2025-12-29', periodEnd: '2026-01-04', periodUnit: 'custom',
    note: 'Replacement for JK-PS-1001 — The hours are short.',
  })
})

test('approval opens the correction workspace and preserves immutable-stub replacement steps', () => {
  const page = readFileSync(new URL('../app/admin/operations/pay-statements/page.tsx', import.meta.url), 'utf8')
  assert.match(page, /if \(action === 'approve'\)[\s\S]{0,180}setEditingCorrection\(data\.correction\)/)
  assert.match(page, /Correction approved — make the change/)
  assert.match(page, /Correct recorded hours/)
  assert.match(page, /Void current stub/)
  assert.match(page, /Regenerate from corrected work/)
  assert.match(page, /Enter corrected pay manually/)
  assert.match(page, /Continue correction/)
  assert.match(page, /const replacementBlocked = correctionResolution !== 'ready' \|\| correctionStatement\?\.status === 'issued'/)
  assert.match(page, /disabled=\{replacementBlocked\}/, 'replacement fails closed until the immutable original is authoritatively resolved as void')
  assert.match(page, /resolveCorrection: '1'/, 'workspace resolves the current stub independently of the capped list')
  assert.match(page, /setHistoricalInitial\(undefined\); setEditingCorrection\(null\)/, 'a completed replacement cannot seed a later unrelated prior-pay form')
})
