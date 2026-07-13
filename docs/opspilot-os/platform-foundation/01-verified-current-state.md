# 01 — Verified Current State

Full detail: [`../19-assessment-verification.md`](../19-assessment-verification.md).

The blueprint was re-inspected against live code before any change and found **not
materially inaccurate**. Confirmed: Redis-first (no SQL) + Blob; dual-path HMAC
auth; RBAC (`admin/manager/crew`, ~50 perms) with a session that carried no
tenant; the `redis.ts` `call()` isolation chokepoint + two bypass files; the
governed `runAiTask` AI layer (`writes:false`); coarse `'admin'` audit actor;
advisory CI; Stripe key shared with ClaimGuard; all four §1 defects already fixed.

Two corrections folded into the work:
1. `AsyncLocalStorage` cannot bridge `proxy.ts` → handlers (separate invocations /
   Edge); tenant identity therefore rides the signed token (`tid`) and the ALS
   context is established **per-handler**.
2. `middleware.ts` is `proxy.ts` (Next 16).

Precision notes: only `tok()` (not `rid`/`iid`) was a security-relevant token; no
`src/` dir (convention `app/lib/`); local `next build` fails on `next/font/google`
(env, pre-existing) so local gates are `tsc` + `npm test` + `eslint`.
