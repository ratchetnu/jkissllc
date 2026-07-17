# 04 — Preview Deployment Guide

Previews are how every change is verified before production. One Preview per branch.

## How a Preview is created

- **Git push** of a branch to the GitHub remote (`ratchetnu/jkissllc`) triggers a
  Vercel Preview build automatically.
- Or **`vercel`** (no `--prod`) from the CLI for an ad-hoc Preview.

This documentation sprint does **not** push or deploy; the steps below are the standard
procedure for whoever ships a feature branch.

## Pre-Preview checklist

- [ ] Branch is off the intended base (usually `origin/main`).
- [ ] `npx tsc --noEmit` passes.
- [ ] `npm run lint` passes.
- [ ] `npm test` passes (or the targeted suites relevant to the change).
- [ ] `npm run build` passes locally.
- [ ] No secret values added to tracked files.
- [ ] Feature-flag additions default **OFF** (doc 15).

## Preview environment notes

- Preview uses the **Preview** env var set. Flags that are OFF in production should be
  OFF (or intentionally ON only for the Preview) — confirm in the dashboard.
- Crons do **not** run on Previews the way they do in production; exercise cron logic by
  calling the route with the `CRON_SECRET` header, or via its unit tests.
- Preview URLs are unlisted but not secret — don't put customer PII test data there.

## Verifying a Preview

1. Open the Preview URL; sign in to `/admin/operations`.
2. Exercise the specific flow you changed end-to-end (not just the happy path).
3. For AI/comms/booking changes, follow the matching runbook's verification section
   (docs 09–11) and keep comms in a non-live send mode (doc 10).
4. Check the read-only **Release Center** (`/admin/operations/release`) reflects the
   Preview build/commit and expected flag states.
5. Record what you verified — it becomes the release note (doc 16) and the production
   checklist evidence (doc 05).

## Promotion

Promotion to production is a separate, deliberate step — see doc 05. A Preview being
green is necessary, not sufficient.
