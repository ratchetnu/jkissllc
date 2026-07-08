// Applicant identity documents are the most sensitive bytes this app touches — a
// photograph of someone's Social Security card. These tests pin the two things that
// keep them safe: the seal actually encrypts (and authenticates), and the migration
// classifies a stored reference correctly.
//
// The migration's I/O (Blob, Redis) is not exercised here on purpose — it mutates
// production. Everything that DECIDES lives in lib/doc-migration.ts and is covered.

import test from 'node:test'
import assert from 'node:assert/strict'

// doc-crypto reads the key lazily inside key(), so setting this before any test
// body runs is enough — no need to defer the imports.
process.env.DOC_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64')

import { sealDoc, openDoc, docCryptoReady } from '../app/lib/doc-crypto'
import { classify, isSealed, isLegacyPlaintext, pathnameOf, isPlaintextIdentityBlob } from '../app/lib/doc-migration'

const IMG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const URL_SS = 'https://store.public.blob.vercel-storage.com/driver-docs/ss_card/abc-123.jpg'

// ── the seal ─────────────────────────────────────────────────────────────────
test('a key is available, so uploads never have to fall back to plaintext', () => {
  assert.equal(docCryptoReady(), true)
})

test('sealing round-trips to the exact original bytes', () => {
  assert.deepEqual(openDoc(sealDoc(IMG)), IMG)
})

test('the sealed object is not the plaintext', () => {
  const sealed = sealDoc(IMG)
  assert.ok(!sealed.equals(IMG), 'ciphertext must differ from plaintext')
  assert.notEqual(sealed.subarray(1, 4).toString(), 'PNG', 'must not leak the PNG header')
  assert.ok(sealed.length > IMG.length, 'iv + tag are prepended')
})

test('the same document seals differently every time (fresh iv)', () => {
  assert.ok(!sealDoc(IMG).equals(sealDoc(IMG)), 'a fixed iv would leak equality between documents')
})

test('a tampered document is refused, not silently served', () => {
  const sealed = sealDoc(IMG)
  sealed[sealed.length - 1] ^= 0xff
  assert.throws(() => openDoc(sealed))
})

test('a truncated document is refused', () => {
  assert.throws(() => openDoc(sealDoc(IMG).subarray(0, 20)))
})

test('a document sealed under another key cannot be opened', async () => {
  const sealed = sealDoc(IMG)
  const prev = process.env.DOC_ENCRYPTION_KEY
  process.env.DOC_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')
  try {
    assert.throws(() => openDoc(sealed))
  } finally {
    process.env.DOC_ENCRYPTION_KEY = prev
  }
})

// ── the migration's decisions ────────────────────────────────────────────────
test('a legacy plaintext SS card is scheduled for sealing', () => {
  const c = classify({ kind: 'ss_card', url: URL_SS })
  assert.equal(c.action, 'seal')
  assert.equal(c.action === 'seal' && c.oldPath, 'driver-docs/ss_card/abc-123.jpg')
  assert.equal(c.action === 'seal' && c.newPath, 'driver-docs/ss_card/abc-123.jpg.enc')
})

test('driver licenses and state IDs are identity documents too', () => {
  for (const kind of ['drivers_license', 'id']) {
    assert.equal(classify({ kind, url: URL_SS }).action, 'seal', `${kind} must be sealed`)
  }
})

// If this ever flips, badge photos break on crew-facing screens for no security gain.
test('headshots are never touched', () => {
  const c = classify({ kind: 'headshot', url: 'https://store/driver-docs/headshot/x.jpg' })
  assert.deepEqual(c, { action: 'skip', reason: 'headshot' })
})

test('an already-sealed document is not double-encrypted', () => {
  const c = classify({ kind: 'ss_card', url: 'driver-docs/ss_card/abc.jpg.enc' })
  assert.deepEqual(c, { action: 'skip', reason: 'already-sealed' })
})

test('a pathname reference (post-encryption record) is left alone', () => {
  const c = classify({ kind: 'ss_card', url: 'driver-docs/ss_card/abc.jpg' })
  assert.deepEqual(c, { action: 'skip', reason: 'not-legacy' })
})

test('a garbage url is skipped rather than crashing the migration', () => {
  assert.deepEqual(classify({ kind: 'ss_card', url: 'http://' }), { action: 'skip', reason: 'unparseable' })
})

test('running the migration twice is a no-op the second time', () => {
  const first = classify({ kind: 'ss_card', url: URL_SS })
  assert.equal(first.action, 'seal')
  const after = classify({ kind: 'ss_card', url: first.action === 'seal' ? first.newPath : '' })
  assert.equal(after.action, 'skip')
})

// ── orphan sweep ─────────────────────────────────────────────────────────────
test('orphan sweep targets unsealed identity blobs only', () => {
  assert.equal(isPlaintextIdentityBlob('driver-docs/ss_card/a.jpg'), true)
  assert.equal(isPlaintextIdentityBlob('driver-docs/drivers_license/a.jpg'), true)
  assert.equal(isPlaintextIdentityBlob('driver-docs/ss_card/a.jpg.enc'), false, 'sealed blobs must survive')
  assert.equal(isPlaintextIdentityBlob('driver-docs/headshot/a.jpg'), false, 'headshots must survive')
})

test('url helpers', () => {
  assert.equal(isSealed('a/b.jpg.enc'), true)
  assert.equal(isSealed('a/b.jpg'), false)
  assert.equal(isLegacyPlaintext(URL_SS), true)
  assert.equal(isLegacyPlaintext('driver-docs/ss_card/a.jpg.enc'), false)
  assert.equal(pathnameOf(URL_SS), 'driver-docs/ss_card/abc-123.jpg')
  assert.equal(pathnameOf('not a url'), '')
})
