# 05 — Production Deployment Checklist

Use this before every production promotion. Print it, tick it, keep it with the release
note (doc 16). Production changes are outward-facing and hard to reverse — confirm, don't
assume.

## 0. Gate

- [ ] A green **Preview** exists for this exact commit (doc 04).
- [ ] The change has an owner who will watch it after promotion.
- [ ] Someone other than the author has read the diff for auth/tenancy/data exposure
      (doc 13) if it touches those areas.

## 1. Build & test evidence

- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run lint` — clean.
- [ ] `npm test` — green (note any intentionally-skipped suites and why).
- [ ] `npm run test:ai:regression` — green (AI-touching changes).
- [ ] `npm run build` — succeeds.
- [ ] `npm run predeploy` — succeeds (this is the canonical pre-ship gate).

## 2. Config & flags

- [ ] Any new env var exists in **Production** (names per doc 02) — verified in the
      dashboard, not by a redacted pull.
- [ ] New feature flags are **OFF** in production unless this release is explicitly the
      one that turns them on (doc 15).
- [ ] No secret value is present in tracked files or logs.

## 3. Data safety

- [ ] If the change alters a persisted record shape / key prefix, the migration-safety
      checklist (doc 07) is complete and reversible.
- [ ] Backward compatibility: old records still read; `recordVersion` handled.

## 4. Communications safety (if the change can send anything)

- [ ] Send mode reviewed (`COMMS_SEND_MODE`) — no accidental live blast (doc 10).
- [ ] Templates reviewed; no PII leakage; opt-out honored.

## 5. Promote

- [ ] Promote the verified build to production (Vercel promotion / Rolling Release as
      appropriate). Prefer a gradual rollout for risky changes.
- [ ] Capture the production **commit SHA** and deployment id.

## 6. Post-deploy verification (first 15 minutes)

- [ ] `/admin/operations/release` shows the new commit + `production` environment.
- [ ] Health check endpoint responds (with `HEALTH_CHECK_SECRET`).
- [ ] Smoke the changed flow on production once.
- [ ] Watch runtime logs / error rate; watch the relevant cron on its next tick
      (`ai-jobs` ~3m, `reminders` ~5m).
- [ ] No spike in alerts (`OWNER_ALERT_*`, Slack webhook).

## 7. Record

- [ ] Write/append the release note (doc 16): version, commit, date, what shipped,
      flags, migrations, known issues, rollback notes, verification status.
- [ ] If anything looks wrong → doc 06 (rollback) immediately; don't wait it out.

> **Not in scope for the Update Center foundation sprint.** This sprint added no button
> or automation that performs any of steps 5–7. Promotion stays a manual, human-approved
> action.
