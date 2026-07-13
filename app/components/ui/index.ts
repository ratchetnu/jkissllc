// ── Operational design system — barrel ───────────────────────────────────────
// The single import surface for the primitives. Promote usages here incrementally;
// see docs/opspilot-os/21-design-system-foundation.md.

export {
  Button, IconButton, Card, MetricCard, StatusBadge, Alert,
  EmptyState, Spinner, Skeleton, ErrorState, FormField, Select, TableShell,
  type Tone,
} from './primitives'
export { Dialog, Drawer, Tabs } from './overlays'
export { AiExplanation, InsightCard, ApprovalCard } from './ai'
