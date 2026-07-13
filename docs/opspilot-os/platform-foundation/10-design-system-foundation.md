# 10 — Design System Foundation

Full detail: [`../21-design-system-foundation.md`](../21-design-system-foundation.md).

**Files:** `app/components/ui/{primitives,overlays,ai,index}.tsx`, flagged
reference screen `app/admin/operations/design-reference/` · **Tests:**
`scripts/design-system.test.ts` · **Flag:** `DESIGN_SYSTEM_REFERENCE_ENABLED`
(off).

18 accessible primitives — Button, IconButton, Card, MetricCard, StatusBadge,
Alert, EmptyState, Spinner, Skeleton, ErrorState, FormField, Select, TableShell,
Dialog, Drawer, Tabs, ApprovalCard, InsightCard, AiExplanation — consuming the
existing CSS custom properties (no new global CSS, no marketing gloss). Dialog and
Drawer implement a real **focus trap** (focus-in, trapped Tab, Escape-to-close,
return-focus) — closing the modal-focus gap from `../11-ux-and-design-system.md`.
The single **reference screen** demonstrates them and 404s unless the flag is on,
so it disturbs no existing navigation. No existing component was replaced.
