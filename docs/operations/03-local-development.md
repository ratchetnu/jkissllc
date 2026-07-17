# 03 — Local Development Guide

## Prerequisites

- **Node ≥24 <25** (see `.nvmrc` / `package.json` `engines`). Use `nvm use`.
- Vercel CLI (for pulling env + linking). The repo is linked (`.vercel/`).
- Access to the team's Vercel project for env vars.

## Setup

```bash
nvm use                       # Node 24
npm install                   # install deps
vercel env pull .env.local    # pull local env (see caveat below)
npm run dev                   # http://localhost:3000
```

> **Env pull caveat.** `vercel env pull` redacts many production secrets to `""`.
> A blank is redaction, not the real value. For local work you generally want the
> **Development** environment values; for anything blank that you need, get the value
> from the dashboard. Never commit `.env.local` (it is gitignored).

## Running the app

- Public site: `http://localhost:3000`
- Admin OS: `http://localhost:3000/admin` → redirects into `/admin/operations`.
  Sign in as owner (blank email + `ADMIN_PASSWORD`) or as a named user (email + password).
- Release Center: `http://localhost:3000/admin/operations/release` (admin only).

## Testing AI locally

The AI path calls the Vercel AI Gateway. Locally you can authenticate with a fresh
OIDC token instead of a long-lived key:

```bash
vercel env pull            # refreshes VERCEL_OIDC_TOKEN
npm run test:ai            # AI unit tests
npm run test:ai:regression # regression suite (part of predeploy)
```

> Vision tests need a **real, full-size** photo — tiny placeholder images make the
> gateway 500. Use an actual JPEG when exercising the estimator.

## Test / quality commands

| Command | What it does |
|---------|--------------|
| `npm run lint` | ESLint (Next config). |
| `npx tsc --noEmit` | TypeScript check. |
| `npm test` | Full `scripts/*.test.ts` suite (node:test via tsx). |
| `npm run test:ai` / `test:ai:regression` | AI suites. |
| `npm run test:finance` / `test:routes` | Targeted suites. |
| `npm run predeploy` | `tsc --noEmit` + AI regression — the pre-ship gate. |
| `npm run audit:mobile` | Mobile overflow audit. |
| `npm run build` | Production build (final gate). |

## Conventions to respect

- **This is not the Next.js you may know.** Per `AGENTS.md`, read the relevant guide
  in `node_modules/next/dist/docs/` before writing Next.js code — APIs/conventions may
  differ from training data, and deprecation notices matter.
- Reuse the design language from `app/admin/operations/ui.tsx`; don't re-define tokens.
- Gate every admin API through `app/api/admin/_lib/session.ts`.
