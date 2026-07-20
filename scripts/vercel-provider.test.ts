// VercelPreviewProvider — hermetic tests. Every Vercel HTTP call is mocked; no live calls,
// no token needed, preview-only. Verifies state mapping, safety guards (no production
// target, fail-closed without token), polling, cancel, logs reference, and health checks.
import assert from 'node:assert/strict'
import test from 'node:test'
import { VercelPreviewProvider, StubPreviewProvider, getPreviewProvider } from '../app/lib/platform/automation/vercel-provider'

type Route = [string, (url: string, init?: { method?: string; body?: string }) => { status: number; body: unknown }]
function mockFetch(routes: Route[]) {
  const calls: { url: string; init?: { method?: string; body?: string } }[] = []
  const fetch = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, init })
    for (const [pat, resp] of routes) if (url.includes(pat)) { const r = resp(url, init); return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body, text: async () => JSON.stringify(r.body) } }
    return { status: 404, ok: false, json: async () => ({}), text: async () => '{}' }
  }
  return { fetch: fetch as never, calls }
}
const ENV = { VERCEL_TOKEN: 'vc_secret', VERCEL_TEAM_ID: 'team_x' }
const noSleep = async () => {}

test('getPreviewProvider: live when token present, fail-closed stub otherwise', async () => {
  assert.equal(getPreviewProvider(ENV).name, 'vercel')
  const stub = getPreviewProvider({})
  assert.equal(stub.name, 'stub')
  assert.equal(stub.configured, false)
  assert.equal((await stub.createPreviewDeployment()).ok, false)
})

test('StubPreviewProvider fails closed on every op', async () => {
  const p = new StubPreviewProvider()
  assert.equal((await p.readPreviewDeployment()).ok, false)
  assert.equal((await p.waitForPreviewReady()).ok, false)
  assert.equal((await p.cancelPreviewDeployment()).ok, false)
  assert.equal((await p.verifyPreviewUrl()).ok, false)
  assert.equal((await p.runPreviewHealthCheck()).ok, false)
})

test('createPreviewDeployment: preview target only (never production), team-scoped', async () => {
  const m = mockFetch([['/v13/deployments', () => ({ status: 200, body: { id: 'dpl_1', url: 'app-abc.vercel.app', readyState: 'QUEUED', inspectorUrl: 'https://vercel.com/i/dpl_1' } })]])
  const p = new VercelPreviewProvider(ENV, { fetch: m.fetch, now: () => 0, sleep: noSleep })
  const r = await p.createPreviewDeployment({ project: 'proj_super', ref: 'operion/x', repoId: '999' })
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.data.deploymentId, 'dpl_1')
  assert.equal(r.ok && r.data.url, 'https://app-abc.vercel.app', 'bare host is upgraded to https')
  assert.equal(r.ok && r.data.state, 'queued')
  // The request body must NOT target production and must carry the git source.
  const body = JSON.parse(m.calls[0].init!.body!)
  assert.equal(body.target, null, 'target must be null (preview), never "production"')
  assert.notEqual(body.target, 'production')
  assert.deepEqual(body.gitSource, { type: 'github', ref: 'operion/x', repoId: '999' })
  assert.ok(m.calls[0].url.includes('teamId=team_x'), 'team scope applied')
})

test('createPreviewDeployment: config guards (project, ref, repoId) + no token', async () => {
  const m = mockFetch([['/v13/deployments', () => ({ status: 200, body: { id: 'x' } })]])
  const p = new VercelPreviewProvider(ENV, { fetch: m.fetch })
  assert.equal((await p.createPreviewDeployment({ project: '', ref: 'b', repoId: '1' })).ok, false)
  assert.equal((await p.createPreviewDeployment({ project: 'p', ref: '', repoId: '1' })).ok, false)
  assert.equal((await p.createPreviewDeployment({ project: 'p', ref: 'b' })).ok, false, 'repoId required')
  assert.equal(m.calls.length, 0, 'no HTTP call made when guards fail')
  const noTok = new VercelPreviewProvider({}, { fetch: m.fetch })
  const r = await noTok.createPreviewDeployment({ project: 'p', ref: 'b', repoId: '1' })
  assert.equal(r.ok, false); assert.ok(!r.ok && r.category === 'not_configured')
})

test('readPreviewDeployment maps readyState → normalized state', async () => {
  for (const [rs, want, ready, failed] of [['READY', 'ready', true, false], ['BUILDING', 'building', false, false], ['ERROR', 'error', false, true], ['CANCELED', 'canceled', false, true]] as const) {
    const m = mockFetch([['/v13/deployments/', () => ({ status: 200, body: { id: 'dpl_1', url: 'h.vercel.app', readyState: rs } })]])
    const p = new VercelPreviewProvider(ENV, { fetch: m.fetch })
    const r = await p.readPreviewDeployment('dpl_1')
    assert.equal(r.ok && r.data.state, want)
    assert.equal(r.ok && r.data.ready, ready)
    assert.equal(r.ok && r.data.failed, failed)
  }
})

test('readPreviewDeployment: 404 not found, 403 permission', async () => {
  const nf = new VercelPreviewProvider(ENV, { fetch: mockFetch([['/v13/deployments/', () => ({ status: 404, body: {} })]]).fetch })
  const r1 = await nf.readPreviewDeployment('dpl_x'); assert.ok(!r1.ok && r1.category === 'not_found')
  const fb = new VercelPreviewProvider(ENV, { fetch: mockFetch([['/v13/deployments/', () => ({ status: 403, body: {} })]]).fetch })
  const r2 = await fb.readPreviewDeployment('dpl_x'); assert.ok(!r2.ok && r2.category === 'permission')
})

test('waitForPreviewReady: polls through BUILDING → READY', async () => {
  let n = 0
  const m = mockFetch([['/v13/deployments/', () => ({ status: 200, body: { id: 'dpl_1', url: 'h.vercel.app', readyState: n++ < 2 ? 'BUILDING' : 'READY' } })]])
  const p = new VercelPreviewProvider(ENV, { fetch: m.fetch, now: () => 0, sleep: noSleep })
  const r = await p.waitForPreviewReady('dpl_1', { intervalMs: 1000 })
  assert.equal(r.ok && r.data.state, 'ready')
  assert.ok(n >= 3, 'polled multiple times')
})

test('waitForPreviewReady: ERROR terminal → preview_failed; CANCELED → canceled', async () => {
  const err = new VercelPreviewProvider(ENV, { fetch: mockFetch([['/v13/deployments/', () => ({ status: 200, body: { id: 'd', url: 'h', readyState: 'ERROR' } })]]).fetch, now: () => 0, sleep: noSleep })
  const r1 = await err.waitForPreviewReady('d'); assert.ok(!r1.ok && r1.category === 'preview_failed')
  const can = new VercelPreviewProvider(ENV, { fetch: mockFetch([['/v13/deployments/', () => ({ status: 200, body: { id: 'd', url: 'h', readyState: 'CANCELED' } })]]).fetch, now: () => 0, sleep: noSleep })
  const r2 = await can.waitForPreviewReady('d'); assert.ok(!r2.ok && r2.category === 'canceled')
})

test('waitForPreviewReady: times out while still building', async () => {
  let clock = 0
  const m = mockFetch([['/v13/deployments/', () => ({ status: 200, body: { id: 'd', url: 'h', readyState: 'BUILDING' } })]])
  const p = new VercelPreviewProvider(ENV, { fetch: m.fetch, now: () => clock, sleep: async () => { clock += 5000 } })
  const r = await p.waitForPreviewReady('d', { timeoutMs: 12_000, intervalMs: 5000 })
  assert.ok(!r.ok && r.category === 'timeout')
})

test('findPreviewByBranch: matches a preview by git branch, ignores production, null when none', async () => {
  const m = mockFetch([['/v6/deployments', () => ({ status: 200, body: { deployments: [
    { uid: 'dpl_prod', url: 'prod.vercel.app', readyState: 'READY', target: 'production', meta: { githubCommitRef: 'operion/upd-1006' } },
    { uid: 'dpl_prev', url: 'prev-abc.vercel.app', readyState: 'READY', target: null, meta: { githubCommitRef: 'operion/upd-1006' } },
  ] } })]])
  const r = await new VercelPreviewProvider(ENV, { fetch: m.fetch }).findPreviewByBranch('proj', 'operion/upd-1006')
  assert.equal(r.ok && r.data?.deploymentId, 'dpl_prev')       // the preview, not the production one
  assert.equal(r.ok && r.data?.url, 'https://prev-abc.vercel.app')
  const none = mockFetch([['/v6/deployments', () => ({ status: 200, body: { deployments: [] } })]])
  const r2 = await new VercelPreviewProvider(ENV, { fetch: none.fetch }).findPreviewByBranch('proj', 'operion/x')
  assert.equal(r2.ok && r2.data, null)
})

test('cancelPreviewDeployment PATCHes the cancel endpoint', async () => {
  const m = mockFetch([['/cancel', () => ({ status: 200, body: { state: 'CANCELED' } })]])
  const p = new VercelPreviewProvider(ENV, { fetch: m.fetch })
  const r = await p.cancelPreviewDeployment('dpl_1')
  assert.equal(r.ok && r.data.canceled, true)
  assert.equal(m.calls[0].init!.method, 'PATCH')
  assert.ok(m.calls[0].url.includes('/v12/deployments/dpl_1/cancel'))
})

test('rollbackProduction: a prj_… id goes straight to rollback (no project lookup)', async () => {
  const m = mockFetch([['/rollback/', () => ({ status: 200, body: {} })]])
  const p = new VercelPreviewProvider(ENV, { fetch: m.fetch })
  const r = await p.rollbackProduction('prj_direct123', 'dpl/prior')
  assert.equal(r.ok && r.data.rolledBack, true)
  assert.equal(m.calls.length, 1)                       // no resolution round-trip
  assert.equal(m.calls[0].init!.method, 'POST')
  assert.equal(m.calls[0].url, 'https://api.vercel.com/v9/projects/prj_direct123/rollback/dpl%2Fprior?teamId=team_x')
})

test('rollbackProduction: a display name is resolved first, then the immutable id is used (team-scoped on both)', async () => {
  const m = mockFetch([
    ['/rollback/', () => ({ status: 200, body: {} })],
    ['/v9/projects/supercharged', () => ({ status: 200, body: { id: 'prj_resolved9', name: 'supercharged' } })],
  ])
  const p = new VercelPreviewProvider(ENV, { fetch: m.fetch })
  const r = await p.rollbackProduction('supercharged', 'dpl_prior')
  assert.equal(r.ok && r.data.rolledBack, true)
  assert.equal(m.calls.length, 2)
  // 1) resolution — GET the read-only project endpoint, team-scoped, never the rollback path
  assert.equal(m.calls[0].init?.method, undefined)
  assert.equal(m.calls[0].url, 'https://api.vercel.com/v9/projects/supercharged?teamId=team_x')
  assert.equal(m.calls[0].url.includes('/rollback/'), false)
  // 2) rollback — POST with the RESOLVED immutable id, team-scoped, never the name
  assert.equal(m.calls[1].init!.method, 'POST')
  assert.equal(m.calls[1].url, 'https://api.vercel.com/v9/projects/prj_resolved9/rollback/dpl_prior?teamId=team_x')
  assert.equal(m.calls[1].url.includes('/projects/supercharged/'), false)
})

test('rollbackProduction: fails closed with NO rollback request when resolution yields no immutable id', async () => {
  for (const body of [{}, { id: 'not-a-prj' }, { id: '' }]) {
    const m = mockFetch([
      ['/rollback/', () => ({ status: 200, body: {} })],
      ['/v9/projects/supercharged', () => ({ status: 200, body })],
    ])
    const p = new VercelPreviewProvider(ENV, { fetch: m.fetch })
    const r = await p.rollbackProduction('supercharged', 'dpl_x')
    assert.equal(!r.ok && r.category, 'not_found')
    assert.equal(m.calls.length, 1)                                  // only the lookup ran
    assert.equal(m.calls.some(c => c.url.includes('/rollback/')), false)  // NEVER rolled back with the name
  }
})

test('rollbackProduction: resolution 401/403 stays a permission failure and blocks the rollback', async () => {
  for (const status of [401, 403]) {
    const m = mockFetch([
      ['/rollback/', () => ({ status: 200, body: {} })],
      ['/v9/projects/supercharged', () => ({ status, body: {} })],
    ])
    const p = new VercelPreviewProvider(ENV, { fetch: m.fetch })
    const r = await p.rollbackProduction('supercharged', 'dpl_x')
    assert.equal(!r.ok && r.category, 'permission')
    assert.equal(m.calls.length, 1)
  }
})

test('rollbackProduction: resolution 404 is categorized safely (not_found), no rollback', async () => {
  const m = mockFetch([
    ['/rollback/', () => ({ status: 200, body: {} })],
    ['/v9/projects/supercharged', () => ({ status: 404, body: {} })],
  ])
  const p = new VercelPreviewProvider(ENV, { fetch: m.fetch })
  const r = await p.rollbackProduction('supercharged', 'dpl_x')
  assert.equal(!r.ok && r.category, 'not_found')
  assert.equal(m.calls.length, 1)
})

test('rollbackProduction: after a good resolve, rollback 401/403→permission and 404→not_found', async () => {
  const resolve: Route = ['/v9/projects/supercharged', () => ({ status: 200, body: { id: 'prj_ok' } })]
  for (const [status, category] of [[401, 'permission'], [403, 'permission'], [404, 'not_found']] as const) {
    const m = mockFetch([['/rollback/', () => ({ status, body: {} })], resolve])
    const p = new VercelPreviewProvider(ENV, { fetch: m.fetch })
    const r = await p.rollbackProduction('supercharged', 'dpl_x')
    assert.equal(!r.ok && r.category, category)
    assert.equal(m.calls.length, 2)                                   // resolved, then attempted rollback
    assert.equal(m.calls[1].url.includes('/projects/prj_ok/rollback/'), true)
  }
})

test('rollbackProduction: fails closed with zero calls when no token is configured', async () => {
  const m = mockFetch([['/rollback/', () => ({ status: 200, body: {} })]])
  const r = await new VercelPreviewProvider({}, { fetch: m.fetch }).rollbackProduction('supercharged', 'dpl_x')
  assert.equal(r.ok, false)
  assert.equal(!r.ok && r.category, 'not_configured')
  assert.equal(m.calls.length, 0)
})

test('resolveProjectId: prj_ passthrough vs read-only lookup; requires a valid immutable id', async () => {
  const direct = mockFetch([])
  const pd = await new VercelPreviewProvider(ENV, { fetch: direct.fetch }).resolveProjectId('prj_abc')
  assert.equal(pd.ok && pd.data.projectId, 'prj_abc')
  assert.equal(direct.calls.length, 0)
  const look = mockFetch([['/v9/projects/supercharged', () => ({ status: 200, body: { id: 'prj_xyz' } })]])
  const pl = await new VercelPreviewProvider(ENV, { fetch: look.fetch }).resolveProjectId('supercharged')
  assert.equal(pl.ok && pl.data.projectId, 'prj_xyz')
  assert.equal(look.calls[0].url, 'https://api.vercel.com/v9/projects/supercharged?teamId=team_x')
})

test('publish is unchanged: promoteProduction still POSTs /promote with the given project, no resolution, no rollback', async () => {
  const m = mockFetch([['/promote/', () => ({ status: 200, body: {} })]])
  const p = new VercelPreviewProvider(ENV, { fetch: m.fetch })
  const r = await p.promoteProduction('some name', 'dpl_p')
  assert.equal(r.ok && r.data.promoted, true)
  assert.equal(m.calls.length, 1)
  assert.equal(m.calls[0].url, 'https://api.vercel.com/v10/projects/some%20name/promote/dpl_p?teamId=team_x')
  assert.equal(m.calls[0].url.includes('/rollback/'), false)
})

test('readDeploymentLogsReference returns inspector + events api (no log contents, no token)', async () => {
  const p = new VercelPreviewProvider(ENV, { fetch: mockFetch([]).fetch })
  const r = await p.readDeploymentLogsReference('dpl_1')
  assert.equal(r.ok, true)
  assert.ok(r.ok && r.data.inspectorUrl.includes('dpl_1'))
  assert.ok(r.ok && r.data.eventsApi.includes('/events'))
  assert.ok(r.ok && !JSON.stringify(r.data).includes('vc_secret'), 'never leaks the token')
})

test('verifyPreviewUrl + runPreviewHealthCheck hit the resolved url', async () => {
  const m = mockFetch([['/api/health', () => ({ status: 200, body: { ok: true } })], ['app-abc.vercel.app', () => ({ status: 200, body: {} })]])
  const p = new VercelPreviewProvider(ENV, { fetch: m.fetch })
  const v = await p.verifyPreviewUrl('app-abc.vercel.app')
  assert.equal(v.ok && v.data.reachable, true)
  const h = await p.runPreviewHealthCheck('https://app-abc.vercel.app')
  assert.equal(h.ok && h.data.ok, true)
  assert.ok(m.calls.some(c => c.url === 'https://app-abc.vercel.app/api/health'), 'health path resolved against base')
})
