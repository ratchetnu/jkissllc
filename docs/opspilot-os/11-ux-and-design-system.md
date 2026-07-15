# 11 — UX & Design-System Assessment (Phase 10) — Operion Platform

> Cited to `file:line` on `~/jkissllc@main`.
> _(Updated 2026-07-14: product branding is now **Operion** — the palette says
> "Ask **Operion** AI" (`CommandPalette.tsx:87`) and platform surfaces read Operion.
> User-facing "OpsPilot" text has been renamed; the **`OpsPilotMark` component**,
> the `app/components/opspilot/` folder, and the `/admin/opspilot` waitlist route are
> preserved verbatim as **legacy internal identifiers**.)_

## 1. Verdict (FACT)

This is a **genuinely bespoke, product-minded system**, not a generic admin
template: custom **Operion** branding (rendered by the preserved `OpsPilotMark`
component — legacy internal id), a custom OS token layer
(`--os-radius/--os-shadow/--os-spring`, `globals.css:505-509`), a role-adaptive
floating dock, a ⌘K command palette with AI, safe-area-aware mobile bottom bars,
and skeleton/empty/error states on the core pages. The problems are **internal
inconsistency**, not low quality.

## 2. Design tokens & type (FACT)

- Token block `globals.css:4-31` — dark chrome (`--bg:#0b0b0c`,
  `--card:#121214`) + a parallel **light content ramp** (`--surface`, `--ink*`)
  with a stated WCAG-AA intent (`:23`). Brand `--red:#E0002A` (`:15`).
- Second **OS token layer** `globals.css:505-509` (radius/shadow/spring ease).
- Fonts: Inter (body), Space Grotesk (display), JetBrains Mono
  (`layout.tsx:4,19-21`).
- **Gap:** no numeric spacing scale — spacing is ad-hoc inline pixels everywhere.
  Only the marketing type ramp uses `clamp()`.

## 3. The "design system" is a status+format module — but a real primitive library now exists alongside it (FACT)

_(Updated 2026-07-14: recommendation #1 below is **partially realized**. A dedicated
reference component library now lives at `app/components/ui/` —
`primitives.tsx` (`Button`, `IconButton`, `Card`, `MetricCard`, `StatusBadge`,
`Alert`, `EmptyState`, `Spinner`, `Skeleton`, `ErrorState`, `FormField`, `Select`,
`TableShell`) and `overlays.tsx` (`Dialog`, `Drawer`, `Tabs`). It is gated by
`DESIGN_SYSTEM_REFERENCE_ENABLED`, which is **still `false`** (`app/lib/platform/flags.ts:41`),
so it is **not yet the site-wide enforced system** — but it is already being adopted
incrementally: the redesigned Book Now dashboard imports `Drawer` and `EmptyState`
from it directly (see §4). The legacy `app/admin/operations/ui.tsx` module and the
four button variants below still coexist; consolidation onto `app/components/ui` is
in progress, not complete.)_

The legacy operations helper `app/admin/operations/ui.tsx` (169 lines) exports
**6 components**: `StatusChip`, `ClaimChip`, `Stat`, `Avatar`, `MoneyInput`,
`Toggle` — plus status maps and formatters. Historically there was **no `Button`,
`Card`, `Modal`, `Drawer`, `Table`, `Input`, `Select`, `Tabs`, or `Badge`** here (all
of those now exist in `app/components/ui`, above, but pages still reference the old
patterns). So across the un-migrated surfaces:

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
  points (AI page + ⌘K "Ask **Operion** AI", `CommandPalette.tsx:87` + `ClaimGuardAssist`).
- **Crew portal** (`PortalShell.tsx:12-18`): 7 tabs — Home, Routes, Messages,
  Availability, Time Off, Pay, Profile. Same dual-dock pattern, **own** helper
  module (`portal/ui.ts`) that re-implements `money/fmtDay/status` deliberately
  decoupled from admin.
- **Customer surfaces:** `/booking/[token]` (Tailwind utilities), `/client/[token]`
  (inline styles, its own 3-value status map), `/quote` (**969-line single-file**
  wizard mixing 146 `className` + 125 `style={{`).
- **Book Now admin dashboard — redesigned to the enterprise pattern (SHIPPED to
  prod).** _(Updated 2026-07-14.)_ `app/admin/operations/book-now/page.tsx` is now a
  full ops dashboard rather than a flat list: a **KPI row** (New, Awaiting AI, Quote
  Ready, Pending Payment, Booked Today, Pending Revenue), a **toolbar**
  (search / filter / sort / view toggle / refresh), **grouped-accordion filters**
  (Services / AI Status / Sales Pipeline, with counts), a **full-width request table**
  (Customer, Service, Location, Created, AI, Quote, Payment, Crew, Priority — sticky
  header, sort, bulk select), and a **slide-over request drawer** (customer, photos,
  AI analysis + confidence, quote + payment, notes, "Open full detail"). It is the
  first surface built on the new library — it imports `Drawer`
  (`app/components/ui/overlays.tsx:67`) and `EmptyState`
  (`app/components/ui/primitives.tsx:90`). The change is **UI-only**: every API,
  filter, and mutating action is preserved; the detail page + its 12 PATCH actions are
  unchanged. This is BUILT, not a proposal — and a concrete template for how the rest
  of the admin should consolidate onto `app/components/ui`.

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

1. **Promote real primitives into a shared library — PARTIALLY DONE.**
   _(Updated 2026-07-14: the library now exists at `app/components/ui`
   — `Button`, `IconButton`, `Card`, `MetricCard`, `StatusBadge`, `Alert`,
   `EmptyState`, `Spinner`, `Skeleton`, `ErrorState`, `FormField`, `Select`,
   `TableShell`, `Dialog`, `Drawer`, `Tabs`. It is flag-gated by
   `DESIGN_SYSTEM_REFERENCE_ENABLED` (**still off**) and adopted so far only by the
   Book Now dashboard.)_ Remaining work: turn on the reference flag once vetted,
   **migrate the other admin/portal/customer surfaces incrementally**, and delete the
   4 legacy button variants + copied `osField`/`iStyle` style objects. Confirm the
   `Drawer`/`Dialog` primitives implement focus-trap + return-focus before broad
   rollout (see §5 A11y).
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
