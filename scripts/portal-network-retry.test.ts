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
  assert.match(src, /RETRY_SAFE_ACTIONS = new Set\(\['accept', 'decline', 'clock_in', 'clock_out'\]\)/)
  assert.match(src, /RETRY_SAFE_ACTIONS\.has\(body\.action\)/)
  assert.doesNotMatch(src, /body\.action !== 'complete'/)
  assert.match(src, /Connection dropped — retrying this action safely/)
})

test('completion upload retry preserves files, successful URLs, and one request ID', () => {
  const client = readFileSync(new URL('../app/portal/jobs/[id]/JobDetailClient.tsx', import.meta.url), 'utf8')
  const route = readFileSync(new URL('../app/api/portal/jobs/[id]/route.ts', import.meta.url), 'utf8')
  const orchestrator = readFileSync(new URL('../app/lib/booking-assignment.ts', import.meta.url), 'utf8')

  assert.match(client, /pendingCompletionRef/)
  assert.match(client, /if \(pending\.urls\[index\]\) continue/)
  assert.match(client, /requestId: pending\.requestId/)
  assert.match(client, /Retry upload/)
  assert.match(client, /selected .*kept on this page/)
  assert.doesNotMatch(client, /RETRY_SAFE_ACTIONS.*complete/)

  assert.match(route, /missing its retry key/)
  assert.match(route, /requestId,/)
  assert.match(orchestrator, /completionRequestIds/)
  assert.match(orchestrator, /slice\(-50\)/)
  assert.match(orchestrator, /includes\(requestId\)/)
})

test('the retry key is validated raw — the route never truncates it into validity', () => {
  const route = readFileSync(new URL('../app/api/portal/jobs/[id]/route.ts', import.meta.url), 'utf8')
  // The completion branch must NOT run the id through str(), which truncates.
  const completeBranch = route.slice(route.indexOf("case 'complete':"), route.indexOf('default:'))
  assert.doesNotMatch(completeBranch, /str\(body\.requestId/,
    'str() truncates, which makes the 100-character upper bound unenforceable')
  assert.match(completeBranch, /typeof raw === 'string' \? raw\.trim\(\) : ''/)
  assert.match(completeBranch, /\/\^\[A-Za-z0-9_-\]\{16,100\}\$\//)
})

test('a pending completion attempt is immutable: note and picker lock, Retry stays live', () => {
  const src = readFileSync(new URL('../app/portal/jobs/[id]/JobDetailClient.tsx', import.meta.url), 'utf8')

  assert.match(src, /const photosPending = pendingPhotoCount > 0/)
  // The note cannot be edited into a pending attempt it will never reach. readOnly,
  // NOT disabled — see the accessibility test below.
  assert.match(src, /<textarea[\s\S]*?readOnly=\{photosPending\}/)
  // A replacement file set cannot abandon already-uploaded Blob URLs.
  assert.match(src, /disabled=\{actionDisabled \|\| photosPending\}/)
  assert.match(src, /if \(pendingCompletionRef\.current\) return/)

  // Retry must remain reachable — gated only on busy/offline, never on photosPending.
  const retryButton = src.slice(src.indexOf('onClick={() => void submitPendingPhotos()}'))
  assert.match(retryButton.slice(0, 200), /disabled=\{actionDisabled\}/)
  assert.doesNotMatch(retryButton.slice(0, 200), /photosPending/)

  // Success is still the thing that unlocks the controls.
  assert.match(src, /setPendingPhotoCount\(0\)/)
})

test('the locked note stays focusable and both locked controls are described', () => {
  const src = readFileSync(new URL('../app/portal/jobs/[id]/JobDetailClient.tsx', import.meta.url), 'utf8')

  // `disabled` on the note would drop it out of the tab order and strip its
  // interactive affordance from the accessibility tree, leaving a screen-reader user
  // with a field that silently vanished. readOnly refuses edits without that cost.
  const textarea = src.slice(src.indexOf('<textarea'), src.indexOf('/>', src.indexOf('<textarea')))
  assert.match(textarea, /readOnly=\{photosPending\}/)
  assert.doesNotMatch(textarea, /disabled=/, 'the note must never be `disabled`')
  assert.match(textarea, /aria-label="Note for dispatch"/, 'accessible name is preserved')

  // One shared id, and BOTH locked controls point at it.
  assert.match(src, /const PENDING_LOCK_ID = '([a-z-]+)'/)
  const lockId = /const PENDING_LOCK_ID = '([a-z-]+)'/.exec(src)![1]
  assert.match(textarea, /aria-describedby=\{photosPending \? PENDING_LOCK_ID : undefined\}/)
  const fileInput = src.slice(src.indexOf('type="file"'), src.indexOf('</label>', src.indexOf('type="file"')))
  assert.match(fileInput, /aria-describedby=\{photosPending \? PENDING_LOCK_ID : undefined\}/)

  // The description element really carries that id, and is rendered on `photosPending`
  // ALONE — never gated on photoRetryReady, or the very first in-flight upload would
  // lock both controls with nothing explaining why.
  assert.match(src, /\{photosPending && \(\s*<p id=\{PENDING_LOCK_ID\}/)
  assert.doesNotMatch(src, /photoRetryReady && [\s\S]{0,80}id=\{PENDING_LOCK_ID\}/)
  assert.ok(lockId.length > 0, 'lock id is a non-empty literal')

  // The description is accurate: it must not promise the files survive a reload.
  assert.match(src, /locked to the pending upload and will be sent with it/)
  assert.match(src, /Reload the page to start over/)
  assert.doesNotMatch(src, /saved for later|will be sent when|resume after reload/i)
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
  assert.match(job, /setBusy\(''\)\s+return false/)
  assert.match(job, /Reconnect to load this job/)
  assert.match(job, /Try again/)
  assert.match(job, /opacity: actionDisabled \? \.55 : 1/)
  assert.match(clock, /disabled=\{punching \|\| offline\}/)
  assert.match(clock, /setRoutes\(current => current \?\? \[\]\)/)
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
  assert.match(client, /allowMutationRetry: action === 'clock_in' \|\| action === 'clock_out'/)
  assert.match(server, /if \(assignee\.clockInAt\) return \{ ok: true, changed: false, already: true/)
  assert.match(server, /if \(assignee\.clockOutAt\) return \{ ok: true, changed: false, already: true/)
})

test('the retry helper stores nothing locally and queues no delayed payroll action', () => {
  const src = readFileSync(new URL('../app/portal/network.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB/)
  assert.doesNotMatch(src, /queue|pending action/i)
})
