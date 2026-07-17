# Operion — Operations & Release Documentation

> **Scope of this folder.** This directory is the operational + release-management
> reference for the Operion platform (the admin OS that powers J KISS Freight and
> its sibling deployments). It is documentation and checklists only — it changes no
> runtime behavior. Architecture *strategy* lives in [`../opspilot-os/`](../opspilot-os/);
> this folder is the day-to-day operator's manual that sits on top of it.
>
> **No secrets policy.** Nothing in this folder contains secret values. Environment
> variables are referred to by **name and purpose only**. If you are about to paste a
> token, key, password, or connection string into any file here — stop.

Created by the *Update Center foundation* sprint (branch `feat/update-center-foundation`).
Read-only foundation: no doc here instructs an automated deploy, rollback, or merge.

---

## Index

| # | Document | Use it when… |
|---|----------|--------------|
| 00 | [System Architecture Overview](./00-system-architecture.md) | You need the 10-minute mental model of how the app is put together. |
| 01 | [Repository Map](./01-repository-map.md) | You are looking for *where* something lives. |
| 02 | [Environment Matrix](./02-environment-matrix.md) | You need to know what an env var is for, per environment (names only). |
| 03 | [Local Development Guide](./03-local-development.md) | You are setting up or running the app locally. |
| 04 | [Preview Deployment Guide](./04-preview-deployment.md) | You are shipping a branch to a Vercel Preview. |
| 05 | [Production Deployment Checklist](./05-production-deployment-checklist.md) | You are about to promote to production. |
| 06 | [Rollback Checklist](./06-rollback-checklist.md) | Something is wrong in production and you need to go back. |
| 07 | [Migration Safety Checklist](./07-migration-safety-checklist.md) | A change touches persisted data / key shapes. |
| 08 | [Incident Response Runbook](./08-incident-response-runbook.md) | Production is degraded or down. |
| 09 | [AI Processing Runbook](./09-ai-processing-runbook.md) | The Book Now AI pipeline is stuck, slow, or erroring. |
| 10 | [Communications Safety Runbook](./10-communications-safety-runbook.md) | Anything that sends SMS/email to customers. |
| 11 | [Book Now Operational Runbook](./11-book-now-runbook.md) | Online bookings / quotes need operator attention. |
| 12 | [Crew Portal Runbook](./12-crew-portal-runbook.md) | Crew clock-in, GPS, documents, or portal access. |
| 13 | [Security Checklist](./13-security-checklist.md) | Reviewing a change for auth / tenancy / data-exposure risk. |
| 14 | [Parallel-Session Branch & Worktree Rules](./14-parallel-sessions.md) | Multiple engineers/agents are working the repo at once. |
| 15 | [Feature-Flag Inventory](./15-feature-flags.md) | You need the canonical list of flags and their defaults. |
| 16 | [Release Notes Structure](./16-release-notes.md) | You are writing or reading release notes. |

See also: the read-only **Release Center** admin page at `/admin/operations/release`
(admin-only) surfaces the live build/version, flag states, and the current release
snapshot described in docs 15 and 16.

---

## Phase 1 — Documentation Inventory (audit findings)

Snapshot taken on the `feat/update-center-foundation` branch (based on `origin/main`
at commit `a7ac3f6`). This is the "what exists and what's stale" ledger the rest of
the folder was written to fix.

### What already exists

| Area | Location | State |
|------|----------|-------|
| Architecture strategy (20+ docs) | `docs/opspilot-os/` | **Rich & current.** Executive summary, repo map, domain model, multi-tenant architecture, AI operating layer, security register, target architecture, migration roadmap. Authoritative for *strategy*. |
| Platform-foundation notes | `docs/opspilot-os/platform-foundation/` | Current. Capability registry, tenancy. |
| Audits | `docs/crew-portal-audit.md`, `docs/customer-communications-audit.md`, `docs/opspilot-os/audits/` | Current, feature-scoped. |
| Twilio / A2P SMS | `docs/twilio-a2p-sms.md` | Current, service-specific. |
| Roadmaps | `docs/opspilot-multi-tenant-roadmap.md`, `docs/opspilot-future-improvements.md` | Forward-looking; not operational. |
| Root README | `README.md` | **Stale.** Stock `create-next-app` boilerplate — does not describe this app at all. |
| Agent instructions | `AGENTS.md` / `CLAUDE.md` | Current but minimal: "read `node_modules/next/dist/docs/` before writing Next.js code." |

### Gaps this folder fills

Before this sprint there was **no** consolidated operator documentation for:

- ✗ System architecture *overview* (the strategy docs are deep, not a quick map) → doc 00
- ✗ Environment variable matrix (names/purpose per environment) → doc 02
- ✗ Local dev / preview / production deploy procedures → docs 03–05
- ✗ Rollback & migration-safety checklists → docs 06–07
- ✗ Incident response runbook → doc 08
- ✗ Subsystem runbooks (AI, comms, Book Now, crew portal) → docs 09–12
- ✗ A single security checklist → doc 13
- ✗ Written parallel-session branch/worktree rules → doc 14
- ✗ A canonical, human-readable feature-flag inventory → doc 15 (source of truth stays `app/lib/platform/flags.ts`)
- ✗ A release-notes structure → doc 16

### Outdated / conflicting guidance found

1. **Root `README.md` is boilerplate.** It still tells you to "edit `app/page.tsx`" and
   links the Next.js tutorial. It describes none of Operion. *Recommendation:* replace
   or point it at `docs/operations/`. (This sprint does not overwrite it to avoid
   colliding with other in-flight branches — flagged for a follow-up.)
2. **`VISION_ESTIMATION_SHADOW` is retired but still present.** `app/lib/platform/flags.ts`
   keeps the flag name for compatibility, but the inline shadow path it gated was
   permanently removed (it caused double-analysis timeouts). Doc 15 records this so
   nobody re-enables it expecting an effect.
3. **Two things are both called "Update Center."** The owner-only, write-capable
   multi-tenant console at `/admin/operations/platform` (code: `app/lib/platform/updates/*`)
   and the *read-only* admin Release Center added by this sprint at
   `/admin/operations/release`. They are complementary, not duplicates — doc 00 and
   doc 16 draw the line. See "potential navigation conflicts" in the sprint report.
4. **`vercel env pull` redacts many production values.** A pulled `.env` showing `""`
   for a var (notably every `OPERION_*` flag) is redaction, not the real value.
   Verify flag states via the dashboard or the runtime, never by trusting a pulled blank.
   Recorded in doc 02.

### Inventory reference data (verified from the repo)

- **Cron jobs** (`vercel.json`): `daily` (14:00 UTC), `reminders` (*/5m), `ai-jobs`
  (*/3m), `vision-shadow` (*/10m), `shadow-alerts` (*/15m), `operion-reconcile` (*/5m).
  Detailed in doc 00 and the relevant runbooks.
- **External services**: Vercel (hosting, Blob storage, KV/Redis), Stripe (payments),
  Resend (email), Twilio (SMS), Google Places (reviews/place data), Vercel AI Gateway
  (all model calls), BotID (bot mitigation), MapLibre (maps). Detailed in doc 02.
- **Runtime**: Next.js 16 (App Router), React 19, Node ≥24. Deployed on Vercel.
