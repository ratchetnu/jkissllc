# 13 — Security Checklist

Run this when reviewing any change that touches auth, tenancy, data exposure, or
external input. Deep register: `docs/opspilot-os/10-security-risk-register.md`.

## Authentication & authorization

- [ ] Every admin API route calls a guard from `app/api/admin/_lib/session.ts`
      (`requireStaffSession` / `requireAdmin` / `requirePlatformOwner` /
      `requirePermission`) — **not** an inline role-string check.
- [ ] The guard matches the tier: owner-only data uses `requirePlatformOwner`;
      admin-only uses `requireAdmin`; crew endpoints scope by `staffId`.
- [ ] UI hiding (nav filtering) is treated as convenience only; the server gate is the
      real control.
- [ ] RBAC changes go through `app/lib/rbac.ts`, and `scripts/authorization-coverage.test.ts`
      still passes.

## Session integrity

- [ ] `ADMIN_SESSION_SECRET` is dedicated (never shares `ADMIN_PASSWORD`), ≥16 chars.
- [ ] Token payloads stay HMAC-signed; role/staffId can't be forged by editing the cookie.
- [ ] Idle (10m) + absolute (2h) session limits preserved.

## Data exposure

- [ ] No secret value is rendered, logged, or serialized into a response.
- [ ] No raw environment-variable value is exposed to the client — only resolved states
      (the Release Center follows this: booleans/labels, never values).
- [ ] Cross-tenant / cross-`staffId` reads are impossible from a crafted request, not
      just hidden in the UI.
- [ ] `platform:*` (global) vs tenant-scoped keys are used correctly (doc 07).

## External input & webhooks

- [ ] Inbound webhooks verify signatures (`STRIPE_WEBHOOK_SECRET`,
      `TWILIO_WEBHOOK_SECRET`, `EMAIL_WEBHOOK_SECRET`).
- [ ] Cron endpoints require `CRON_SECRET`; health endpoints require `HEALTH_CHECK_SECRET`.
- [ ] Public forms are bot-mitigated (BotID) where appropriate.
- [ ] User-supplied strings are length-capped and validated before persistence.

## Secrets hygiene

- [ ] No secret added to a tracked file (including docs, tests, fixtures).
- [ ] Secrets live only in Vercel env; `.env*` files are gitignored.
- [ ] Rotating a secret doesn't silently break sessions (that's why the session secret
      is separate from the password).

## Release-specific (this sprint)

- [ ] Release Center API is `requireAdmin`, **GET-only**, and returns no secret and no
      raw env value.
- [ ] Flag view exposes only flag name + resolved boolean + static description — never
      the underlying env string.
