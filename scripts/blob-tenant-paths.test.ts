// Tenant-safe Blob write paths (Phase 3). Every Blob `put(...)` site now builds
// its physical path through `scopeBlobPath(...)`, so:
//   • while tenancy is OFF the path is BYTE-IDENTICAL to the legacy string used
//     today (existing objects + stored URLs keep working, no migration);
//   • once tenancy is ON the object lands under `tenants/<id>/…` and a write with
//     no tenant context FAILS CLOSED instead of silently sharing the namespace;
//   • the interpolated filename is sanitized, so a crafted id/ext can never
//     smuggle a directory or `..` traversal into the key.
//
// These tests import the REAL exported per-site helpers and drive them through the
// real feature flag (process.env.TENANCY_ENABLED) and the real request-scoped
// tenant context (runWithTenant) — not a re-implementation of scopeBlobPath.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { quotePhotoBlobPath } from '../app/api/upload/route'
import { adminPhotoBlobPath } from '../app/api/admin/upload/route'
import { uniformPhotoBlobPath } from '../app/api/portal/uniform/route'
import { driverDocBlobPath } from '../app/api/careers/upload/route'
import { proofBlobPath, PROOF_PATH_RE } from '../app/lib/payment-proof'
import { legacyBlobPath, isTenantScopedBlobPath } from '../app/lib/platform/tenancy/blob-keys'
import { runWithTenant } from '../app/lib/platform/tenancy/context'

// A fixed UUID-shaped id so path assertions are deterministic.
const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const TOKEN = 'a1b2c3d4e5f60718' // booking token shape: [a-f0-9]{16,}

// Run `fn` with TENANCY_ENABLED forced to `val`, then restore the prior env.
function withFlag<T>(val: 'true' | 'false', fn: () => T): T {
  const prev = process.env.TENANCY_ENABLED
  process.env.TENANCY_ENABLED = val
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.TENANCY_ENABLED
    else process.env.TENANCY_ENABLED = prev
  }
}

// Each write site: (label, helper→path, exact legacy string it must equal when off).
const SITES: Array<{ label: string; build: () => string; legacy: string }> = [
  { label: 'public quote/booking photo', build: () => quotePhotoBlobPath(ID, 'jpg'), legacy: `quote-photos/${ID}.jpg` },
  { label: 'admin ops photo', build: () => adminPhotoBlobPath(ID, 'png'), legacy: `admin-photos/${ID}.png` },
  { label: 'crew uniform photo', build: () => uniformPhotoBlobPath('staff_7', ID, 'webp'), legacy: `uniform-photos/staff_7/${ID}.webp` },
  { label: 'applicant identity doc (sealed)', build: () => driverDocBlobPath('ss_card', ID, 'jpg', true), legacy: `driver-docs/ss_card/${ID}.jpg.enc` },
  { label: 'applicant headshot (public)', build: () => driverDocBlobPath('headshot', ID, 'png', false), legacy: `driver-docs/headshot/${ID}.png` },
  { label: 'payment proof (sealed)', build: () => proofBlobPath(TOKEN, ID, 'jpg'), legacy: `payment-proofs/${TOKEN}/${ID}.jpg.enc` },
]

test('byte-identical to the legacy path when tenancy is OFF', () => {
  withFlag('false', () => {
    for (const s of SITES) {
      assert.equal(s.build(), s.legacy, `${s.label} must be unchanged when tenancy is off`)
      assert.ok(!isTenantScopedBlobPath(s.build()), `${s.label} must NOT be tenant-scoped when off`)
    }
  })
})

test('tenant-prefixed under the active tenant when tenancy is ON', () => {
  withFlag('true', () => {
    runWithTenant({ tenantId: 'jkiss' }, () => {
      for (const s of SITES) {
        const p = s.build()
        assert.equal(p, `tenants/jkiss/${s.legacy}`, `${s.label} must land under the tenant prefix`)
        assert.ok(isTenantScopedBlobPath(p))
        // The logical (legacy) path is recoverable — same object, tenant-scoped home.
        assert.equal(legacyBlobPath(p), s.legacy)
      }
    })
  })
})

test('fails closed when tenancy is ON but there is no tenant context', () => {
  withFlag('true', () => {
    for (const s of SITES) {
      assert.throws(s.build, /tenant context required/, `${s.label} must refuse to write into the shared namespace`)
    }
  })
})

test('interpolated filename is sanitized — no directory escape or traversal', () => {
  // A malicious id carrying path separators / traversal collapses to a basename.
  const evilId = '../../../etc/passwd'
  withFlag('false', () => {
    assert.equal(quotePhotoBlobPath(evilId, 'jpg'), 'quote-photos/passwd.jpg')
    assert.equal(driverDocBlobPath('ss_card', evilId, 'png', true), 'driver-docs/ss_card/passwd.png.enc')
    assert.equal(proofBlobPath(TOKEN, evilId, 'jpg'), `payment-proofs/${TOKEN}/passwd.jpg.enc`)
    for (const build of [
      () => quotePhotoBlobPath(evilId, 'jpg'),
      () => adminPhotoBlobPath(evilId, 'png'),
      () => uniformPhotoBlobPath('staff_7', evilId, 'webp'),
      () => driverDocBlobPath('headshot', evilId, 'png', false),
      () => proofBlobPath(TOKEN, evilId, 'jpg'),
    ]) {
      assert.ok(!build().includes('..'), 'sanitized path must never contain ..')
    }
  })
  // Even under a tenant, the escape is neutralized before the prefix is applied.
  withFlag('true', () => {
    runWithTenant({ tenantId: 'jkiss' }, () => {
      assert.equal(quotePhotoBlobPath(evilId, 'jpg'), 'tenants/jkiss/quote-photos/passwd.jpg')
    })
  })
})

test('cross-tenant denial — a path built for tenant A never resolves under tenant B', () => {
  withFlag('true', () => {
    const pathA = runWithTenant({ tenantId: 'alpha' }, () => quotePhotoBlobPath(ID, 'jpg'))
    const pathB = runWithTenant({ tenantId: 'beta' }, () => quotePhotoBlobPath(ID, 'jpg'))

    assert.ok(pathA.startsWith('tenants/alpha/'))
    assert.ok(pathB.startsWith('tenants/beta/'))
    // A's object is NOT reachable inside B's prefix, and vice-versa.
    assert.ok(!pathA.startsWith('tenants/beta/'))
    assert.ok(!pathB.startsWith('tenants/alpha/'))
    assert.notEqual(pathA, pathB)
    // Same logical object, two isolated tenant homes.
    assert.equal(legacyBlobPath(pathA), legacyBlobPath(pathB))

    // The uniform site (which also nests a staffId) stays isolated too.
    const uA = runWithTenant({ tenantId: 'alpha' }, () => uniformPhotoBlobPath('staff_7', ID, 'jpg'))
    assert.ok(uA.startsWith('tenants/alpha/uniform-photos/staff_7/'))
    assert.ok(!uA.startsWith('tenants/beta/'))
  })
})

test('PROOF_PATH_RE stays exact for legacy paths and tolerates the tenant prefix', () => {
  const legacy = `payment-proofs/${TOKEN}/${ID}.jpg.enc`
  const scoped = withFlag('true', () => runWithTenant({ tenantId: 'jkiss' }, () => proofBlobPath(TOKEN, ID, 'jpg')))

  // Byte-identical legacy proof path still validates (no regression for stored records).
  assert.ok(PROOF_PATH_RE.test(legacy))
  // The tenant-scoped proof path a future ON state produces also validates.
  assert.equal(scoped, `tenants/jkiss/${legacy}`)
  assert.ok(PROOF_PATH_RE.test(scoped))

  // Still rejects malformed / foreign shapes.
  assert.ok(!PROOF_PATH_RE.test('payment-proofs/short/uuid.jpg.enc')) // token not hex-16+
  assert.ok(!PROOF_PATH_RE.test('../etc/passwd'))
  assert.ok(!PROOF_PATH_RE.test('tenants/jkiss/driver-docs/ss_card/x.jpg.enc')) // wrong family
})
