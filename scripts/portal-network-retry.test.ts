import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { fetchWithRetry, type RetryNotice } from '../app/portal/network'

const response = (status: number, headers?: HeadersInit) =>
  new Response(JSON.stringify({ ok: status < 400 }), { status, headers })

test('GET retries a dropped connection and returns the successful response', async () => {
  let calls = 0
  const notices: RetryNotice[] = []
  const res = await fetchWithRetry('/api/example', {}, {
    fetcher: async () => {
      calls++
      if (calls === 1) throw new TypeError('network dropped')
      return response(200)
    },
    sleep: async () => {},
    onRetry: notice => notices.push(notice),
  })
  assert.equal(res.status, 200)
  assert.equal(calls, 2)
  assert.deepEqual(notices.map(n => n.reason), ['network'])
})

test('GET retries transient server responses but not ordinary 4xx errors', async () => {
  for (const retryable of [408, 425, 429, 500, 502, 503, 504]) {
    let calls = 0
    const res = await fetchWithRetry('/api/example', {}, {
      fetcher: async () => (++calls === 1 ? response(retryable) : response(200)),
      sleep: async () => {},
    })
    assert.equal(res.status, 200, `status ${retryable}`)
    assert.equal(calls, 2, `status ${retryable}`)
  }

  let calls = 0
  const res = await fetchWithRetry('/api/example', {}, {
    fetcher: async () => { calls++; return response(409) },
    sleep: async () => {},
  })
  assert.equal(res.status, 409)
  assert.equal(calls, 1)
})

test('mutations never retry unless the caller proves idempotency', async () => {
  let unsafeCalls = 0
  const unsafe = await fetchWithRetry('/api/example', { method: 'POST' }, {
    fetcher: async () => { unsafeCalls++; return response(503) },
    sleep: async () => {},
  })
  assert.equal(unsafe.status, 503)
  assert.equal(unsafeCalls, 1)

  let safeCalls = 0
  const safe = await fetchWithRetry('/api/example', { method: 'POST' }, {
    allowMutationRetry: true,
    fetcher: async () => (++safeCalls === 1 ? response(503) : response(200)),
    sleep: async () => {},
  })
  assert.equal(safe.status, 200)
  assert.equal(safeCalls, 2)
})

test('retry count is bounded at three attempts', async () => {
  let calls = 0
  await assert.rejects(() => fetchWithRetry('/api/example', {}, {
    maxAttempts: 99,
    fetcher: async () => { calls++; throw new TypeError('offline') },
    sleep: async () => {},
  }))
  assert.equal(calls, 3)
})

test('Retry-After is honored but capped so a tap cannot hang indefinitely', async () => {
  const sleeps: number[] = []
  let calls = 0
  await fetchWithRetry('/api/example', {}, {
    fetcher: async () => (++calls === 1 ? response(503, { 'retry-after': '30' }) : response(200)),
    sleep: async ms => { sleeps.push(ms) },
  })
  assert.deepEqual(sleeps, [2_000])
})

test('booking job actions retry only the proven-idempotent verbs', () => {
  const src = readFileSync(new URL('../app/portal/jobs/[id]/JobDetailClient.tsx', import.meta.url), 'utf8')
  assert.match(src, /allowMutationRetry: body\.action !== 'complete'/)
  assert.match(src, /Completion proof is not/)
  assert.match(src, /Connection dropped — retrying this action safely/)
})

test('both crew action screens visibly fail closed while offline', () => {
  const job = readFileSync(new URL('../app/portal/jobs/[id]/JobDetailClient.tsx', import.meta.url), 'utf8')
  const clock = readFileSync(new URL('../app/portal/clock/page.tsx', import.meta.url), 'utf8')
  for (const src of [job, clock]) {
    assert.match(src, /useConnectivity/)
    assert.match(src, /You’re offline/)
    assert.match(src, /aria-live="polite"/)
  }
  assert.match(job, /const actionDisabled = !!busy \|\| offline/)
  assert.match(clock, /disabled=\{punching \|\| offline\}/)
})

test('My Jobs retries reads, reloads on reconnect, and offers a real retry button', () => {
  const src = readFileSync(new URL('../app/portal/jobs/MyJobsClient.tsx', import.meta.url), 'utf8')
  assert.match(src, /fetchWithRetry/)
  assert.match(src, /if \(!offline\) void load\(\)/)
  assert.match(src, /Try again/)
  assert.match(src, /disabled=\{offline \|\| loading\}/)
})

test('clock retries preserve the exact action body and rely on server idempotency', () => {
  const client = readFileSync(new URL('../app/portal/clock/page.tsx', import.meta.url), 'utf8')
  const server = readFileSync(new URL('../app/lib/crew-timeclock.ts', import.meta.url), 'utf8')
  assert.match(client, /allowMutationRetry: true/)
  assert.match(server, /if \(assignee\.clockInAt\) return \{ ok: true, changed: false, already: true/)
  assert.match(server, /if \(assignee\.clockOutAt\) return \{ ok: true, changed: false, already: true/)
})

test('the retry helper stores nothing locally and queues no delayed payroll action', () => {
  const src = readFileSync(new URL('../app/portal/network.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB/)
  assert.doesNotMatch(src, /queue|pending action/i)
})
