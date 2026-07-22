# Admin User Manual — Screenshots

This folder holds the screenshots referenced by `docs/Admin-User-Manual.md`
(the `[SCREENSHOT: …]` placeholders).

## Why the placeholders are not yet filled

Every Operion admin page is authentication-gated:

- `/admin/**` and `/admin/operations/**` require an **admin** or **platform‑owner**
  session (`requireAdmin` / `requirePlatformOwner`).
- The crew `/portal/**` pages require a crew session or a signed portal token.

Automated capture therefore requires a **running instance** *and* a **real
authenticated browser session**. Screenshots were intentionally **not**
fabricated. Capture them against a trusted environment using the procedure below.

## Capture procedure (owner performs)

1. Start the app (or use the Preview/Production URL) and sign in as the owner/admin
   in your browser.
2. For each `[SCREENSHOT: <Name>]` placeholder in the manual, navigate to the
   corresponding route (the manual lists the route for every page) and capture the
   viewport.
3. Save each image here as `NN-<kebab-name>.png` (e.g. `03-dashboard.png`) and
   update the placeholder to `![<Name>](admin-manual-assets/screenshots/NN-<kebab-name>.png)`.

## Suggested capture list (major pages)

| # | Name | Route |
|---|------|-------|
| 01 | Sign in | `/admin` (redirects to auth) |
| 02 | Admin home / dashboard | `/admin` |
| 03 | Operations dashboard | `/admin/operations` |
| 04 | Operations list | `/admin/operations/list` |
| 05 | Operation detail | `/admin/operations/[id]` |
| 06 | Schedule / calendar | `/admin/operations/schedule` |
| 07 | Book Now inbox | `/admin/operations/book-now` |
| 08 | AI Control Center | `/admin/operations/ai` |
| 09 | AI queue | `/admin/operations/ai/queue` |
| 10 | AI performance | `/admin/operations/ai/performance` |
| 11 | Businesses | `/admin/operations/businesses` |
| 12 | Release Center | `/admin/operations/release` |
| 13 | Finance | `/admin/operations/finance` |
| 14 | Pay statements | `/admin/operations/pay-statements` |
| 15 | Employees | `/admin/operations/employees` |
| 16 | Communications | `/admin/operations/communications` |
| 17 | Analytics | `/admin/analytics` |
| 18 | Crew portal — Today | `/portal` |
| 19 | Crew portal — Clock | `/portal/clock` |

> The manual's Navigation section (§4) lists the full route inventory if you want
> to capture every page.
