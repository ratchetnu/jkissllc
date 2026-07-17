# 12 — Crew Portal Runbook

The crew portal (`/portal`) is the workforce-facing surface: clock in/out, GPS, documents,
assignments. Crew authenticate as `role: 'crew'` and are scoped to their own `staffId`.

Reference audit: `docs/crew-portal-audit.md`.

## Access model

- Crew sign in at `/portal` (not the admin OS). The admin sign-in redirects a `crew`
  role to the portal.
- Sessions are the same HMAC-signed cookie (`app/api/admin/_lib/session.ts`); a crew
  token carries `staffId`, which scopes every read to that one person's data.
- `requireStaffSession` **rejects** crew (admin/manager only). Portal routes use the
  crew-appropriate guard and always constrain by `staffId` server-side.

## Symptom → action

| Symptom | Check |
|---------|-------|
| Crew can't sign in | Account exists + role `crew`? Password reset flow? Session secret set? |
| Crew sees someone else's data | **Sev 1.** A `staffId` scoping bug — pull the change immediately (doc 06) and file security follow-up (doc 13). |
| Clock-in / GPS not recording | Portal write path + permissions; check the API logs for that staff id. |
| Documents missing / won't open | Vercel Blob access + `DOC_ENCRYPTION_KEY`; documents are encrypted at rest. |
| Portal nav flashes / remounts | Known class of issue fixed in git history (shell in layout, cached session). If it recurs, check the portal layout/session caching. |

## Verifying a portal change

1. Sign in as a **crew** test account on Preview.
2. Confirm you can only see that staff member's assignments/documents/pay.
3. Attempt a cross-`staffId` read (e.g. tamper an id in a request) and confirm the
   server returns 403/empty — hiding in the UI is never the control.

> This sprint does not modify the crew portal.
