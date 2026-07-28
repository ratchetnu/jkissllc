// The mobile audit must never point a browser at Production.
//
// The defect these tests pin: `preflight()` asked only "can I reach this host?", never
// "am I allowed to audit this host?". With
//   BASE=https://jkissllc.com ADMIN_PASSWORD=<production credential>
// the audit authenticated against Production via /api/admin/auth and navigated every
// configured route as the owner — and CLICK_TEXT would have clicked there. Nothing in
// the tool refused it.
//
// The policy is an ALLOWLIST on purpose. A denylist is only ever as good as the last
// alias someone remembered to add, and hostnames have many spellings (uppercase, a
// trailing dot, an explicit port, a lookalike registered tomorrow). Everything not
// positively recognised as loopback / a Vercel Preview deployment / an explicitly
// approved test host is refused, and the refusal is BLOCKED_ENV — never a pass.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  classifyTarget, classifyFinalUrl, resolveBase, normalizeHost,
  isLoopbackHost, isVercelPreviewHost, isProductionHost,
  PRODUCTION_HOSTS, DEFAULT_BASE,
} from './mobile-audit-target-guard.mjs'
import { summarizeRoutes } from './mobile-audit-classify.mjs'
import { PRODUCTION_DOMAINS } from '../app/lib/platform/sandbox/guards'

type Verdict =
  | { ok: true; host: string; kind: 'loopback' | 'preview' | 'approved' }
  | { ok: false; outcome: string; code: string; host: string; reason: string }

const verdict = (base: string, opts?: Record<string, unknown>) =>
  classifyTarget(base, opts) as Verdict

// A real Preview host from this project, and the Production alias it must not resemble.
const PREVIEW = 'https://jkissllc-7hvaqxatt-nunubaby-6829s-projects.vercel.app'
const PREVIEW_GIT = 'https://jkissllc-git-main-nunubaby-6829s-projects.vercel.app'

// ── Allowed targets ──────────────────────────────────────────────────────────

test('localhost is allowed', () => {
  const v = verdict('http://localhost:3111')
  assert.equal(v.ok, true)
  assert.equal((v as { kind: string }).kind, 'loopback')
})

test('127.0.0.1 is allowed', () => {
  const v = verdict('http://127.0.0.1:3111')
  assert.equal(v.ok, true)
  assert.equal((v as { kind: string }).kind, 'loopback')
})

test('the whole 127/8 loopback block is allowed', () => {
  assert.equal(verdict('http://127.0.0.2:3111').ok, true)
})

test('IPv6 loopback is allowed, matching the local policy for 127.0.0.1', () => {
  const v = verdict('http://[::1]:3111')
  assert.equal(v.ok, true)
  assert.equal((v as { host: string }).host, '::1')
})

test('an approved Vercel Preview deployment is allowed', () => {
  const v = verdict(PREVIEW)
  assert.equal(v.ok, true)
  assert.equal((v as { kind: string }).kind, 'preview')
})

test('a Vercel branch-alias Preview deployment is allowed', () => {
  const v = verdict(PREVIEW_GIT)
  assert.equal(v.ok, true)
  assert.equal((v as { kind: string }).kind, 'preview')
})

test('an explicitly approved local test host is allowed', () => {
  const v = verdict('http://audit.test:3111', { approvedHost: 'audit.test' })
  assert.equal(v.ok, true)
  assert.equal((v as { kind: string }).kind, 'approved')
})

// ── Production targets ───────────────────────────────────────────────────────

test('jkissllc.com is rejected', () => {
  const v = verdict('https://jkissllc.com')
  assert.equal(v.ok, false)
  assert.equal((v as { code: string }).code, 'production_host')
  assert.equal((v as { outcome: string }).outcome, 'BLOCKED_ENV')
})

test('www.jkissllc.com is rejected', () => {
  assert.equal((verdict('https://www.jkissllc.com') as { code: string }).code, 'production_host')
})

test('jkissllc.vercel.app (the Production alias) is rejected', () => {
  assert.equal((verdict('https://jkissllc.vercel.app') as { code: string }).code, 'production_host')
})

test('the bare project alias does not satisfy the Preview shape', () => {
  // It has no deployment hash and no -git- segment, which is what separates a
  // generated Preview URL from a Production alias.
  assert.equal(isVercelPreviewHost('jkissllc.vercel.app'), false)
})

test('every Production domain in repository config is rejected', () => {
  // Pins this guard to app/lib/platform/sandbox/guards.ts. If a Production domain is
  // ever added there and not here, this fails instead of silently allowing it.
  for (const domain of PRODUCTION_DOMAINS) {
    assert.ok(
      PRODUCTION_HOSTS.includes(domain),
      `${domain} is in PRODUCTION_DOMAINS but not in the audit guard's PRODUCTION_HOSTS`,
    )
    assert.equal(verdict(`https://${domain}`).ok, false, `${domain} must be rejected`)
  }
})

test('the alternate Production brand (superchargedenterprise.com) is rejected', () => {
  assert.equal((verdict('https://superchargedenterprise.com') as { code: string }).code, 'production_host')
  assert.equal((verdict('https://www.superchargedenterprise.com') as { code: string }).code, 'production_host')
})

// ── Spellings that must not slip past ────────────────────────────────────────

test('uppercase hostnames are normalized and still rejected', () => {
  assert.equal((verdict('HTTPS://JKISSLLC.COM') as { code: string }).code, 'production_host')
  assert.equal((verdict('https://WWW.JKissLLC.CoM') as { code: string }).code, 'production_host')
})

test('a trailing-dot FQDN is still rejected', () => {
  assert.equal((verdict('https://jkissllc.com.') as { code: string }).code, 'production_host')
  assert.equal(normalizeHost('jkissllc.com.'), 'jkissllc.com')
})

test('an explicit port does not bypass the guard', () => {
  assert.equal((verdict('https://jkissllc.com:443') as { code: string }).code, 'production_host')
  assert.equal((verdict('http://jkissllc.com:8080') as { code: string }).code, 'production_host')
})

test('a hostname lookalike does not bypass the guard', () => {
  // These are NOT Production, but they are not approved either — the allowlist is what
  // stops them, which is exactly why the policy is not a denylist.
  for (const host of [
    'jkissllc.com.evil.test',        // Production host as a left-hand label
    'notjkissllc.com',
    'jkissllc.co',
    'jkissllc-com.vercel.app',       // no hash, no -git-
    'preview.jkissllc.com',          // would pass a naive includes('preview')
    'jkissllc.com.vercel.app',
  ]) {
    const v = verdict(`https://${host}`)
    assert.equal(v.ok, false, `${host} must not be allowed`)
    assert.equal((v as { code: string }).code, 'not_an_approved_target')
  }
})

test('a substring test for "preview" is not what makes a host allowed', () => {
  assert.equal(isVercelPreviewHost('preview.jkissllc.com'), false)
  assert.equal(isVercelPreviewHost('my-preview-site.example.com'), false)
})

test('an approved-host override cannot be used to allow Production', () => {
  const v = verdict('https://jkissllc.com', { approvedHost: 'jkissllc.com' })
  assert.equal(v.ok, false)
  assert.equal((v as { code: string }).code, 'production_host')
})

// ── Fail-closed inputs ───────────────────────────────────────────────────────

test('a malformed BASE fails closed', () => {
  for (const bad of ['not a url', 'http://', '://jkissllc.com', 'jkissllc.com']) {
    const v = verdict(bad)
    assert.equal(v.ok, false, `${bad} must fail closed`)
    assert.ok(['malformed_base', 'not_an_approved_target'].includes((v as { code: string }).code))
  }
})

test('a missing BASE fails clearly', () => {
  for (const empty of ['', '   ', null as unknown as string, undefined as unknown as string]) {
    const v = verdict(empty)
    assert.equal(v.ok, false)
    assert.equal((v as { code: string }).code, 'missing_base')
  }
})

test('a non-http scheme is refused', () => {
  assert.equal((verdict('file:///etc/passwd') as { code: string }).code, 'unsupported_scheme')
})

test('an unset BASE resolves to the loopback default; a blank BASE does not', () => {
  assert.equal(resolveBase([], {}), DEFAULT_BASE)
  assert.equal(verdict(resolveBase([], {})).ok, true)
  // Set-but-blank means an upstream interpolation failed. Silently auditing localhost
  // instead would be the same class of untruth this tool exists to prevent.
  assert.equal(resolveBase([], { BASE: '' }), '')
  assert.equal((verdict(resolveBase([], { BASE: '' })) as { code: string }).code, 'missing_base')
})

test('--base wins over BASE and is still guarded', () => {
  assert.equal(resolveBase(['--base', 'http://127.0.0.1:3111'], { BASE: 'https://jkissllc.com' }), 'http://127.0.0.1:3111')
  const viaFlag = resolveBase(['--base', 'https://jkissllc.com'], {})
  assert.equal((verdict(viaFlag) as { code: string }).code, 'production_host')
})

test('a trailing slash does not change the verdict', () => {
  assert.equal(resolveBase(['--base', 'http://127.0.0.1:3111/'], {}), 'http://127.0.0.1:3111')
  assert.equal((verdict('https://jkissllc.com/') as { code: string }).code, 'production_host')
})

test('running inside a Production runtime is refused outright', () => {
  const v = verdict('http://localhost:3111', { vercelEnv: 'production' })
  assert.equal(v.ok, false)
  assert.equal((v as { code: string }).code, 'vercel_env_production')
})

// ── Redirect protection ──────────────────────────────────────────────────────

test('an allowed origin that redirects to Production is rejected', () => {
  const v = classifyFinalUrl('https://www.jkissllc.com/', {}) as Verdict
  assert.equal(v.ok, false)
  assert.equal((v as { code: string }).code, 'redirect_to_production')
  assert.equal((v as { outcome: string }).outcome, 'BLOCKED_ENV')
  assert.equal((v as { host: string }).host, 'www.jkissllc.com')
})

test('a redirect to any other unapproved host is also rejected, with its own code', () => {
  const v = classifyFinalUrl('https://vercel.com/sso-api?url=x', {}) as Verdict
  assert.equal(v.ok, false)
  assert.equal((v as { code: string }).code, 'redirect_off_target')
})

test('a redirect that stays on the Preview deployment is fine', () => {
  assert.equal(classifyFinalUrl(`${PREVIEW}/admin/operations`, {}).ok, true)
})

// ── Refusal payload hygiene ──────────────────────────────────────────────────

test('a refusal names the rejected hostname and leaks nothing else', () => {
  const v = verdict('https://user:secret@jkissllc.com/admin?token=abc') as { host: string; reason: string }
  assert.equal(v.host, 'jkissllc.com')
  assert.match(v.reason, /jkissllc\.com/)
  assert.doesNotMatch(v.reason, /secret|token|abc/)
})

test('a malformed-URL refusal does not echo a path, query or embedded credential', () => {
  const v = verdict('http://user:hunter2@/admin?token=abc') as { reason: string }
  assert.doesNotMatch(v.reason, /hunter2|token=abc|\/admin/)
})

// ── The refusal is never a pass ──────────────────────────────────────────────

test('a rejected run reports BLOCKED_ENV and is excluded from PASS totals', () => {
  const v = verdict('https://jkissllc.com') as { outcome: string }
  const { counts, passed, blocked, fullyMeasured, exitCode } = summarizeRoutes([{ outcome: v.outcome }])
  assert.equal(counts.BLOCKED_ENV, 1)
  assert.equal(counts.PASS, 0)
  assert.equal(passed, 0)
  assert.equal(blocked, 1)
  assert.equal(fullyMeasured, false)
  assert.equal(exitCode, 2, 'could-not-measure exits 2, never 0')
})

// ── Helper-level assertions ──────────────────────────────────────────────────

test('isLoopbackHost accepts only real loopback', () => {
  for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '::1', 'LOCALHOST', '127.0.0.1:3111']) {
    assert.equal(isLoopbackHost(h), true, `${h} should be loopback`)
  }
  for (const h of ['0.0.0.0', '192.168.1.10', '10.0.0.1', 'localhost.evil.test', 'jkissllc.com']) {
    assert.equal(isLoopbackHost(h), false, `${h} should NOT be loopback`)
  }
})

test('isProductionHost is spelling-insensitive', () => {
  assert.equal(isProductionHost('JKISSLLC.COM.'), true)
  assert.equal(isProductionHost('jkissllc.com:443'), true)
  assert.equal(isProductionHost('jkissllc-abc123def-team.vercel.app'), false)
})

// ── The guard actually runs, and runs FIRST ──────────────────────────────────
//
// Unit-testing the policy proves the decision is right; it does not prove the audit
// consults it before doing something irreversible. These spawn the real script.
//
// The proof that nothing reached Production is structural: the refusal banner is
// printed by the pre-launch guard, which sits ahead of preflight()'s fetch and ahead
// of chromium.launch(). If either had run we would see this script's own
// "INFRASTRUCTURE ERROR" banner or a Playwright launch error instead. A deliberately
// bogus PW_EXE guarantees a launch would be loud rather than silent.
//
// Only synthetic local targets are used: a Production HOSTNAME is passed as a string
// (never contacted), and the redirect case is a loopback server we control.

const AUDIT = new URL('./mobile-overflow-audit.mjs', import.meta.url).pathname
const BOGUS_PW_EXE = '/nonexistent/chrome-headless-shell-should-never-launch'

function runAudit(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    // A deliberately minimal environment: the child must not inherit a BASE, an
    // ADMIN_PASSWORD or a bypass secret from whoever is running the suite.
    const child = spawn(process.execPath, [AUDIT], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        NODE_ENV: process.env.NODE_ENV ?? 'test',
        PW_EXE: BOGUS_PW_EXE,
        ...env,
      },
    })
    let out = ''
    child.stdout.on('data', (d: Buffer) => { out += d.toString() })
    child.stderr.on('data', (d: Buffer) => { out += d.toString() })
    child.on('close', (code: number | null) => resolve({ code, out }))
  })
}

test('a Production hostname stops the run before browser launch or authentication', { timeout: 30_000 }, async () => {
  const { code, out } = await runAudit({
    BASE: 'https://jkissllc.com',
    // Both of these would be Production interactions if the guard did not fire first.
    ADMIN_PASSWORD: 'not-a-real-credential',
    CLICK_TEXT: 'Activation Readiness',
  })
  assert.equal(code, 2, 'could-not-measure exits 2')
  assert.match(out, /TARGET REFUSED \(pre-launch\)/)
  assert.match(out, /BLOCKED_ENV \[production_host\]/)
  assert.match(out, /Rejected hostname: jkissllc\.com/)
  assert.match(out, /PASS 0\s+BLOCKED_ENV 1/)

  // Nothing downstream of the guard ran.
  assert.doesNotMatch(out, /INFRASTRUCTURE ERROR/, 'preflight() must not have made a request')
  assert.doesNotMatch(out, /chrome-headless-shell|browserType\.launch|Executable doesn't exist/i,
    'chromium.launch() must not have been reached')
  assert.doesNotMatch(out, /---- findings ----|---- per-route ----/, 'no route was audited')
  // The credential is never echoed, even in a refusal.
  assert.doesNotMatch(out, /not-a-real-credential/)
})

test('a loopback target passes the guard and proceeds toward browser launch', { timeout: 60_000 }, async () => {
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>ok</h1>') })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  try {
    const { code, out } = await runAudit({ BASE: `http://127.0.0.1:${port}` })
    assert.doesNotMatch(out, /TARGET REFUSED/, 'loopback must be allowed')
    // It got past the guard and past preflight, and died at the bogus launcher —
    // which is precisely the point the Production case must never reach.
    assert.match(out, /chrome-headless-shell|Executable doesn't exist|launch/i)
    assert.notEqual(code, 0)
  } finally { server.close() }
})

test('a Preview-shaped host passes the guard', { timeout: 30_000 }, async () => {
  // A synthetic Preview hostname for a deployment that does not exist. Whether it
  // resolves (vercel.app is a wildcard) decides only WHICH post-guard step it dies at:
  // preflight's own "INFRASTRUCTURE ERROR" banner, or the bogus launcher. Either one
  // proves the guard ALLOWED it, because the refusal banner is printed strictly
  // earlier than both. No real deployment is audited.
  const { code, out } = await runAudit({
    BASE: 'https://jkissllc-abc123xyz-synthetic-audit-test.vercel.app',
  })
  assert.doesNotMatch(out, /TARGET REFUSED/, 'a Preview deployment must be allowed')
  assert.ok(
    /INFRASTRUCTURE ERROR/.test(out) || /Executable doesn't exist|browserType\.launch/i.test(out),
    `expected a post-guard failure, got: ${out.slice(0, 300)}`,
  )
  assert.notEqual(code, 0)
})

test('an allowed loopback origin that redirects to Production is stopped immediately', { timeout: 30_000 }, async () => {
  const server = createServer((_req, res) => {
    res.writeHead(302, { location: 'https://www.jkissllc.com/' })
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  try {
    const { code, out } = await runAudit({ BASE: `http://127.0.0.1:${port}`, ADMIN_PASSWORD: 'not-a-real-credential' })
    assert.equal(code, 2)
    assert.match(out, /TARGET REFUSED \(post-redirect, pre-launch\)/)
    assert.match(out, /BLOCKED_ENV \[redirect_to_production\]/)
    assert.match(out, /Rejected hostname: www\.jkissllc\.com/)
    assert.doesNotMatch(out, /chrome-headless-shell|Executable doesn't exist/i,
      'the browser must not launch after a redirect to Production')
    assert.doesNotMatch(out, /---- per-route ----/, 'auditing must not continue after the redirect')
  } finally { server.close() }
})
