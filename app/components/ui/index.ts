// ── Operion design system — the single import surface ────────────────────────
// Everything a screen needs comes from here: `import { Button, Card, tokens } from
// '@/app/components/ui'`. Tokens live in globals.css (see tokens.ts) and the guide
// is docs/design-system/README.md.

// Design tokens (typed mirror of the CSS custom properties) + status mapping.
export { tokens, statusTokens, type StatusTone } from './tokens'
export { routeTone, claimTone, EXTERNAL_STATUS, type ExternalStatus } from './status'

// Actions / surfaces / status / feedback / forms.
export {
  Button, IconButton, Card, MetricCard, StatusBadge, Alert,
  EmptyState, Spinner, Skeleton, ErrorState, FormField, Select, TableShell,
  type Tone,
} from './primitives'

// Form controls.
export { Input, Textarea, SearchInput, CurrencyInput, Toggle, Segmented } from './forms'

// Layout + feedback scaffolding.
export { PageHeader, Toolbar, KpiRow, Progress, Avatar } from './scaffolding'

// Overlays + navigation.
export { Dialog, Drawer, Tabs } from './overlays'

// Deliberate-action framework (reusable high-consequence action UI — 3B.2A).
export { DeliberateActionDrawer, TypedConfirm, RiskBanner, EligibilityChecklist } from './deliberate-action'
export {
  matchesConfirmation, riskPresentation, canConfirmDeliberateAction, summarizeChecklist,
  checklistStateLabel, checklistStateGlyph, checklistStateColor,
  type RiskLevel, type ChecklistItem, type ChecklistState, type ChecklistSummary,
} from './deliberate-action-logic'

// AI surfaces.
export { AiExplanation, InsightCard, ApprovalCard } from './ai'
