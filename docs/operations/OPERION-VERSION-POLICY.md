# Operion — Semantic Version Policy

**Status:** Increment 1 of the versioning program. The policy module exists and is fully
tested; it is **pure and has no callers** — no Production write path consumes it yet.

---

## 1. Four different identifiers — do not conflate them

This is the distinction the rest of the policy depends on.

| Identifier | What it is | Example | Who assigns it |
|---|---|---|---|
| **UPD ID** | An immutable *engineering change* identifier | `UPD-1004` | Author, at registration |
| **Source commit** | Provenance of the change in the SOURCE repo | `e42af39` | Git |
| **Release version** | An immutable *installable bundle*'s semantic version | `0.2.0` | Release packaging |
| **Installed version** | What a target product is actually *running* | `0.1.0` | Verified finalization, or approved baseline adoption |

**A source commit is provenance, never an installed version.** A product can have an
advancing `currentCommit` while `currentVersion` stays absent — that is exactly the state
every Production product is in today, and it is correct, not a bug.

---

## 2. Semantic version format

`MAJOR.MINOR.PATCH`, optionally `-prerelease` and `+build` (SemVer 2.0).

**Rejected — never coerced:** empty and whitespace-only strings, partial versions (`1`,
`1.2`), leading zeros (`01.0.0`, `1.02.0`, prerelease `-01`), malformed prerelease (`1.0.0-`),
and anything outside the permitted alphabet.

Surrounding whitespace on an otherwise-valid version is trimmed and normalized; a leading
`v` is stripped (`v1.2.3` → `1.2.3`). Build metadata is preserved for display but **ignored
for precedence**.

### Two parsers, on purpose

`updates/policy.ts` keeps its **lenient** `parseVersion`/`compareVersions` — they accept
`v1` and `1.2`, and they ignore prerelease when ordering. Historical records depend on that
leniency, so tightening them in place would reclassify existing data.

`release/semver-policy.ts` is the **strict** layer, used when a version is being *authored*.
Reading old data stays lenient; writing a new version is strict. The strict comparator is
prerelease-aware; the legacy one is not.

### Prerelease channels

Prerelease identifiers are accepted only on `internal`, `alpha`, and `beta`. They are
**rejected on `stable` and `lts`** — those are the channels a product actually runs on, and
a prerelease has no business becoming an installed baseline there.

---

## 3. Bump rules

| Bump | Required for |
|---|---|
| **PATCH** | backward-compatible fixes, UI polish, tests, observability, documentation |
| **MINOR** | backward-compatible capabilities, new workflows, grouped feature releases |
| **MAJOR** | breaking API or data changes, incompatible migrations, intentionally incompatible releases |

Enforced consequences:

- A **PATCH may not** declare a breaking change or an incompatible migration.
- A **capability or workflow may not** ship as a PATCH.
- The proposal must be **strictly greater** than the previous version.
- Over-bumping is allowed (a fix may ship as MINOR or MAJOR); under-bumping is not.

A *compatible* migration does not force MAJOR — only an **incompatible** one does.

---

## 4. Why an unknown baseline blocks version assignment

When the previous version is unknown, the policy returns **`baseline_required`** — it does
**not** approve an inferred first version.

A product whose installed baseline has never been established has no "next" version to
derive. Assigning one would be fabricating history, and it would immediately make the
Release Center claim a product is behind a version it was never proven to have.

**This is the current Production state:** every Production product has an unknown installed
baseline. So **baseline adoption must precede versioned Production packaging** — that is
Increment 2, and it is a hard prerequisite, not a preference.

---

## 5. Duplicate versions

A version may repeat freely across **different products** or **different channels** — the
same release genuinely lands on many targets. It may **not** repeat within one
product + channel while an existing release is still active. Superseded and cancelled
releases do not block reuse.

---

## 6. Legacy records

Records predating this policy carry **no `releaseVersion`**, and that stays valid:

- They remain readable and are never rewritten.
- They display as **"Version unspecified"** — **never `0.0.0`**.
- An absent version is not a value: it cannot collide, and it has no ordering relationship
  with anything.
- Existing code paths continue to work when `releaseVersion` is absent.
- An unparseable legacy value is shown as-is rather than erased.

Installed-baseline *display* is governed separately by `deriveVersionState()` (see the
Release Center version-accuracy work): absent installed version ⇒ **Version unknown**, never
"update available".

---

## 7. Reason codes

The policy returns explicit reason codes rather than booleans:

`valid` · `invalid_format` · `not_greater_than_previous` · `duplicate_version` ·
`breaking_change_requires_major` · `incompatible_migration_requires_major` ·
`capability_requires_minor` · `baseline_required` · `prerelease_not_supported`

---

## 8. Future integration points — documented, deliberately not wired

Increment 1 adds **no** write path. When later increments land:

1. **`deriveBusinessProvenance()`** (`automation/finalize.ts`) is the narrowest existing
   boundary where a `releaseVersion` becomes an *installed* version. It should call
   `parseSemanticVersion()` and refuse an unparseable one, rather than accepting any string
   as it does today.
2. **Release-package creation** (Increment 3) should call `evaluateVersionBump()` and
   `findDuplicateVersion()` before a draft may be marked Ready.
3. **Baseline adoption** (Increment 2) supplies the `previousVersion` that
   `baseline_required` currently demands.

---

## 9. Standing constraints

- **Operion Sandbox `0.1.0` is NOT a Production platform baseline.** Sandbox is a
  disposable TEST-ONLY product and it exists only in Preview. It must not be used as the
  starting baseline for any Production product.
- **The earlier draft release map (0.1.0 → 0.3.0) is not authoritative** and has not been
  written to any record. It contains at least one ordering contradiction (provider-readiness
  work merged *between* the items placed above and below it), mixes code with a
  configuration-only change, and omits merged PRs. It must be re-derived from real
  provenance after baselines are adopted.
- **No version is ever fabricated or backfilled** without either a verified successful
  finalization carrying a `releaseVersion`, or an explicitly approved baseline adoption.
