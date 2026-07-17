# 16 — Release Notes Structure

How releases are described so the read-only **Release Center** and any human reader see
the same, consistent story. The Release Center renders the *current* release snapshot;
this doc defines the shape and holds the running log.

## Where the data lives

- **Curated content** (release notes, features, known issues, rollback notes, migration
  summary, verification status): `app/lib/release/release-data.ts` — a static, versioned
  TypeScript module. Editing a release note is a normal code change (reviewed, no secrets).
- **Derived content** (build/commit/environment/deploy date): read at runtime from the
  non-secret Vercel build vars (doc 02) with graceful fallback when unavailable.
- **Flag states**: derived from `allFlags()` (doc 15).

The Release Center **displays** this; it never edits it. Writes to release history are
code changes, not UI actions.

## Release note schema

Each release entry should carry:

| Field | Meaning |
|-------|---------|
| `version` | Human version/label (e.g. `2026.07.0`). |
| `date` | Release date (or "unreleased/draft"). |
| `commit` | Commit SHA when known (short form shown). |
| `environment` | Where this note describes state (`production` / `preview`). |
| `summary` | One-line "what this release is". |
| `highlights[]` | Major features / changes shipped. |
| `flags[]` | Flags introduced or flipped by this release (+ new state). |
| `migrations` | Migration summary + reversibility (doc 07), or "none". |
| `knownIssues[]` | Known issues / limitations at ship time. |
| `rollback` | Rollback notes specific to this release (doc 06). |
| `verification` | Verification status: what was checked, by whom, result. |

## Writing style

- State what changed and its customer/technical impact — not the diff.
- Every risky release names its rollback path and its verification evidence.
- No secrets, no raw env values, no private customer data.

---

## Release log

### 2026.07 — Update Center foundation (docs + read-only Release Center)

- **Summary:** Operator documentation set + a read-only, admin-only Release Center. No
  operational workflow changed.
- **Highlights:**
  - `docs/operations/` — architecture overview, repo map, environment matrix, local/
    preview/production/rollback/migration checklists, incident + AI + comms + Book Now +
    crew runbooks, security checklist, parallel-session rules, feature-flag inventory,
    this release-notes structure.
  - Read-only **Release Center** at `/admin/operations/release` (admin-only): current
    build/commit/environment, feature-flag states, and this release snapshot, with
    graceful fallback when deployment metadata is unavailable.
- **Flags:** none introduced or flipped.
- **Migrations:** none.
- **Known issues / limitations:**
  - Deployment date/commit are shown only when the Vercel build vars are present;
    otherwise the panel shows "unavailable" (by design).
  - Release history is curated in code, not editable from the UI (intentional — the
    surface is read-only this sprint).
  - Naming overlap: the owner-only write-capable console (`/admin/operations/platform`)
    is also historically called "Update Center". This admin surface is the *Release
    Center* — read-only and complementary (doc 00).
- **Rollback:** pure code rollback; nothing persisted, no data to unwind (doc 06).
- **Verification:** typecheck, lint, unit tests (incl. new release-manifest tests),
  and production build. Authorization, empty-state, unavailable-metadata, flag-redaction,
  and mobile-layout paths exercised. See the sprint report.
