# Operion Documentation System

The shared foundation behind every Operion guide — so the whole library reads as
one premium product, and future guides drop in without redesign.

Generated 2026‑07‑20 · Edition 2026.07

---

## 1 · The documentation ecosystem

Operion serves three audiences (new hire, administrator, owner) plus the crew.
Each guide answers a different question, so nobody wades through what they don’t
need.

| Guide | Audience | Answers | Status |
|---|---|---|---|
| **Quick Start Guide** | First-day administrator | “How do I run today?” | ✅ Built |
| **Administrator Guide** | Every admin / manager | “How does *everything* work?” (complete reference) | ✅ Built |
| **Owner Guide** | Business owner / executive | “How is the business doing, and what do I control?” | ✅ Built |
| **Crew Guide** | Crew / contractors | “How do I use the portal — jobs, clock, pay?” | ◻ Planned |
| **Daily Operations Handbook** | Ops leads | “What’s the repeatable daily/weekly rhythm?” | ◻ Planned |
| **AI Command Center Guide** | Owner / power admin | “How do I read and tune AI quoting?” (deep dive) | ◻ Planned |
| **Release Center Runbook** | Owner | “Publish / roll back, step by exact step.” | ◻ Planned |
| **Troubleshooting Manual** | Support / admins | “Something’s off — what now?” | ◻ Planned |
| **Platform Overview** | New stakeholders | “What is Operion, in one read?” | ◻ Planned |

**Why this set:** a new admin needs a *fast on-ramp* (Quick Start), then a *place to
look things up* (Administrator). Owners need a *different lens* — money, AI, releases —
not operational detail. Crew get their *own* simplified guide. The four planned
deep-dives (Crew, AI, Release, Troubleshooting) exist because those areas are either
role-specific or high-stakes enough to deserve a focused, standalone document.

---

## 2 · Design language (style guide)

Everything lives in **`admin-manual-assets/operion-docs.css`** — link it and any new
page inherits the system.

**Color**
| Token | Value | Use |
|---|---|---|
| Accent | `#E11D2E` | Brand red — kickers, headings, key numbers |
| Ink | `#0A0A0F` | Primary text, cover, step badges |
| Muted | `#697082` | Secondary text, captions |
| Surface | `#F6F7FA` | Cards, zebra rows, chips |
| Success / Warn | `#12A36B` / `#E11D2E` | Profit, cautions |

**Typography** — a single system stack (SF Pro / Inter). Display headings are large
and tight (`-0.02em`); body is 15px at 1.55 line-height. Kickers are 11px uppercase
with wide tracking. No more than three type sizes on a page.

**Layout** — generous whitespace, A4 sheets with 22mm/20mm margins, one idea per
band. Every page ends with a running footer (guide · section).

**Core components**
- **Cover** — dark hero with a brand glow, eyebrow, oversized title, pill badges.
- **Section divider** — a giant ghost number + kicker + title.
- **Browser-framed screenshot** — traffic-light chrome + URL, soft shadow, optional numbered **annotations** and a matching legend.
- **Workflow card** — Goal · Time · You’ll need, then numbered steps.
- **Callouts** — Tip (green), Warning (red), Note (blue), each with an icon.
- **Metric tiles, decision paths, checklists, `kbd` keys, premium tables.**

**Voice** — Apple-plain. Confident, minimal, second person. Teach the action, never
the implementation. Never name a file, API, flag, or technology.

---

## 3 · Screenshot library

16 real, captured screens live in **`admin-manual-assets/screenshots/`**:

`01-sign-in` · `02-dashboard` · `03-operations` · `04-book-now` · `05-schedule` ·
`06-settings` · `07-new-assignment` · `08-more-menu` · `09-finance` · `10-analytics` ·
`11-claims` · `12-crew` · `13-ai-command` · `14-release-center` · `15-pay-statements` ·
`16-bookings`

**Treatment:** each screenshot is placed in a browser frame with a caption, and the
important ones carry numbered annotation badges + a legend. **PII policy:** screens
with real customer/crew data (`03`, `06`, `12`, `15`) are captioned *“Sample data
shown / redacted”* and should be re-captured with the **Test-data** view — or blurred —
before the guide is shared externally.

**Icon vocabulary:** a small, consistent glyph set (`✦ ◱ ◑ ◆ ◷ ↗ ✳︎ ⌘ 🔒`) used for
cards and callouts. A future SVG icon set can replace these 1:1 without touching layout.

---

## 4 · Workflow illustrations

Two illustration styles, chosen for print clarity:
- **Workflow cards** (Goal / Time / Steps) — for “how do I…” tasks.
- **Decision paths** (`→` lists) — for branching logic (e.g., how the AI routes a quote).

Documented workflows across the set: Sign in · Navigate · Read the dashboard ·
Dispatch a crew · Review AI quotes · Manage bookings · Schedule & resolve conflicts ·
Run pay & statements · Handle claims · Publish · Roll back · Daily start / close-out ·
Weekly & monthly rhythm.

---

## 5 · Feature → guide coverage matrix

| Feature area | Quick Start | Administrator | Owner |
|---|:--:|:--:|:--:|
| Sign in & access | ● | ● | ○ |
| Navigation | ● | ● | ○ |
| Dashboard | ● | ● | ● |
| Operations & dispatch | ● | ● | ○ |
| Book Now & AI quotes | ● | ● | ○ |
| Customers & bookings | ○ | ● | ○ |
| Scheduling | ● | ● | ○ |
| Crews | ○ | ● | ○ |
| Claims | ○ | ● | ○ |
| Analytics & money | ○ | ● | ● |
| Pay & statements | ○ | ● | ○ |
| Settings | ● | ● | ○ |
| AI Command Center | ○ | ● | ● |
| Release Center | ○ | ● | ● |
| Security & roles | ○ | ● | ○ |
| Business health & growth | ○ | ○ | ● |

● primary · ○ light/context

---

## 6 · Roadmap

**Now (this edition)** — Quick Start, Administrator, Owner guides on the shared
design system, with 16 real screenshots.

**Next**
1. **Crew Guide** — the portal, from a crew member’s point of view (needs a crew-login capture pass).
2. Re-capture the four PII screens via the **Test-data** view; add annotations.
3. **Release Center Runbook** & **AI Command Center Guide** — the two high-stakes deep dives.

**Later**
4. **Troubleshooting Manual** and **Daily Operations Handbook**.
5. **SVG icon set** to replace the glyph vocabulary.
6. A one-command **PDF build** (headless Chrome) so every guide exports to PDF automatically.
7. Localized editions and a per-tenant rebrand (e.g., the blue **Supercharged** edition) from the same source.

---

## 7 · How to produce PDFs

The guides use modern CSS that only a real browser renders correctly, so PDFs come
from Chrome:

1. Open a guide (e.g. `Operion-Quick-Start.html`) in Chrome.
2. **⌘ P** → Destination **Save as PDF**.
3. **Turn ON “Background graphics”** · Margins **None** · Paper **A4**.
4. Save into `docs/`.

*(A headless one-command build is on the roadmap; today’s premium output is the
Chrome print.)*
