# Isolated local audit environment

How to run this app locally **without touching Production**.

> **Read this first.** `.env.local` in a fresh clone of this working tree historically
> carried **Production** KV/Redis credentials and the Production `ADMIN_PASSWORD`.
> `next dev` loads `.env.local` by default, so "just run it locally and click around"
> was a Production-mutating action. Always verify with the safety check below before
> starting the app.

---

## 1. Why an emulator rather than a local Redis

`app/lib/redis.ts` speaks the **Upstash REST protocol** — it POSTs a JSON array of
command arguments and reads back `{ result }`. A stock `redis-server` speaks RESP and
cannot answer that, so it is not a drop-in substitute.

`scripts/local-audit/kv-emulator.mjs` implements that REST contract over an in-memory
store, bound to `127.0.0.1`. Two properties matter:

- **No remote host exists to misconfigure.** The base URL is loopback, so a local run
  cannot reach a real datastore even by accident.
- **No credential is involved.** The emulator accepts any bearer token, so the local
  env file never needs a real one.

Data lives in the process and is discarded on exit.

### Lua fidelity

The emulator recognises the app's Lua scripts by **shape** rather than interpreting
Lua. That is a fair trade for a handful of fixed scripts, but it has gone wrong four
times — a lock heartbeat executed as a delete (LOCK-1), the approval consume CAS
compared against the wrong field (APRV-1), the baseline-adoption multi-key CAS
falling into the generic version-CAS branch (it read the wrong key, compared the
wrong field against the wrong ARGV, and wrote one of the script's four keys), and
automatic release discovery shipping with **no branch at all**. The first three left a
runtime result meaningless while still printing PASS; the fourth made every local run
of the discovery endpoint die on `EMULATOR_UNSUPPORTED_SCRIPT`.

The modelled shapes are pinned by `scripts/kv-emulator-lua.test.ts`, including that an
**unrecognised script fails loudly** (`EMULATOR_UNSUPPORTED_SCRIPT`) rather than being
treated as executed. The discovery script is additionally asserted **byte-identical**
to the one `app/lib/platform/updates/store.ts` ships, so editing one without the other
fails there rather than in a local run. That drift check is per-script and deliberate:
there is no generic scanner proving every `.eval()` call site is modelled, and the
scope note at the end of that test file says so. If you add a Lua script to the app,
add its shape here and a test there — a script the emulator does not model must never
look like it ran.

## 2. Start

```bash
# 1. datastore (leave running in its own shell)
node scripts/local-audit/kv-emulator.mjs --port 6390

# 2. app
npx next dev -p 3111
```

`.env.local` must point at the emulator. Minimum contents:

```
KV_REST_API_URL=http://127.0.0.1:6390
KV_REST_API_TOKEN=local-audit-emulator-token-not-a-secret
REDIS_URL=redis://127.0.0.1:6390
ADMIN_PASSWORD=<synthetic, local-only>
ADMIN_SESSION_SECRET=<synthetic, 16+ chars>
CRON_SECRET=<synthetic>
COMMS_SEND_MODE=off
```

Deliberately **absent**: `STRIPE_SECRET_KEY`, `TWILIO_*`, `RESEND_API_KEY`,
`BLOB_READ_WRITE_TOKEN`, `VERCEL_TOKEN`, `GITHUB_APP_PRIVATE_KEY`. Their absence is
what makes the provider clients fail closed — do not add them.

## 3. Safety check — run before every session

```bash
# No production host in any VARIABLE VALUE (comments are ignored on purpose).
grep -vE '^\s*#|^\s*$' .env.local | grep -qE 'upstash\.io|smooth-vulture' \
  && echo 'STOP: production host in local env' || echo 'OK: no production host'

# Only loopback targets.
grep -ohE '://[a-zA-Z0-9._-]+' .env.local | grep -v '127.0.0.1' \
  && echo 'STOP: non-loopback target' || echo 'OK: loopback only'
```

Compare credential fingerprints against the production backup without printing values:

```bash
for v in KV_REST_API_URL KV_REST_API_TOKEN REDIS_URL ADMIN_PASSWORD; do
  a=$(grep -m1 "^$v=" .env.local            | cut -d= -f2- | shasum | cut -c1-12)
  b=$(grep -m1 "^$v=" .env.local.PRODUCTION-BACKUP-* | cut -d= -f2- | shasum | cut -c1-12)
  [ "$a" = "$b" ] && echo "STOP: $v matches production" || echo "OK: $v differs"
done
```

**Stop immediately if any check reports STOP.**

## 4. Reset / shutdown / cleanup

| Action | Command |
|---|---|
| Inspect what the app wrote | `curl -s localhost:6390/__admin/dump` |
| Reset data, keep running | `curl -sX POST localhost:6390/__admin/flush` |
| Full reset | restart the emulator (memory only) |
| Stop | `Ctrl-C`, or `kill $(cat .local-audit/kv.pid)` |
| Cleanup | `rm -rf .local-audit` (git-ignored) |

## 5. Restore Production credentials

Containment is a **move**, never a delete:

```bash
mv .env.local.PRODUCTION-BACKUP-20260726 .env.local
```

Do this only when you intend `next dev` to talk to Production again — which is
almost never.

## 6. Known local limitations

These are properties of the isolated environment, not app defects:

- **Photo upload cannot complete.** No `BLOB_READ_WRITE_TOKEN`, so `put()` fails
  closed. The wizard's photo branch is not locally exercisable.
- **No AI analysis.** No gateway credential — quote analysis cannot run, so the
  AI-dependent wizard paths stop at the analyze step.
- **No email/SMS/payments.** Providers are unconfigured by design; webhooks return
  503 with no signing secret.
- **Fonts reach the network.** `next/font/google` fetches Inter / Space Grotesk /
  JetBrains Mono from Google at compile time. It carries no credential or app data,
  and is the only egress from a local run.

## 7. Mobile audit against this environment

```bash
PW_EXE=<chrome-headless-shell path> \
ADMIN_PASSWORD=<the synthetic one> \
[AUDIT_IDENTITY=owner/admin] [SHOT_DIR=shots] [ONLY=/,/quote] \
npm run audit:mobile -- --base http://127.0.0.1:3111
```

### The target guard — where this audit is allowed to point

The audit refuses to launch a browser at anything it does not positively recognise.
Before authentication, before `chromium.launch()`, before route iteration, screenshots
or any `CLICK_TEXT`, the target is checked against an **allowlist**:

| Allowed | |
|---|---|
| loopback | `localhost`, the whole `127.0.0.0/8` block, `::1` |
| Vercel **Preview** deployments | `<project>-<hash>-<scope>.vercel.app` and `<project>-git-<branch>-<scope>.vercel.app` |
| an approved test host | exact match against `AUDIT_ALLOWED_HOST` |

Everything else is refused as `BLOCKED_ENV` with exit code 2 — never a pass, never a UI
finding. Known Production hostnames (`jkissllc.com`, `www.jkissllc.com`,
`jkissllc.vercel.app`, and the Supercharged domains, mirroring
`app/lib/platform/sandbox/guards.ts`) are named explicitly so the refusal says *why*,
but the allowlist is what actually stops an unrecognised host — including a lookalike,
an uppercase spelling, a trailing-dot FQDN, or an explicit port.

Two more properties worth knowing:

- **`jkissllc.vercel.app` is the Production alias**, not a Preview. It carries no
  deployment hash and no `-git-` segment, so it can never satisfy the Preview shape.
  A substring test like `hostname.includes('preview')` is deliberately *not* used —
  `preview.jkissllc.com` would pass it.
- **Redirects are re-checked.** An allowed origin that 30x's onto a Production host is
  a Production session; the run stops at that point and never continues auditing.
  `AUDIT_ALLOWED_HOST` cannot be used to re-admit a Production hostname.

`BASE` unset means "use the local default". `BASE` set but **blank** is refused rather
than silently resolving to localhost — a blank value means something upstream failed to
interpolate, and quietly auditing the wrong target is the class of untruth this tool
exists to prevent.

Why this exists: `preflight()` used to check only whether the host answered. Nothing
asked whether the host was *allowed*. `BASE=https://jkissllc.com` with a valid
`ADMIN_PASSWORD` authenticated against Production and navigated every configured route
as the owner. Pinned by `scripts/mobile-audit-target-guard.test.ts`.

### What a PASS means

A route passes only when the audit **proved the intended page rendered**: it is
authenticated where required, was not redirected, is not a sign-in screen, is not
blank, is not a stuck loading skeleton, satisfies the route's own readiness
assertion — and only then, that the layout holds. Every route in the table declares
its own `ready` selector; there is deliberately no universal title check, because a
single global assertion passes on the shell.

Outcomes, none of which can become a pass:

| Outcome | Meaning |
|---|---|
| `PASS` | content proven rendered, layout held — or a configured **expected denial** proven for a role that is supposed to be refused |
| `FAIL` | real finding — blank, sign-in on a public route, error boundary, stuck skeleton, readiness assertion unmet, page-level overflow, a hidden required action, an undeclared redirect, or a redirect loop |
| `ROUTE_ERROR` | HTTP ≥ 400 |
| `BLOCKED_AUTH` | the role the route requires could not be established — **not measured** |
| `BLOCKED_ENV` | app unreachable, or a refused target — **not measured** |
| `INCONCLUSIVE` | navigation/timeout — **not measured** |

Every result also carries a `state` recording *which* contract was proven:
`content` (the route's own page), `empty` (a valid explicit empty dataset), `denial`
(the authorization refusal a lower-privilege role is supposed to see), `data` (the data
contract failed) or `runtime` (the page threw, failed to hydrate, or logged an error).
A manager PASS on `/admin/operations/pay-statements` is a *denial* pass and is printed
as such — it never means the admin workflow was exercised.

### Data contracts — chrome is not evidence

A page can render a correct heading at a correct URL with a perfect layout and be
completely empty. Six route×role combinations did exactly that and passed, because
their required request returned 403 and nothing was looking.

A route may declare:

```js
data: { required: ['/api/admin/ai-overview'], loadedText: '…', emptyText: '…' }
```

- a **4xx/5xx on a declared required endpoint**, or never calling it at all,
  disqualifies a pass
- an **empty dataset stays valid**: name both `loadedText` and `emptyText` and either
  one satisfies the contract, so a correct page with no records is not failed for
  having none
- an **expected denial is exempt** — being refused *is* that role's contract

### Runtime signals

Console errors, uncaught page errors, unhandled rejections, crashes and hydration
mismatches are captured per route × viewport, and each one disqualifies a pass however
well the layout measured. Listeners attach **before** navigation — the errors thrown
during the render under test are exactly the ones a late listener misses — and detach
after, so signals never bleed between routes.

Hydration is classified separately from slow data: an unresolved skeleton keeps its own
reason and is never reported as a hydration failure.

Two deliberate limits on what can fail a route:

- The console **noise allowlist** is tiny and every entry carries a reason, because
  anything matched there can never fail a route again. An unknown console error is a
  finding, not noise.
- Chrome's generic `Failed to load resource…` line names no URL, so the console cannot
  tell whether the endpoint mattered. Those echoes are reported but judged by the
  **network contract**, which is the only layer that knows which endpoints are required.
  Counting them twice turned a shared rate limiter — tripped by running four identities
  in parallel against one Preview — into 88 false failures on static public pages.

Everything captured is **redacted on the way in**, never at print time: console text
comes from the page and is written to a report, so a value that reaches the results
array has already escaped.

> Run identities **serially** against a single Preview. Four concurrent browsers is
> enough to trip shared rate limits and produce 429s that are the harness's doing, not
> the app's.

### Roles, not a boolean

Each route declares the **role** it needs (`none` / `crew` / `admin`), because "is a
login required" cannot express the difference between `/portal` wanting a crew member
and `/admin/*` wanting staff. A manager counts for admin surfaces — a manager
legitimately browses them and simply sees less.

Identity comes from the server's own login response and is confirmed with a probe that
the role may actually read (`/api/portal/me` for crew, `/api/admin/platform/whoami` for
staff). It is never inferred from page content, and `AUDIT_IDENTITY` cannot override it.
A single admin-only endpoint used to be the universal proof of authentication, so a
valid crew session — which correctly gets 403 there — was recorded as `anonymous` while
the browser went on rendering authenticated crew pages. Authentication and authorization
are different questions.

### Redirects

A redirect is evidence about routing, never about authentication:

- with a session, an **undeclared** redirect is a `FAIL` — it must never silently pass
- a route may declare `canonicalRedirect`, and is then judged on the destination
- **without** a session, a redirect on a gated route stays `BLOCKED_AUTH` (an auth
  bounce and a real redirect are indistinguishable)
- an authenticated bounce to the sign-in screen is a `FAIL`: the app rejected a
  principal it had just accepted
- a redirect **loop** is a `FAIL`, not an environment problem — the server answered
- a redirect to Production is stopped by the target guard before launch (§ above)

Routes that only redirect are not listed at all. `/opspilot` (→ `/operion`) and
`/admin/operations/ai/shadow` (→ `/ai/performance`) can never satisfy a rendered-content
assertion and their destinations are already audited, so listing them added no coverage
and 54 false results.

Exit codes: **0** every check measured and passed · **1** real findings · **2**
something was not measured. Blocked outranks findings, so an unmeasured run can
never look clean. Without `ADMIN_PASSWORD` every `/admin/*` route reports
`BLOCKED_AUTH` and the run exits 2 — it used to measure the sign-in screen at every
viewport and report ~180 passes.

### Where to run it

**Admin routes cannot be validated against `next dev` in headless Chromium.** The
server answers 200 and the APIs work, but the admin client shell does not hydrate
under the dev bundle — the page stays on its loading bar, so the audit reports
`FAIL blank/near-empty body` with a screenshot. That is the tool being honest about
an environment limit, not a UI defect: the same routes render correctly in a
production build. Run admin coverage against a **production build or a Preview
deployment**; use the local dev server for public routes.
