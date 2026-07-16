// GitHubActionsProvider — hermetic tests. A throwaway RSA keypair signs a REAL App JWT,
// and every GitHub HTTP call is mocked. No live GitHub requests, no writes.
import assert from 'node:assert/strict'
import test from 'node:test'
import crypto from 'node:crypto'
import { GitHubActionsProvider } from '../app/lib/platform/automation/github-provider'

const T = 1_700_000_000_000
const KP = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })

type Route = [string, (url: string, init?: { headers?: Record<string, string> }) => { status: number; body: unknown }]
function mockFetch(routes: Route[]) {
  const calls: { url: string; init?: { headers?: Record<string, string> } }[] = []
  const fetch = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, init })
    for (const [pat, resp] of routes) if (url.includes(pat)) { const r = resp(url, init); return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body, text: async () => JSON.stringify(r.body) } }
    return { status: 404, ok: false, json: async () => ({}), text: async () => '{}' }
  }
  return { fetch: fetch as never, calls }
}
const REPO = { owner: 'ratchetnu', name: 'supercharged' }
const tokenRoute: Route = ['/access_tokens', () => ({ status: 201, body: { token: 'ghs_secret', expires_at: new Date(T + 3600_000).toISOString() } })]
const ENV = { GITHUB_APP_ID: '42', GITHUB_APP_PRIVATE_KEY: KP.privateKey }

test('mints a valid RS256 App JWT and exchanges it for an installation token', async () => {
  const m = mockFetch([tokenRoute])
  const p = new GitHubActionsProvider(ENV, { fetch: m.fetch, now: () => T })
  const r = await p.validateConnection('999')
  assert.equal(r.ok, true)
  // Verify the JWT the provider sent to the token endpoint.
  const authz = m.calls.find(c => c.url.includes('/access_tokens'))!.init!.headers!.Authorization
  const jwt = authz.replace('Bearer ', '')
  const [h, pl, sig] = jwt.split('.')
  const verified = crypto.createVerify('RSA-SHA256').update(`${h}.${pl}`).verify(KP.publicKey, Buffer.from(sig, 'base64url'))
  assert.equal(verified, true, 'JWT signature must verify with the App public key')
  const payload = JSON.parse(Buffer.from(pl, 'base64url').toString())
  assert.equal(payload.iss, '42')
  assert.ok(payload.exp > payload.iat)
})

test('installation token is cached (one exchange for repeated calls) and refreshes after expiry', async () => {
  let clock = T
  const m = mockFetch([tokenRoute, ['/repos/ratchetnu/supercharged', () => ({ status: 200, body: { default_branch: 'main', private: true } })]])
  const p = new GitHubActionsProvider(ENV, { fetch: m.fetch, now: () => clock })
  await p.validateConnection('999'); await p.readRepository('999', REPO)
  assert.equal(m.calls.filter(c => c.url.includes('/access_tokens')).length, 1, 'token minted once, then cached')
  clock = T + 3600_000 + 120_000        // past expiry
  await p.readRepository('999', REPO)
  assert.equal(m.calls.filter(c => c.url.includes('/access_tokens')).length, 2, 'token re-minted after expiry')
})

test('fails closed when credentials are missing', async () => {
  const m = mockFetch([tokenRoute])
  const noId = new GitHubActionsProvider({ GITHUB_APP_PRIVATE_KEY: KP.privateKey }, { fetch: m.fetch, now: () => T })
  assert.equal((await noId.validateConnection('999')).ok, false)
  const noKey = new GitHubActionsProvider({ GITHUB_APP_ID: '42' }, { fetch: m.fetch, now: () => T })
  assert.equal((await noKey.validateConnection('999')).ok, false)
  assert.equal(m.calls.length, 0, 'no HTTP call attempted without credentials')
})

test('read op returns mapped data and never mutates', async () => {
  const m = mockFetch([tokenRoute, ['/repos/ratchetnu/supercharged/branches/main', () => ({ status: 200, body: { commit: { sha: 'deadbeefcafe' } } })], ['/repos/ratchetnu/supercharged', () => ({ status: 200, body: { default_branch: 'main', private: true } })]])
  const p = new GitHubActionsProvider(ENV, { fetch: m.fetch, now: () => T })
  const repo = await p.readRepository('999', REPO)
  assert.deepEqual(repo, { ok: true, data: { defaultBranch: 'main', private: true } })
  const br = await p.readBranch('999', REPO, 'main')
  assert.equal(br.ok && br.data.commit, 'deadbeefcafe')
  // only GET/POST-token calls — no PUT/PATCH/DELETE
  assert.ok(m.calls.every(c => !c.url.includes('/merge')))
})

test('WRITE ops fail closed while OPERION_GITHUB_ACTIONS_ENABLED is off (default)', async () => {
  const m = mockFetch([tokenRoute])
  const p = new GitHubActionsProvider(ENV, { fetch: m.fetch, now: () => T })
  const d = await p.dispatchWorkflow('999', REPO, 'operion-update.yml', 'main', {})
  assert.equal(d.ok, false)
  assert.ok(!d.ok && /disabled/.test(d.error))
  assert.equal((await p.createPullRequest('999', REPO, 'h', 'main', 't', 'b')).ok, false)
  assert.equal((await p.mergePullRequest('999', REPO, 1, 'sha')).ok, false)
  // Nothing was dispatched/merged — no such HTTP call happened.
  assert.equal(m.calls.filter(c => c.url.includes('/dispatches') || c.url.includes('/merge')).length, 0)
})

test('error handling: installation not found + forbidden fail closed', async () => {
  const notFound = mockFetch([['/access_tokens', () => ({ status: 404, body: {} })]])
  const p1 = new GitHubActionsProvider(ENV, { fetch: notFound.fetch, now: () => T })
  const r1 = await p1.validateConnection('999')
  assert.equal(r1.ok, false); assert.ok(!r1.ok && /installation/.test(r1.error))
  const forbidden = mockFetch([tokenRoute, ['/repos/ratchetnu/supercharged', () => ({ status: 403, body: {} })]])
  const p2 = new GitHubActionsProvider(ENV, { fetch: forbidden.fetch, now: () => T })
  const r2 = await p2.readRepository('999', REPO)
  assert.equal(r2.ok, false); assert.ok(!r2.ok && r2.category === 'permission')
})
