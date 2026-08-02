import { test } from 'node:test'
import assert from 'node:assert/strict'

import { assertClientUploadBlobPath, clientUploadBlobPath } from '../app/lib/platform/tenancy/client-blob-path'
import { runWithTenant } from '../app/lib/platform/tenancy/context'

function withFlag<T>(value: 'true' | 'false', fn: () => T): T {
  const prior = process.env.TENANCY_ENABLED
  process.env.TENANCY_ENABLED = value
  try { return fn() } finally {
    if (prior === undefined) delete process.env.TENANCY_ENABLED
    else process.env.TENANCY_ENABLED = prior
  }
}

test('browser-direct upload paths preserve legacy behavior while tenancy is off', () => {
  withFlag('false', () => {
    assert.equal(clientUploadBlobPath('receipt.jpg'), 'receipt.jpg')
    assert.equal(assertClientUploadBlobPath('receipt.jpg'), 'receipt.jpg')
  })
})

test('browser-direct upload paths bind to the active tenant', () => {
  withFlag('true', () => runWithTenant({ tenantId: 'jkiss' }, () => {
    const pathname = clientUploadBlobPath('receipt.jpg')
    assert.equal(pathname, 'tenants/jkiss/receipt.jpg')
    assert.equal(assertClientUploadBlobPath(pathname), pathname)
    assert.throws(() => assertClientUploadBlobPath('receipt.jpg'), /invalid blob pathname/)
    assert.throws(() => assertClientUploadBlobPath('tenants/supercharged/receipt.jpg'), /invalid blob pathname/)
  }))
})

test('browser-direct upload filenames cannot select directories or traverse', () => {
  withFlag('true', () => runWithTenant({ tenantId: 'jkiss' }, () => {
    assert.equal(clientUploadBlobPath('../../damage report.pdf'), 'tenants/jkiss/damage_report.pdf')
    assert.throws(() => assertClientUploadBlobPath('tenants/jkiss/nested/damage_report.pdf'), /invalid blob pathname/)
  }))
})
