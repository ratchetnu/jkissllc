<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- Everything below is hand-maintained. The block above is generated — don't edit inside it. -->

# Commands

```
npm test          # npx tsx --test scripts/*.test.ts
npm run build     # next build
npx eslint .      # exits 0; 3 pre-existing warnings are the baseline
npx tsc --noEmit
```

`npm test` runs each file in its own process with **no timeout**. A run that prints
nothing and never returns is not a slow suite — it is one file stuck on a promise that
never settles. Bisect by running files individually. A healthy full run is ~3,480
passing in ~16s.

# Booking idempotency — read this before changing it

Three merged PRs (#176, #179, #180) converged on the design in
`app/lib/booking-idempotency.ts`. The comments there carry the reasoning; this is the
short version so it doesn't get "simplified" back into a bug.

```
(absent) ──SET NX──▶ claimed:{bookingToken} ──CAS──▶ committed:{bookingToken}
                            │
                            └──CAS (only while provably uncommitted)──▶ claimed:{other}
```

- **`bk:idem:{key}`** is the claim; **`bk:idem:lock:{key}`** is a renewable lease.
- The claim is taken **before** `saveBooking`. Winning `SET NX` is what grants the right
  to persist — that is the uniqueness guarantee, and it does not depend on any clock.
- The lease is an **optimization only**: it avoids concurrent work, gives the fast 409,
  and self-heals after a crash. Correctness must never rest on it again.
- `committed` is **terminal**. Every CAS/compare-and-delete in the file expects a
  `claimed:` value; none expects `committed:`. Keep it that way — that property is what
  makes a real booking un-stealable, and it is verified by exhausting the write set.
- Proof that a claim did not commit is **the booking record's absence**, never elapsed
  time.

Things that look like improvements and are not:

- **Adding `assertHeld()` before the write.** Evaluated and rejected in #179. It is not a
  proof (the lease can lapse between the check and the write), and `heldNow()` returns
  false for a store blip as well as real loss — so failing closed trades a rare duplicate
  for a common lost sale.
- **Raising or lowering a TTL to fix a race.** The 30s lease is a crash-recovery window,
  not a runtime bound; raising it lengthens how long a crashed request poisons a key. The
  24h claim TTL is the retry window; shortening it reopens a duplicate path.
- **Fixing one intake path.** `POST /api/book` and `persistQuoteRequest()` share
  `commitIdempotently()`. Both, or neither.

# Photo AI eligibility

`needsAiJob()` / `supportsPhotoAi()` in `app/lib/book-now-ai.ts` are the single predicate
— junk family always, moving behind `AI_PHOTO_ESTIMATE_MOVING`, `other` never. Intake
routes must not re-implement it. The flag is registered `false` and is unset in both
Production and Preview, so moving bookings are not analyzed today.

`enqueueAiJob()` only mutates `booking.aiJob`; the caller persists. `runDueAiJobs` selects
on `isDue()`, which is false when a booking has no `aiJob` at all — so a booking that was
never enqueued is invisible to the worker forever, not merely late.

**Cost note:** `/api/cron/ai-jobs` runs `*/15` in Production and makes real vision calls.
Never point it at test data, and never enqueue a job you don't intend to pay for.

# Tenancy

Every Redis access goes through the chokepoint in `app/lib/redis.ts`, which scopes keys
via `app/lib/platform/tenancy/keys.ts`. Never hand-build a `t:{tenant}:` prefix. `bk:*` is
tenant-scoped; the platform-global allowlist (`rl:`, `ai:`, `health:`, …) is not.

# Deploying

**A green merge to `main` can silently produce no Production deployment.** It has happened
more than once, with CI and Vercel PR checks green and nothing queued. Always verify the
live build, never "a Ready production deployment exists":

```
curl -s https://www.jkissllc.com/api/health     # → {"build":"dpl_…"}
```

If the merge did not deploy, rebuild a known-good artifact server-side:

```
vercel redeploy <preview-url> --target production
```

Confirm first that the artifact matches merged main by comparing **tree** hashes
(`git rev-parse <branch>^{tree}` vs `<merge>^{tree}`) — a redeploy keeps the *branch*
commit SHA in its metadata, so the SHA field alone will look wrong even when the source is
byte-identical.

Prefer that over `vercel --prod` from a working tree: a CLI deploy ships whatever is
checked out, including uncommitted local edits. (`.vercelignore` already keeps `.claude/`
out of the upload.)

Normal, not defects: `jkissllc.com` 308-redirects to `www`, and a raw `*.vercel.app`
deployment URL 302s on deployment protection.

# Testing conventions that have bitten

- **Anything with a heartbeat needs the runtime's timers and the store's clock advanced in
  lock-step.** A virtual clock alone starves the `setInterval` under test, and the test
  then passes for the wrong reason. See `scripts/book-idempotency-*.test.ts`.
- **Route-level tests can hide helper branches.** A route that short-circuits early never
  reaches the helper's later branches, so those go untested while coverage looks fine.
  Drive the helper directly as well.
- **Mutation-check any test guarding a race.** Break the mechanism on purpose and confirm
  the test fails. Two real coverage gaps in this repo were found exactly that way.
