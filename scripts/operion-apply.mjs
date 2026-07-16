#!/usr/bin/env node
// ── Operion Commit-Transfer runner (self-contained; runs on the CI runner) ───
// Fetches the approved, signed manifest for this automation job from Operion, verifies each
// file's hash, and writes exactly those files into the checked-out target working tree —
// nothing else. Deterministic; mirrors app/lib/platform/automation/apply-executor.ts (the
// tested engine). No external deps. Never logs secrets. Exit 0 on success, non-zero on any
// failure (so the workflow aborts before committing).
//
// Env: OPERION_CALLBACK_URL, OPERION_CALLBACK_SECRET, OPERION_JOB_ID
// Writes a result summary (counts only, no paths) to $OPERION_APPLY_RESULT (default apply-result.json).

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const { OPERION_CALLBACK_URL, OPERION_CALLBACK_SECRET, OPERION_JOB_ID } = process.env
const RESULT = process.env.OPERION_APPLY_RESULT || 'apply-result.json'
function die(msg) { console.error(`operion-apply: ${msg}`); process.exit(1) }
if (!OPERION_CALLBACK_URL || !OPERION_CALLBACK_SECRET) die('OPERION_CALLBACK_URL / OPERION_CALLBACK_SECRET not set')
if (!OPERION_JOB_ID) die('OPERION_JOB_ID not set')

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
function isSafeRepoPath(p) {
  if (typeof p !== 'string' || !p || p.length > 400 || p.includes('\0') || p.includes('\\')) return false
  if (p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:/.test(p)) return false
  // Brackets/parens allowed for Next.js dynamic segments ([id], [...slug]) + route groups —
  // mirrors app/lib/platform/automation/manifest.ts isSafeRepoPath. Traversal still blocked above.
  return p.split('/').every(s => s !== '' && s !== '.' && s !== '..' && /^[A-Za-z0-9._()\[\]-]+$/.test(s))
}

const manifestUrl = OPERION_CALLBACK_URL.replace(/\/callback\/?$/, '/manifest')
const body = JSON.stringify({ jobId: OPERION_JOB_ID })
const ts = String(Date.now())
const sig = crypto.createHmac('sha256', OPERION_CALLBACK_SECRET).update(`${ts}.${body}`).digest('hex')

const res = await fetch(manifestUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-operion-timestamp': ts, 'x-operion-signature': sig },
  body,
})
if (!res.ok) die(`manifest fetch failed (${res.status})`)
const { manifest, contents } = await res.json()
if (!manifest || !Array.isArray(manifest.entries)) die('manifest response malformed')

// Deterministic order: explicit order, add/modify before delete, then path.
const rank = (a) => (a === 'delete' ? 1 : 0)
const entries = [...manifest.entries].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || rank(a.action) - rank(b.action) || a.path.localeCompare(b.path))

const applied = [], skipped = [], failed = []
for (const e of entries) {
  if (!isSafeRepoPath(e.path)) { failed.push(e.path); continue }
  try {
    if (e.action === 'delete') {
      if (!fs.existsSync(e.path)) { skipped.push(e.path); continue }
      fs.rmSync(e.path); applied.push(e.path); continue
    }
    const c = contents?.[e.path]
    if (!c) { failed.push(e.path); continue }
    const buf = Buffer.from(c.contentBase64, 'base64')
    if (sha256(buf) !== e.sha256) { failed.push(e.path); continue }
    fs.mkdirSync(path.dirname(e.path), { recursive: true })
    fs.writeFileSync(e.path, buf); applied.push(e.path)
  } catch { failed.push(e.path) }
}

const summary = { applied: applied.length, skipped: skipped.length, failed: failed.length, changed: applied.length > 0 }
fs.writeFileSync(RESULT, JSON.stringify(summary))
console.log(`operion-apply: applied=${summary.applied} skipped=${summary.skipped} failed=${summary.failed}`)
if (failed.length) die(`${failed.length} file(s) failed to apply — aborting before commit`)
if (!summary.changed) die('no files changed — nothing to preview')
process.exit(0)
