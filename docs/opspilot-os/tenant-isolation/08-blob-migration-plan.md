# 08b — Blob Migration Plan (Tenant-Safe Storage)

**Companion to:** `08-background-and-storage-isolation.md` (which deferred blob path
prefixing to "Stage-8 storage task"). This closes the *write-path* half of that gap
and specifies — but **does not execute** — the plan for migrating existing objects.

**Foundation:** `app/lib/platform/tenancy/blob-keys.ts` — `scopeBlobPath()`,
`sanitizeBlobSegment()`, `legacyBlobPath()`, `compareLegacyAndTenantBlobPath()`. The
Blob analogue of `keys.ts` for Redis.

---

## What shipped this sprint (Phase 3 — write path)

Every Vercel Blob `put(...)` call site now builds its physical path through
`scopeBlobPath(...)`, and sanitizes the interpolated filename with
`sanitizeBlobSegment(...)`:

| Write site | Legacy path (tenancy OFF, byte-identical) | Path when tenancy ON |
|---|---|---|
| `app/api/upload/route.ts` → `quotePhotoBlobPath` | `quote-photos/<uuid>.<ext>` | `tenants/<id>/quote-photos/<uuid>.<ext>` |
| `app/api/admin/upload/route.ts` → `adminPhotoBlobPath` | `admin-photos/<uuid>.<ext>` | `tenants/<id>/admin-photos/…` |
| `app/api/portal/uniform/route.ts` → `uniformPhotoBlobPath` | `uniform-photos/<staffId>/<uuid>.<ext>` | `tenants/<id>/uniform-photos/<staffId>/…` |
| `app/api/careers/upload/route.ts` → `driverDocBlobPath` | `driver-docs/<kind>/<uuid>.<ext>[.enc]` | `tenants/<id>/driver-docs/<kind>/…` |
| `app/lib/payment-proof.ts` → `proofBlobPath` | `payment-proofs/<token>/<uuid>.<ext>.enc` | `tenants/<id>/payment-proofs/<token>/…` |

**Invariants (asserted in `scripts/blob-tenant-paths.test.ts`):**
- **OFF ⇒ byte-identical.** `scopeBlobPath` returns the legacy string unchanged, so
  existing objects and every stored URL/pathname keep resolving — no migration is
  required to keep the app working with tenancy off (its current state).
- **ON ⇒ tenant-prefixed + fail-closed.** A write with no resolvable tenant context
  throws rather than silently landing in the shared namespace.
- **Filename sanitized.** A crafted `id`/`ext` collapses to a basename; `..` and
  path separators can never enter the key.
- **Cross-tenant denial.** A path built for tenant A never resolves under tenant B's
  prefix.

Because every route here already runs under `withTenantRoute` / a resolved
principal, `currentTenantId()` returns the reference tenant (`jkiss`) today, and the
flag is OFF — so **nothing changes in production now.**

---

## Legacy read/delete compatibility (Phase 4)

Reads and deletes operate on the **stored** value written at upload time — the
absolute `blob.url` (public objects) or the stored pathname (sealed docs / proofs) —
**not** a rebuilt path. So legacy (un-prefixed) objects stay fully readable and
deletable with **no migration**. These were intentionally left unchanged:

- `app/api/admin/careers/doc/route.ts` — `get(pathname)` where `pathname` is the
  stored record value. Its `SEALED_PATH` guard is un-prefixed today; it must gain an
  optional `tenants/<id>/` prefix **before** tenancy flips on (see Pre-flip TODOs).
- `app/api/admin/bookings/[id]/proof/route.ts` — reads the stored proof pathname.
  `PROOF_PATH_RE` (in `payment-proof.ts`, updated this sprint) now tolerates an
  optional tenant prefix while staying byte-identical for legacy paths. **However**
  the sibling ownership check `pathname.startsWith('payment-proofs/<token>/')` in
  that route still assumes the un-prefixed shape and must be widened before flip.

### `del` / `list` / `head` audit
Only one non-my-file site rebuilds a **path** rather than acting on a stored URL:

- `scripts/reseal-driver-docs.ts` — a **manual, one-time** migration tool.
  - `list({ prefix: 'driver-docs/' })` enumerates the un-prefixed namespace. Once
    tenancy is on, tenant-prefixed objects live at `tenants/<id>/driver-docs/…` and
    this prefix would miss them. It must iterate per-tenant prefixes at that point.
  - `del(blob.url)` / `del(oldUrl)` / `del(orphanUrl)` all delete by **URL**, and
    each URL is derived from an applicant record it already owns → no cross-tenant
    delete risk. Left as-is (out of scope; runs with tenancy off).

No `head(...)` call sites exist.

---

## Future bulk migration — NOT run this sprint

> **This bulk migration is NOT executed now.** New writes become tenant-safe
> automatically when `TENANCY_ENABLED` flips; existing objects remain readable via
> their stored URL/pathname. The steps below are the plan for the eventual cutover.

### 1. Inventory
`list({ prefix })` every known family (`quote-photos/`, `admin-photos/`,
`uniform-photos/`, `driver-docs/`, `payment-proofs/`). Record pathname, size,
content-type, and whether already tenant-scoped (`isTenantScopedBlobPath`). Skip
anything already under `tenants/`.

### 2. Ownership mapping
For single-tenant today, every legacy object maps to the reference tenant `jkiss`.
The mapping is authoritative from the **owning record**, never from the path:
- `payment-proofs/<token>/…` → booking `<token>` → its tenant.
- `driver-docs/…`, `uniform-photos/<staffId>/…` → applicant/staff record → tenant.
- `quote-photos/…`, `admin-photos/…` → referencing quote/ops record → tenant.
Objects with no owning record are **orphans** (handled in step 7, not silently
re-homed).

### 3. Copy, never move
For each object: fetch bytes → `put(scopeBlobPath(legacy, { enabled:true, tenantId }))`
with the **same** bytes/content-type (sealed docs stay sealed; re-encryption is out
of scope). The legacy object is left in place — the copy is additive.

### 4. Dual-read window
Deploy readers that try the tenant path first and **fall back to the legacy
URL/pathname** on miss. Because stored records still point at legacy values, this is
already the safe default; the tenant path is only preferred once verified. Optional
dark-launch shadow signal available via `compareLegacyAndTenantBlobPath` +
`recordTenantEvent('dark-launch-mismatch', …)` (see doc `06-dark-launch-strategy.md`).

### 5. Verification
For every copied object, read back the tenant-path object and assert byte-equality
with the legacy source (for sealed docs, assert it decrypts to identical plaintext —
mirrors `reseal-driver-docs.ts` round-trip discipline). Reconcile counts per family;
zero unexplained diffs before cutover.

### 6. Cutover
Flip `TENANCY_ENABLED` on. New writes are tenant-safe. Update stored record
references to the tenant paths **only after** verification (a record rewrite, not a
blob operation). Pre-flip TODOs (below) must already be merged.

### 7. Rollback
The migration is copy-only, so rollback is: flip the flag off (writes revert to
legacy paths, still byte-identical) and keep reading legacy values. No object is
deleted until step 8, so nothing is lost.

### 8. Legacy cleanup (last, gated)
Only after a full dual-read window with zero legacy fallbacks: delete the legacy
copies **by their stored URL**, one owning record at a time, ownership-verified —
never by a rebuilt prefix scan that could straddle tenants. Orphans handled exactly
like `reseal-driver-docs.ts --delete-orphans` (explicit, opt-in, dry-run first).

---

## Pre-flip TODOs (before `TENANCY_ENABLED` = on)
1. Widen `SEALED_PATH` in `app/api/admin/careers/doc/route.ts` to tolerate an
   optional `tenants/<id>/` prefix (keep the anti-`..` guard).
2. Widen the ownership check in `app/api/admin/bookings/[id]/proof/route.ts`
   (`startsWith('payment-proofs/<token>/')`) to accept the optional prefix; keep it
   token-scoped so a proof can never be read across bookings/tenants.
3. Update `reseal-driver-docs.ts` to enumerate per-tenant prefixes.

None of these block the current OFF state — all reads/writes are byte-identical to
pre-sprint behavior today.
