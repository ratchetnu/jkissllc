# Update Manifest — Field Reference (schemaVersion 1)

One JSON file per update in `registry/`. Only `id` + `title` are required; everything
else defaults via `normalizeManifest`. Full types in `manifest/schema.ts`.

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable id, `ABC-001` (`^[A-Z0-9]+-\d+$`). |
| `title` | string | Human title. |
| `description` | string | One-paragraph summary. |
| `product.upstream` / `.downstream` | ProductId | Must differ. |
| `source.upstreamRepo` / `.downstreamRepo` | string | `owner/repo`. |
| `source.sourceBranch` / `.sourceCommit` / `.sourcePR` | string/number | Upstream provenance. |
| `category` | enum | feature · fix · observability · performance · security · infrastructure · ui · docs · refactor · data-migration |
| `classification` | enum | direct-port · adaptation-required · already-present · partially-present · excluded · manual-review |
| `status` | enum | discovered · planned · approved · adapting · implemented · verified · preview-ready · merged · released · blocked · rejected |
| `dependencies` | string[] | Other manifest ids that must land first. |
| `surface.featureFlags` | string[] | Flags introduced — **must default OFF**. |
| `surface.environmentVariables` | string[] | Env vars read. |
| `surface.databaseMigrations` | string[] | Migration ids/files. |
| `surface.sharedComponents` / `.sharedUtilities` | string[] | Shared UI / libs touched. |
| `surface.routes` / `.apis` / `.ui` | string[] | Routes / endpoints / UI surfaces. |
| `surface.tests` | string[] | Covering test files. |
| `surface.sharedFiles` | string[] | Anything else that must move together (e.g. `package.json`). |
| `rollout.featureFlagsOffByDefault` | boolean | **Must be true** (validator errors otherwise). |
| `rollout.previewValidationRequired` | boolean | Phase 8 required? |
| `rollout.requiresMigration` / `.requiresEnvConfig` | boolean | Gate hints. |
| `rollbackSteps` | string[] | Ordered; planner supplies a default if empty. |
| `exclusions` | string[] | Parts deliberately NOT ported within this update. |
| `compatibilityNotes` | string[] | Adaptation guidance. |
| `riskLevel` | low · medium · high | Planner may escalate (migrations/auth/payment → high). |
| `verification` | VerificationRecord? | Stamped by Phase 7. |
| `approval` | ApprovalRecord? | Stamped by Phase 9. |
| `syncBranch` | string? | `sync/<product>/<id>` once cut. |
| `downstreamPR` | number? | The downstream PR. |
| `history` | ManifestHistoryEntry[] | Append-only status log. |

## Validation invariants (`validateManifest`)

- **error** if `id` malformed, `title` empty, unknown enum, upstream == downstream, or
  `rollout.featureFlagsOffByDefault !== true`.
- **warning** if behavioral surface (routes/apis/ui) with no flag; `requiresMigration`
  with no migrations listed; advanced status with no approver.

## Status machine

Forward-only transitions (+ `blocked`/`rejected` reachable from anywhere) via
`canTransition(from, to)`. Terminals: `released`, `rejected`.
