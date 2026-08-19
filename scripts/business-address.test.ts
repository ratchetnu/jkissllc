import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { COMPANY, ADDRESS_ONE_LINE } from '../app/lib/company'
import { DEFAULT_BUSINESS_ADDRESS, formatBusinessAddress, parseBusinessAddress } from '../app/lib/business-address'

const read = (path: string) => readFileSync(path, 'utf8')

test('the default J Kiss LLC address is the Plano address', () => {
  assert.deepEqual(COMPANY.address, {
    line1: '8055 Windrose Ave #4119',
    city: 'Plano',
    state: 'TX',
    zip: '75024',
  })
  assert.equal(ADDRESS_ONE_LINE, '8055 Windrose Ave #4119, Plano, TX 75024')
  assert.equal(formatBusinessAddress(DEFAULT_BUSINESS_ADDRESS), ADDRESS_ONE_LINE)
})

test('business address validation normalizes state and preserves an optional suite', () => {
  const parsed = parseBusinessAddress({
    line1: ' 8055 Windrose Ave ', line2: ' #4119 ', city: ' Plano ', state: 'tx', postalCode: '75024',
  })
  assert.deepEqual(parsed, { address: {
    line1: '8055 Windrose Ave', line2: '#4119', city: 'Plano', state: 'TX', postalCode: '75024',
  } })
  assert.equal(formatBusinessAddress(parsed.address!), '8055 Windrose Ave, #4119, Plano, TX 75024')
  assert.match(parseBusinessAddress({ line1: 'x', city: 'Plano', state: 'Texas', postalCode: '75024' }).error!, /two-letter/)
  assert.match(parseBusinessAddress({ line1: 'x', city: 'Plano', state: 'TX', postalCode: '75' }).error!, /ZIP/)
})

test('business address changes are admin-only and flow into statement surfaces', () => {
  const route = read('app/api/admin/business-address/route.ts')
  assert.equal((route.match(/requirePermission\(req, 'settings:manage'\)/g) ?? []).length, 2)
  assert.ok(route.indexOf("requirePermission(req, 'settings:manage')") < route.indexOf('req.json()'))

  const settings = read('app/admin/operations/settings/page.tsx')
  assert.match(settings, /\/api\/admin\/business-address/)
  assert.match(settings, /Only administrators can update it/)

  assert.match(read('app/api/admin/pay-statements/[id]/route.ts'), /businessAddress: formatBusinessAddress/)
  assert.match(read('app/api/portal/pay-statements/[id]/route.ts'), /businessAddress: formatBusinessAddress/)
  assert.match(read('app/components/PayStatementDoc.tsx'), /businessAddress = ADDRESS_ONE_LINE/)
  assert.match(read('app/lib/statement-render.ts'), /renderStatementEmail\(s: PayStatement, businessAddress = ADDRESS_ONE_LINE\)/)
})
