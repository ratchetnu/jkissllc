# 11 — UX & Design-System Assessment (Phase 10)

> Cited to `file:line` on `~/jkissllc@main`, 2026-07-12.

## 1. Verdict (FACT)

This is a **genuinely bespoke, product-minded system**, not a generic admin
template: custom OpsPilot branding, a custom OS token layer
(`--os-radius/--os-shadow/--os-spring`, `globals.css:468-472`), a role-adaptive
floating dock, a ⌘K command palette with AI, safe-area-aware mobile bottom bars,
and skeleton/empty/error states on the core pages. The problems are **internal
inconsistency**, not low quality.

## 2. Design tokens & type (FACT)

- Token block `globals.css:4-31` — dark chrome (`--bg:#0b0b0c`,
  `--card:#121214`) + a parallel **light content ramp** (`--surface`, `--ink*`)
  with a stated WCAG-AA intent (`:23`). Brand `--red:#E0002A` (`:15`).
- Second **OS token layer** `globals.css:468-472` (radius/shadow/spring ease).
- Fonts: Inter (body), Space Grotesk (display), JetBrains Mono
  (`layout.tsx:4,19-21`).
- **Gap:** no numeric spacing scale — spacing is ad-hoc inline pixels everywhere.
  Only the marketing type ramp uses `clamp()`.

## 3. The "design system" is a status+format module, not a component library (FACT)

`app/admin/operations/ui.tsx` (169 lines) exports **6 components**: `StatusChip`,
`ClaimChip`, `Stat`, `Avatar`, `MoneyInput`, `Toggle` — plus status maps and
formatters. There is **no `Button`, `Card`, `Modal`, `Drawer`, `Table`, `Input`,
`Select`, `Tabs`, or `Badge`.** So:

- "Card" = bare `.os-card` CSS class applied inline (`globals.css:478`).
- "Button" = CSS `.btn`/`.btn-ghost` OR `.cc-action` OR `osMiniBtn` style object
  OR one-off inline `<button style={{…}}>` — **four+ button implementations**.
- Fields = a copied `osField` **style object**, not a component;
  `OperationsShell.tsx:25-28` even redefines its own `iStyle` instead of importing it.
- The one modal/drawer primitive (`Sheet`) lives outside `ui.tsx` in the messages
  feature (`messages/commsShared.tsx:78`).

## 4. Information architecture (FACT)

- **OS shell** (`OperationsShell.tsx:14-23`): 8-tab dock — Home, Operations,
  Crew, Businesses, Equipment, Claims, Messages, Settings. **Role-adaptive**
  (managers lose Settings, `:49`) but only that one item is gated.
- **Nested-tab depth spike:** the "Messages" tab (74-line shell) hides a 5-tab
  sub-app (Inbox/Crew/Reminders/Dispatch/Analytics). Three separate AI entry
  points (AI page + ⌘K "Ask OpsPilot AI" + `ClaimGuardAssist`).
- **Crew portal** (`PortalShell.tsx:12-18`): 7 tabs — Home, Routes, Messages,
  Availability, Time Off, Pay, Profile. Same dual-dock pattern, **own** helper
  module (`portal/ui.ts`) that re-implements `money/fmtDay/status` deliberately
  decoupled from admin.
- **Customer surfaces:** `/booking/[token]` (Tailwind utilities), `/client/[token]`
  (inline styles, its own 3-value status map), `/quote` (**969-line single-file**
  wizard mixing 146 `className` + 125 `style={{`).

## 5. States & accessibility (FACT)

- **States:** `.skeleton` shimmer + per-page `Empty` + red `os-card` errors are
  present on OS pages, thin elsewhere. **No shared `Empty/Skeleton/Spinner/
  ErrorState`** — `Empty` is redefined per page. **Silent-catch fetches**
  (`CrewTasks.tsx:39`, `CommandPalette.tsx:61`) render failed loads as
  indistinguishable-from-empty — a real UX gap.
- **A11y:** 113 `aria-*` app-wide but only **4 in the crew portal**; `Toggle`/
  `Sheet` are proper (`role=switch`/`dialog aria-modal`); but **no focus-trap /
  return-focus** on modals, **14 raw `<img>`** with eslint disables vs 1
  `next/image`, and no `aria-live` on async login transitions.

## 6. Terminology instability (FACT — the highest-leverage UX fix)

Occurrence counts in `app/admin/operations`: route 429, crew 384, business 269,
staff 256, operation 166, client 83, contractor 43, customer 22.

- **Core noun has 4 names:** data model says **route**, nav says **Operations**,
  FAB says **New assignment**, palette says **Create a route** — one entity,
  four labels.
- **Worker noun has 4 names:** nav tab **Crew** points at **/employees**; code
  field is `assignedStaff*`; palette labels the role **Contractor**.
- **Account noun split:** internal orgs are **Businesses**, their portal is the
  **client** portal, public flows say **customer**.

## 7. Recommendations (RECOMMENDATION)

Ordered by leverage. None require a redesign — they consolidate what exists.

1. **Promote real primitives into `ui.tsx`** (or a `packages/ui`): `Button`
   (variant/size), `Card`, `Input/Field`, `Select`, `Modal`/`Drawer` (with
   focus-trap + return-focus), `Table`, `Tabs`, `Badge`, `Empty`, `Skeleton`,
   `ErrorState`. Migrate incrementally; delete the 4 button variants + copied
   style objects.
2. **One status/format source of truth** — collapse the three route-status
   vocabularies (`operations/ui.tsx`, `portal/ui.ts`, `client/[token]`) into one
   shared module with role-appropriate projections.
3. **Settle the noun taxonomy** (product decision, `18-...` D7): pick one term
   per concept — recommend **Job** (not route/operation/assignment), **Crew
   member** (not staff/employee/contractor in UI; keep contractor for
   tax/compensation), **Customer** (retail) vs **Client/Account** (B2B) — and
   rename labels/dirs to match.
4. **Kill silent catches** — add the shared `ErrorState` and surface fetch
   failures distinctly from empty.
5. **Global overflow guard** — add `overflow-wrap`/`min-width:0`/`max-width:100%`
   safety and device-test the dense pages (`businesses` 621, `employees` 682,
   `[token]` 563, `quote` 969); code-split the quote wizard.
6. **Crew-portal a11y parity** — bring ARIA/focus management up to the OS level;
   it's a primary daily surface.

## 8. Design-system direction (RECOMMENDATION — matches the "Apple-quality" brief)

- **Keep:** the dark-chrome/light-content hybrid, the OS token layer, the dock +
  ⌘K, restrained spring motion, `prefers-reduced-motion` respect.
- **Add discipline:** a numeric spacing scale; one type ramp; documented status
  language (green=on-track, amber=attention, red=blocked, grey=inactive — already
  the de-facto vocabulary in `ui.tsx:14-24`); AI recommendation cards with
  explicit confidence + explanation + approval affordance (feeds `07-...`);
  progressive disclosure on the dense pages (summary → drill-in), not flat walls.
- **Avoid** (per brief): glassmorphism overuse, oversized marketing typography
  inside operational screens, decorative animation. The marketing `.glass-card`
  should not bleed into operational surfaces.
- **Role-adaptive interface:** extend beyond hiding one Settings tab — each role
  (owner/manager/dispatcher/office/crew) sees a tailored Home and nav, driven by
  the RBAC matrix (once enforcement drift is closed) so UI and authorization
  agree.
