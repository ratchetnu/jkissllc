# 21 — Design System Foundation

> Branch `opspilot/platform-foundation`, 2026-07-12.

## Context (from the assessment)
`11-ux-and-design-system.md` found the app is bespoke and product-minded but has
**no component library**: `app/admin/operations/ui.tsx` is a status+format module
(6 small components, no Button/Card/Modal/Input/Table), producing four button
variants, three status vocabularies, silent-catch-as-empty, and no modal focus
management. This sprint establishes a foundational operational design system —
**without** replacing any existing component.

## Inventory of existing reusable UI (confirmed)
- `app/admin/operations/ui.tsx` — `StatusChip`, `ClaimChip`, `Stat`, `Avatar`,
  `MoneyInput`, `Toggle` + formatters (kept; not touched).
- `app/admin/operations/messages/commsShared.tsx` — a `Sheet` (the one drawer).
- `app/portal/ui.ts` — a parallel format/status helper (kept).
- CSS: `.btn`/`.btn-ghost`, `.os-card`, `.glass-card`, `.skeleton`, OS token layer.

## What was built (`app/components/ui/`)
18 accessible, theme-aware primitives consuming the **existing** CSS custom
properties (no new global CSS, no gradients/glassmorphism):

- **Actions:** `Button` (primary/ghost/danger, sm/md), `IconButton` (requires an
  `aria-label`).
- **Surfaces:** `Card`, `MetricCard`, `TableShell` (always horizontally
  scrollable → never overflows the page — the global-overflow gap).
- **Status/feedback:** `StatusBadge` (one tone vocabulary: green/amber/red/grey/
  blue), `Alert` (`role=alert` for problems), `EmptyState`, `Spinner`, `Skeleton`,
  `ErrorState` (a shared error surface — closing the silent-catch gap).
- **Forms:** `FormField` (label + hint + error, wired ids), `Select` (native for
  built-in a11y).
- **Overlays:** `Dialog`, `Drawer` — real **focus trap** (focus-in, trapped Tab,
  Escape-to-close, **return focus** to the opener) + `role=dialog aria-modal`.
- **Navigation:** `Tabs` — `role=tablist/tab` with roving arrow-key navigation.
- **AI surfaces:** `AiExplanation` (always shows confidence + evidence),
  `InsightCard`, `ApprovalCard` (approve/reject affordance).

Barrel: `app/components/ui/index.ts`.

## Reference implementation
`app/admin/operations/design-reference/` renders a gallery of every primitive.
It is gated by `DESIGN_SYSTEM_REFERENCE_ENABLED` and returns **404** unless the
flag is on — so it never appears in production and disturbs no navigation. This
satisfies "convert exactly one low-risk internal screen" without risking a working
screen.

## Design direction (upheld)
Restrained, disciplined, theme-aware; consistent status language; clear hierarchy
and action states; accessible and keyboard-operable; no decorative animation. The
marketing `.glass-card` is deliberately not used in these operational primitives.

## Not done (deferred)
Migrating existing screens onto the primitives (incremental), promoting the three
status vocabularies to one shared source, settling the noun taxonomy, and DOM-based
a11y tests (need jsdom/Playwright). These are follow-ups, not foundation.
