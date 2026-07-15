import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  scopeBlobPath, sanitizeBlobSegment, legacyBlobPath, assertLegacyBlobPath,
  isTenantScopedBlobPath, compareLegacyAndTenantBlobPath,
} from '../app/lib/platform/tenancy/blob-keys'
import {
  resolveTenantFromResource, resolveTenantFromHost, resolveTenantFromStripe,
  tenantIdForOutboundMetadata,
} from '../app/lib/platform/tenancy/tenant-resolve'

// ── Blob paths: byte-identical when off, tenant-prefixed + fail-closed when on ──
test('scopeBlobPath is byte-identical when tenancy is off', () => {
  assert.equal(scopeBlobPath('quote-photos/abc.jpg', { enabled: false }), 'quote-photos/abc.jpg')
  assert.equal(scopeBlobPath('uniform-photos/staff1/x.webp', { enabled: false }), 'uniform-photos/staff1/x.webp')
})

test('scopeBlobPath prefixes tenant when on', () => {
  assert.equal(
    scopeBlobPath('quote-photos/abc.jpg', { enabled: true, tenantId: 'jkiss' }),
    'tenants/jkiss/quote-photos/abc.jpg',
  )
})

test('scopeBlobPath fails closed when on with no tenant context', () => {
  assert.throws(() => scopeBlobPath('quote-photos/abc.jpg', { enabled: true }), /tenant context required/)
})

test('scopeBlobPath rejects path traversal and absolute paths', () => {
  assert.throws(() => scopeBlobPath('../secrets/x', { enabled: false }), /traversal/)
  assert.throws(() => scopeBlobPath('quote-photos/../../etc/passwd', { enabled: false }), /traversal/)
  assert.throws(() => scopeBlobPath('/etc/passwd', { enabled: false }), /relative/)
  assert.throws(() => scopeBlobPath('tenants/other/quote-photos/x', { enabled: false }), /tenant-scoped/)
})

test('scopeBlobPath rejects a display-name tenant id (no name-derived boundary)', () => {
  assert.throws(() => scopeBlobPath('quote-photos/x.jpg', { enabled: true, tenantId: 'J Kiss LLC' }), /invalid tenant id/)
})

test('sanitizeBlobSegment strips directories, traversal, unsafe chars; keeps extension', () => {
  assert.equal(sanitizeBlobSegment('photo.JPG'), 'photo.JPG')
  assert.equal(sanitizeBlobSegment('../../evil.png'), 'evil.png')
  assert.equal(sanitizeBlobSegment('a b/c?.jpg'), 'c_.jpg')
  assert.throws(() => sanitizeBlobSegment('..'), /unsafe/)
  assert.equal(sanitizeBlobSegment(''), 'file')
})

test('legacyBlobPath strips the tenant prefix; isTenantScopedBlobPath detects it', () => {
  assert.equal(legacyBlobPath('tenants/jkiss/quote-photos/x.jpg'), 'quote-photos/x.jpg')
  assert.equal(legacyBlobPath('quote-photos/x.jpg'), 'quote-photos/x.jpg')
  assert.equal(isTenantScopedBlobPath('tenants/jkiss/quote-photos/x.jpg'), true)
  assert.equal(isTenantScopedBlobPath('quote-photos/x.jpg'), false)
})

test('compareLegacyAndTenantBlobPath returns the pair for dark-launch (or null w/o tenant)', () => {
  assert.deepEqual(
    compareLegacyAndTenantBlobPath('quote-photos/x.jpg', { tenantId: 'jkiss' }),
    { legacy: 'quote-photos/x.jpg', tenant: 'tenants/jkiss/quote-photos/x.jpg' },
  )
  assert.equal(compareLegacyAndTenantBlobPath('quote-photos/x.jpg'), null) // no tenant context
})

test('assertLegacyBlobPath normalizes and validates', () => {
  assert.equal(assertLegacyBlobPath('a/b/c.jpg'), 'a/b/c.jpg')
  assert.throws(() => assertLegacyBlobPath(''), /required/)
})

// ── Resolver: fallback when off, trusted-source when on, fail-closed otherwise ──
test('resolveTenantFromResource: fallback off, resource-binding on, fail-closed w/o binding', () => {
  assert.deepEqual(resolveTenantFromResource({ tenantId: 'x' }, { enabled: false }), { tenantId: 'jkiss', method: 'single-tenant-fallback' })
  assert.deepEqual(resolveTenantFromResource({ tenantId: 'jkiss' }, { enabled: true }), { tenantId: 'jkiss', method: 'resource-binding' })
  assert.equal(resolveTenantFromResource({}, { enabled: true }), null)
  assert.equal(resolveTenantFromResource(null, { enabled: true }), null)
})

test('resolveTenantFromHost: fallback off; known host maps on; unknown host fails closed', () => {
  assert.equal(resolveTenantFromHost('anything', { enabled: false })?.method, 'single-tenant-fallback')
  assert.deepEqual(resolveTenantFromHost('www.jkissllc.com', { enabled: true }), { tenantId: 'jkiss', method: 'host-mapping' })
  assert.deepEqual(resolveTenantFromHost('jkissllc.com:443', { enabled: true }), { tenantId: 'jkiss', method: 'host-mapping' })
  assert.equal(resolveTenantFromHost('some-random-preview.vercel.app', { enabled: true }), null)
})

test('resolveTenantFromStripe: fallback off; metadata on; fail-closed w/o metadata', () => {
  assert.equal(resolveTenantFromStripe({ tenantId: 'x' }, { enabled: false })?.method, 'single-tenant-fallback')
  assert.deepEqual(resolveTenantFromStripe({ tenantId: 'jkiss' }, { enabled: true }), { tenantId: 'jkiss', method: 'webhook-metadata' })
  assert.equal(resolveTenantFromStripe({}, { enabled: true }), null)
})

test('tenantIdForOutboundMetadata returns the reference tenant with no context', () => {
  assert.equal(tenantIdForOutboundMetadata(), 'jkiss')
})
