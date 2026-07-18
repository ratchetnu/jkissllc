# Operion Design System

The single source of truth for the Operion interface. Every screen, edition
(Junk Removal, Moving, Estate Cleanouts, Freight, HVAC, Roofing, Restoration…),
and future feature builds on this. The goal: a new screen already feels like it
belongs.

- **Tokens** live in [`app/globals.css`](../../app/globals.css) `:root`.
- **Typed token mirror** for inline styles: [`app/components/ui/tokens.ts`](../../app/components/ui/tokens.ts).
- **Components** import from one barrel: `@/app/components/ui`.
- **Live reference:** `app/admin/operations/design-reference/` (gated by
  `DESIGN_SYSTEM_REFERENCE_ENABLED`, 404 in prod — never touches nav).

```tsx
import { Button, Card, StatusBadge, tokens as t } from '@/app/components/ui'
```

---

## Philosophy

Think Apple, not enterprise software. Calm, spacious, intentional, predictable,
elegant, fast, minimal. We **remove visual noise and increase consistency** — we
do not add features. Nothing should look like it was designed by a different team.

---

## Design tokens

One vocabulary. Reference the CSS var directly (`var(--space-4)`) or the typed
mirror (`t.space[4]`). Never hardcode a literal that a token already names.

| Group | Tokens | Notes |
|---|---|---|
| **Spacing** | `--space-0…20` (0,4,8,12,16,20,24,32,40,48,64,80px) | 4pt grid. Use for padding, gap, margin. |
| **Radius** | `--radius-xs/sm/md/lg/xl/2xl/pill` (6/10/14/18/22/28/999) | `sm` inputs·buttons, `lg` cards, `pill` badges. |
| **Shadow** | `--shadow-xs/sm/md/lg` | `sm` cards, `md` popovers, `lg` dialogs. |
| **Motion** | `--dur-1…5` (.12–.5s), `--ease-standard/emphasized/spring` | `standard` default, `spring` for toggles. |
| **Type** | `--text-2xs…4xl`, `--weight-regular/medium/bold/heavy`, `--leading-*` | See scale below. |
| **Sizing** | `--icon-sm/md/lg`, `--control-sm/md/lg` | `control-lg` = 44px min touch target. |
| **Color** | `--bg/card/surface/text/muted/line`, `--ink*` (light), `--red`, `--focus-ring` | Dark is the default surface. |
| **Status** | `--status-{neutral,info,good,warn,bad,accent}-{fg,bg}` | The one status palette. |

### Typography scale

| Token | px | Use |
|---|---|---|
| `--text-2xs` / `--text-xs` | 10.5 / 11.5 | Overline labels, badges |
| `--text-sm` | 13 | Secondary, captions, table cells |
| `--text-base` / `--text-md` | 15 / 16 | Body, inputs |
| `--text-lg` | 18 | Card titles |
| `--text-xl` / `--text-2xl` | 22 / 28 | Page titles, KPIs |
| `--text-3xl` / `--text-4xl` | 34 / 44 | Hero |

Headings use `--font-display`; numerals get `.tabular-nums`.

---

## Components

All from `@/app/components/ui`.

### Actions
- **`Button`** — `variant`: `primary` · `secondary` · `danger` · `quiet`; `size`: `sm` · `md` · `lg` (md/lg meet the 44px touch target). `primary` is the one filled brand action per view.
- **`IconButton`** — requires `label` (becomes `aria-label` + `title`).

### Surfaces
- **`Card`** — the standard container (`--card` bg, `--radius-lg`, `--shadow-sm`).
- **`MetricCard`** — label + value + hint, tinted by `tone`.
- **`TableShell`** — wraps `<table>`; always horizontally scrollable so it never widens the page.

### Status & feedback
- **`StatusBadge`** — `tone` is a semantic `StatusTone` (`neutral/info/good/warn/bad/accent`); legacy `green/amber/red/grey/blue` still map through.
- **`Alert`** — `role="alert"` for warn/bad, else `status`.
- **`EmptyState` · `ErrorState` · `Spinner` · `Skeleton` · `Progress`** — the shared "nothing / broken / loading / working" surfaces. `ErrorState` closes the silent-catch gap.

### Forms
- **`FormField`** (label + hint + error, wired ids) wrapping **`Input` · `Textarea` · `Select` · `SearchInput` · `CurrencyInput`**.
- **`Toggle`** (`role="switch"`), **`Segmented`** (`role="radiogroup"`).

### Layout
- **`PageHeader`** (title + subtitle + actions), **`Toolbar`**, **`KpiRow`** (auto-fit metric grid), **`Avatar`** (photo → initials-on-gradient).

### Overlays & nav
- **`Dialog` · `Drawer`** — real focus trap: focus in, trapped Tab, Escape closes, focus returns to opener; `role="dialog" aria-modal`. Render above app chrome at `--z-overlay`.
- **`Tabs`** — `role="tablist"` with roving arrow-key navigation.

### AI surfaces
- **`AiExplanation`** (always shows confidence + evidence), **`InsightCard`**, **`ApprovalCard`** (approve/reject). See `07-ai-operating-layer.md`.

---

## Status language

A small, calm vocabulary. Technical states collapse to five external words —
`EXTERNAL_STATUS` in [`status.ts`](../../app/components/ui/status.ts):

**Ready · Updating · Complete · Needs attention · Unavailable**

Operational statuses map to a semantic tone with one helper, so any screen renders
consistently:

```tsx
import { StatusBadge, routeTone } from '@/app/components/ui'
<StatusBadge tone={routeTone(route.status)}>{label}</StatusBadge>
```

`routeTone` / `claimTone` are the reconciliation layer over the legacy hardcoded
maps in `app/admin/operations/ui.tsx`. Avoid exposing raw technical wording outside
advanced diagnostics.

---

## Spacing & layout

- Compose spacing from `--space-*` only. Cards pad `--space-4`; sections gap `--space-6`–`--space-8`.
- Wrap page content in `.safe-x` (16px gutters + notch safe-area). Give truncating flex/grid children `.min0`.
- The page never scrolls horizontally (`overflow-x: clip` on `html,body`). Opt intentional scrollers back in locally.

## Motion

- Default transitions: `--dur-1`/`--dur-2` with `--ease-standard`. Toggles use `--ease-spring`. Reserve `--ease-emphasized` for hero/reveal.
- No decorative animation in operational UI.
- Everything respects `prefers-reduced-motion` (skeleton, spin, indeterminate, os-* all gate on it).

## Accessibility

- One visible focus ring everywhere: `--focus-ring` (2px, offset 2px).
- Touch targets ≥ 44px (`--control-lg`); `IconButton` requires a label.
- Overlays trap focus and restore it; `Tabs`/`Segmented` are keyboard-operable with correct ARIA roles.
- Status is never color-only — badges pair a dot + text.
- Contrast: `--ink-muted` and status fg tokens are chosen for AA on their surfaces.

---

## Adoption & migration

The tokens and primitives are the **foundation** — this sprint did not rewrite
existing screens. Migration is incremental and low-risk:

1. New screens: build from `@/app/components/ui` only.
2. Existing screens: when you touch one, replace hand-rolled buttons/badges/cards
   with primitives and swap literals for `t.*` tokens.
3. Keep `app/admin/operations/ui.tsx` (live) working; converge its status colors on
   the `--status-*` tokens as screens migrate.

### Don't
- Don't add a fourth namespaced CSS layer or a parallel component set — extend the tokens/barrel instead.
- Don't hardcode brand red, focus pink, radii, or durations — tokens exist for all of them.
- Don't build a separate docs site — this file is the guide.
