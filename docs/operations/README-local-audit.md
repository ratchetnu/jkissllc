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
npm run audit:mobile -- --base http://127.0.0.1:3111
```

Exit codes: **0** clean · **1** real UI findings · **2** could not measure (app
unreachable). A connection failure is reported as `infrastructure_unavailable` and
is never counted as a UI finding.
