# Environment Isolation Audit — Preview vs Production

Read-only audit. No bookings created, no operational data written, no code changed, no
Production change. Date 2026-07-21 · branch `feat/booking-job-assignment`.

## Verdict: **RESOLVED 2026-07-21 — storage isolation CONFIRMED**

> **Update.** §1 and §2 below were written when the store binding could not be read. The
> binding has since been resolved from Vercel env **metadata** (store IDs + targets, no
> secret values). Preview and Production are backed by **different physical stores** for
> both KV and Blob. See "Storage binding — resolved" at the end of this document.
> Residual risk is **LOW**. The §3 finding (no environment segment in the key space)
> still stands as a defense-in-depth gap, and R2 (Preview blob write token) is still open.

*Original verdict, retained for the record:* FAIL — the only thing separating Preview from
Production was a credential value that could not be verified, with zero defense in depth
behind it. Risk if shared: HIGH.

---

## 1. Separate KV/Redis stores — **UNVERIFIED**

| Evidence for separation | Weight |
|---|---|
| `KV_REST_API_URL`, `KV_URL`, `KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN`, `REDIS_URL` exist as **independent rows scoped to exactly one environment each** — Preview rows and Production rows are distinct entries | Strong |
| Contrast: genuinely shared vars declare both targets on one row (`GITHUB_APP_ID` → "Production, Preview") | Strong |
| An Upstash resource named **`OperionPreview`** is attached to the project alongside `jkissllc-analytics` | Moderate |

**Why this is still not proof:** two separate env rows can hold *identical values*. Confirming
requires reading the values. `vercel env pull` returns empty for these keys (redaction), and
reading decrypted values through the API was correctly blocked. The CLI exposes no
metadata (`--json` unsupported), so the store↔environment binding cannot be resolved here.

**Settles it:** compare the **Preview** vs **Production** value of `KV_REST_API_URL` in the
Vercel dashboard. Different host ⇒ different database.

## 2. Preview writes cannot reach Production — **UNVERIFIED**

Entirely dependent on §1. There is **no application-level guard**: no environment assertion,
no host check, no write-target validation. If the credentials point at the same Upstash
database, Preview writes land in Production data with nothing to stop them.

## 3. Timeclock / crew assignment / booking keys environment-isolated — **FAIL**

**Booking key space** (`app/lib/bookings.ts:472–522`):

```
bk:{token}              the booking record
bk:num:{bookingNumber}  number → token
bk:index                sorted set, score = updatedAt
bk:counter              booking-number sequence
bk:invcounter           invoice-number sequence
bk:inforeq:{token}      info-request mapping
```

**Crew assignment and timeclock have no keys of their own.** They are *fields on the booking
record* — `assignees[].confirmedAt`, `.clockInAt`, `.clockOutAt`, `.payCents`,
`completionPhotos`, `jobCompletedAt`. They therefore inherit the booking key exactly.

**The transform** (`app/lib/platform/tenancy/keys.ts`): `scopeKey()` returns either the key
**unchanged** (tenancy off) or `t:{tenantId}:{key}` (tenancy on). **No code path contains an
environment segment.**

**Both environments resolve to the same tenant.** `DEFAULT_TENANT_ID` is `jkiss`;
`resolveTenantFromHost` maps `jkissllc.com`, `www.jkissllc.com` **and** `jkissllc.vercel.app`
to it, and every resolver falls back to it while tenancy is off.

⇒ For the same booking token, Preview and Production generate **byte-identical key strings**
(`bk:{token}`, or `t:jkiss:bk:{token}`). Isolation at the key layer: **none**.

**Irreversible side effect worth noting:** creating a booking increments `bk:counter` and
writes `bk:num:{n}`. If the stores are shared, deleting the test booking afterwards does
**not** roll the number sequence back — Production's booking numbering is permanently advanced.

## 4. Everything responsible for separation

**Load-bearing (the entire guarantee):**

| Variable / resource | Role |
|---|---|
| `KV_REST_API_URL` (Preview) | Sole authority — the database endpoint |
| `KV_REST_API_TOKEN` (Preview) | Sole authority — the credential |
| `KV_URL`, `REDIS_URL` (Preview) | Same store via other protocols |
| `KV_REST_API_READ_ONLY_TOKEN` (Preview) | Read path |
| Upstash `OperionPreview` vs `jkissllc-analytics` | The underlying databases |
| `BLOB_STORE_ID` (Preview) vs `BLOB_READ_WRITE_TOKEN` (Production, Development) | Blob separation |

**Explicitly NOT load-bearing:** `TENANCY_ENABLED`, `TENANCY_DARK_LAUNCH` — see §5.
`VERCEL_ENV` is never consulted for storage routing.

## 5. TENANCY_ENABLED — **tenant isolation only, NOT environment isolation**

Confirmed from source. `scopeKey()` composes the prefix solely from `currentTenantId()`.
Since Preview and Production both resolve to tenant `jkiss`, turning tenancy **on** changes
keys from `bk:{token}` to `t:jkiss:bk:{token}` **in both environments simultaneously** — the
two remain identical. Tenancy passing is **not** evidence of environment safety, and enabling
it would not create any.

*(Secondary note: with tenancy on, `resolveTenantFromHost` returns `null` for an unrecognized
bare preview host, so host-resolved routes fail closed. Token- and session-resolved routes —
including the booking flow — still resolve normally, so this is not a safety mechanism.)*

---

## Two findings that change the plan

**A. Preview cannot send SMS or email — good.**
Preview has **no** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY_SID/SECRET`,
`TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_FROM`, `OWNER_SMS`, or `RESEND_API_KEY` — all present
in Production. A Preview deployment structurally cannot notify a real crew member or
customer, even if the data store were shared. This materially reduces blast radius.

**B. Preview has no `BLOB_READ_WRITE_TOKEN` — Step 6 will fail.**
It is scoped **Production, Development** only. The crew upload broker
(`app/api/portal/upload/route.ts`) calls `handleUpload`, which needs that token to mint a
client token. **Completion-photo upload cannot pass in Preview as currently configured.**
This is a validation blocker independent of isolation.

---

## Required before operational testing

| # | Change | Severity |
|---|---|---|
| **R1** | In the Vercel dashboard, confirm `KV_REST_API_URL` **and** `KV_REST_API_TOKEN` differ between Preview and Production. Identical ⇒ isolation does not exist; stop. | **Blocking** |
| **R2** | Add `BLOB_READ_WRITE_TOKEN` to **Preview**, bound to the Preview blob store, or Step 6 cannot be validated. | **Blocking** |
| **R3** | Confirm `COMMS_SEND_MODE` in Preview is set to a suppressed mode. | High |
| **R4** | Add defense in depth: an environment segment in the key space, or a boot-time assertion refusing to start a non-production deployment whose KV host matches Production's. Today a single mis-scoped variable silently merges the environments. | High (follow-up) |

R1 and R2 are both configuration changes in Vercel — no code change, no Production change.
I have made neither; both are yours to apply.

**Sprint 2 remains blocked. Operational testing remains blocked pending R1 and R2.**

---

# Storage binding — RESOLVED (2026-07-21)

Source: Vercel project env **metadata** (`contentHint.storeId` + `target`) cross-referenced
against the team store list. **No secret values were read or decrypted.**

## KV / Redis (Upstash)

| Environment | Store name | Store ID |
|---|---|---|
| **Preview** | `OperionPreview` | `store_su17aRaiDFYBUzPk` |
| **Production** | `jkissllc-analytics` | `store_CJ8ZvzWGxOT85Xw6` |

All five KV variables (`KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_URL`, `REDIS_URL`,
`KV_REST_API_READ_ONLY_TOKEN`) resolve to the store above for their own environment.
**Different physical databases ⇒ KV is ISOLATED.**

## Blob

| Environment | Store name | Store ID |
|---|---|---|
| **Preview** | `operion-preview-blob` | `store_Ulabe9q3GBD8ZYQh` |
| **Production + Development** | `jkiss-invoice-photos` | `store_WK8DoJzb2Q1lu5sv` |

**Different physical stores ⇒ Blob is ISOLATED.**

## Which variables the application actually reads

Only **`KV_REST_API_URL`** (28 refs) and **`KV_REST_API_TOKEN`** (27 refs) are read by code.
`KV_URL`, `REDIS_URL`, and `KV_REST_API_READ_ONLY_TOKEN` have **zero** references — inert
members of Upstash's standard variable set. Both live variables are correctly bound.

## Check results

| # | Check | Result |
|---|---|---|
| 1 | Preview KV store identified | **PASS** — `OperionPreview` |
| 2 | Production KV store identified | **PASS** — `jkissllc-analytics` |
| 3 | Preview/Production isolated | **PASS** — distinct stores, KV and Blob |
| 4 | Communications suppressed | **PASS** — code-enforced (`policy.ts` cannot return `live` outside production) + no Twilio/Resend credentials in Preview |
| 5 | Production resources reachable from Preview | **NONE via KV, Blob, SMS or email** |

## Open items (not isolation)

**O1 — Preview blob has no write token (blocks Step 6).** `operion-preview-blob` is bound to
Preview, but `BLOB_READ_WRITE_TOKEN` is scoped **Production + Development** only. The crew
upload broker needs it to mint client tokens. Fix: issue a read-write token for
`operion-preview-blob` and add it to **Preview scope only**. Production untouched.

**O2 — Two similarly named Upstash stores.** `OperionPreview` (`store_su17aRaiDFYBUzPk`,
bound) and `operion-preview` (`store_r5klRJETqrl44rRt`, **unbound**) both exist, alongside an
unbound `upstash-kv-rose-planet`. A future rebind could silently select the wrong one.
Recommend deleting or clearly renaming the unused stores.

**O3 — Production KV is named `jkissllc-analytics`.** It is the primary production datastore,
not an analytics sidecar. The name invites a destructive mistake. Rename recommended
(cosmetic; changes no binding).

**O4 — No environment segment in the key space** (see §3). Isolation rests entirely on
correct variable binding, with no runtime backstop. Recommend a boot-time assertion that a
non-production deployment refuses to start if its KV host matches Production's.
