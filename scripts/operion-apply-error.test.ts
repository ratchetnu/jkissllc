// Operion apply-runner — failure-reason capture (issue: owner saw only "apply_failed").
//
// The runner fetches the signed manifest from Operion. When Operion REFUSES (422) — dependency
// closure, target drift, a renamed file — the body carries the specific, non-secret reason. The
// runner must (a) exit non-zero so the workflow aborts before committing, and (b) persist that
// reason to OPERION_APPLY_ERROR so the workflow can forward it as `errorSummary`. Without this
// the owner is left retrying blindly. These tests run the REAL script as a subprocess against a
// tiny local manifest server, so they exercise the actual fetch + error-capture path end to end.

import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const SCRIPT = path.join(import.meta.dirname, 'operion-apply.mjs')

/** Start a one-shot manifest server that answers /manifest with the given status + body. */
function manifestServer(status: number, body: unknown): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (!req.url?.endsWith('/manifest')) { res.writeHead(404); res.end(); return }
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      // The runner derives the manifest URL by replacing a trailing /callback with /manifest.
      resolve({ url: `http://127.0.0.1:${port}/callback`, close: () => server.close() })
    })
  })
}

function runApply(cwd: string, callbackUrl: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT], {
      cwd,
      env: {
        ...process.env,
        OPERION_CALLBACK_URL: callbackUrl,
        OPERION_CALLBACK_SECRET: 'test-secret-at-least-16-chars',
        OPERION_JOB_ID: 'AUTO-TEST-1',
      },
    }, (err, _stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stderr: String(stderr) })
    })
  })
}

test('a 422 refusal is captured verbatim into the error file and aborts non-zero', async () => {
  const reason = 'dependency closure failed — the target is missing 1 required module: app/lib/pack-services.ts (imported by app/quote/page.tsx as "../lib/pack-services")'
  const srv = await manifestServer(422, { error: reason })
  const dir = mkdtempSync(path.join(tmpdir(), 'operion-apply-'))
  try {
    const { code, stderr } = await runApply(dir, srv.url)
    assert.notEqual(code, 0, 'must abort so the workflow never commits')
    const errPath = path.join(dir, 'apply-error.txt')
    assert.ok(existsSync(errPath), 'must persist the reason for the workflow to forward')
    const captured = readFileSync(errPath, 'utf8')
    assert.match(captured, /manifest refused \(422\)/)
    assert.match(captured, /pack-services\.ts/, 'the specific blocker survives to the owner')
    assert.match(stderr, /pack-services\.ts/)
  } finally { srv.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('the error file never exceeds the callback field cap (2000 chars)', async () => {
  const srv = await manifestServer(422, { error: 'x'.repeat(5000) })
  const dir = mkdtempSync(path.join(tmpdir(), 'operion-apply-'))
  try {
    await runApply(dir, srv.url)
    const captured = readFileSync(path.join(dir, 'apply-error.txt'), 'utf8')
    assert.ok(captured.length <= 2000, `error file is ${captured.length} chars; must be ≤ 2000`)
  } finally { srv.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('a non-JSON error body still yields a generic, non-empty reason (never a silent blank)', async () => {
  const srv = await manifestServer(500, '<html>gateway</html>')
  const dir = mkdtempSync(path.join(tmpdir(), 'operion-apply-'))
  try {
    const { code } = await runApply(dir, srv.url)
    assert.notEqual(code, 0)
    const captured = readFileSync(path.join(dir, 'apply-error.txt'), 'utf8')
    assert.match(captured, /500/, 'the status code is always present even without a JSON reason')
  } finally { srv.close(); rmSync(dir, { recursive: true, force: true }) }
})
