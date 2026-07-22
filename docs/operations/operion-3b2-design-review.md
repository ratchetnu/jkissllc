# Operion Increment 3B.2 — Production Promotion Experience: Design Review

> **Status:** design only. No code, no schema, no execution. Builds on 3B.1 (state model,
> eligibility evaluator, guards, read-only diagnostic). This document is the contract 3B.2
> implements. _(Working-tree deliverable — commit on the future `feat/operion-3b2-*` branch.)_

## 0. Bar we are designing to
Apple/Stripe/Linear/Vercel-grade for a **rare, irreversible, high-consequence** action.
Principles: **calm by default, deliberate at the moment of consequence, honest about risk,
reversible, and fully auditable.** Publishing to Production is the one place the interface is
allowed to slow the user down.

---

## 1. Current Release Center — UX audit
Today (`app/admin/operations/release/page.tsx`):
- **Businesses section** → one `BusinessRow` per product: name · edition · `Version X · Updated N` · a status chip · **one primary button** (`Update` / `Set Up` / `Check for Updates` / `Publish to Production`) · a chevron that expands an inline **details panel** (A newer version…, Current/Latest version, **Update Flow** stepper `Check→Review→Preview→Verify→Promote`, Preview status, Checks, Recent activity, **Advanced** connection info).
- The `Publish to Production` button already renders for `ready_to_publish` but is a **placeholder** (`setNote('…coming next')`).
- Design-system primitives available: `Dialog`, `Drawer` (real focus trap, Esc, return-focus), `FormField`, `Input`, `Button` (primary/secondary/danger/quiet), `StatusBadge`, tokens.

**Gaps for promotion:** no review surface, no typed confirmation, no risk presentation, no
eligibility display, no rollback affordance, no audit view.

---

## 2. UX decisions

### 2.1 Where does "Publish to Production" appear?
- **Not a bare row button.** The row is a calm summary; a one-click row action for an
  irreversible Production change is unsafe and off-brand.
- **Row primary action becomes "Review & Publish"** (label for `ready_to_publish`). It does not
  publish — it **opens the review**. The row never triggers the promotion directly.
- **Review lives in a right-side Drawer** (reuse the design-system `Drawer`), not a separate page.
  A drawer keeps context (the Release Center list stays visible), matches the existing detail-drawer
  pattern, and is the Linear/Vercel idiom for a focused decision. A dedicated `/release/publish/[id]`
  route is **overkill** for 3B.2 and fragments the model; revisit only if promotions need deep-linking.
- **In-progress + terminal states render inline in the row + drawer** (Publishing…, Verifying
  production…, Published, Publish failed, Rolling back…) via the 3B.1 states — the drawer becomes a
  live progress view when a promotion is running.

### 2.2 Visibility when ineligible
- **Never show an actionable "Publish" when ineligible.** Instead:
  - If the business is on the happy path but not yet verified → the row shows `Update` / progress, no publish.
  - If verified + eligible → **Review & Publish** (attention tone).
  - If verified but **blocked by an eligibility reason** (e.g. drift, expired verification) → show a
    quiet **"Not ready to publish"** chip; the drawer's eligibility panel explains why (owner-only).
- The eligibility diagnostic (3B.1 endpoint) drives this — the UI **mirrors** server truth, never
  computes its own gate. Server remains authoritative.

---

## 3. Owner Review Screen (Drawer) — wireframe

```
┌────────────────────────────────────────────── Publish to Production ──┐
│  Supercharged Enterprises            [ PRODUCTION ]  ← red context chip │
│  Branded edition · superchargedenterprise.com                          │
│                                                                        │
│  ┌─ What changes ───────────────────────────────────────────────────┐ │
│  │  Current production   1.0.0        →   Candidate   1.1.0  (minor) │ │
│  │  Commit  a64f538 (release/1.1.0-source)                           │ │
│  │  Preview  ✓ verified · operion-sandbox-bvv4…vercel.app  [open ↗]  │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│  ┌─ Verification ───────────────────────────────────────────────────┐ │
│  │  ✓ Typecheck  ✓ Lint  ✓ Tests  ✓ Build  ✓ Preview health         │ │
│  │  Verified 12 min ago · fresh                                      │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│  ┌─ Changes ────────────────────────────────────────────────────────┐ │
│  │  1 file · lib/version.ts (+1 / −1)                                │ │
│  │  No migrations · No env changes · Rollback supported             │ │
│  │  [ View diff ↗ ]                                                  │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│  ┌─ Risk ───────────────────────────────────────────────────────────┐ │
│  │  ● Low — reversible, no migration.                               │ │
│  │  (amber/red banner appears only when a real risk exists)         │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│  ▸ Eligibility (10/10 passed)          ← collapsible; owner-only      │
│  ▸ Rollback plan                       ← target dpl_… · Instant + revert│
│  ▸ Audit (what will be recorded)                                       │
│                                                                        │
│  ──────────────────────────────────────────────────────────────────── │
│  Type the business name to confirm:   [  Supercharged Enterprises  ]   │
│  [ Cancel ]                       [ Publish to Production ]  ← danger   │
│    (Publish disabled until the typed value matches AND eligible)       │
└────────────────────────────────────────────────────────────────────────┘
```

Content, mapped to 3B.1 data:
- **Business / edition / production URL** — from the business record.
- **Current → Candidate version + release type** — `versions.ts` (`classifyReleaseType`).
- **Candidate commit + source branch** — job `targetCommit`/`workBranch`.
- **Preview deployment** — job `previewUrl`/`previewDeploymentId`, "verified".
- **Verification summary** — the update's `ValidationChecklist` + freshness.
- **Files changed** — from the PR/commit (small summary + "View diff ↗" to GitHub; deep read is 3B.3).
- **Risk** — derived: migration? env change? rollbackSupported? breaking? release type.
- **Eligibility** — the 3B.1 `requirements[]` (green ticks / red reasons), collapsed by default.
- **Rollback target** — captured prior production deployment id (shown, not yet executable).
- **Audit** — a plain-language preview of what will be recorded.

---

## 4. Approval experience

| Decision | Recommendation | Why |
|---|---|---|
| **Typed confirmation** | **Yes** — type the exact business name (like GitHub repo-delete). | Forces intent; prevents muscle-memory clicks. |
| **Two-step** | The review drawer **is** step 1; the typed confirm + danger button is step 2. **No extra modal-on-modal.** | Two deliberate gates, one calm surface. |
| **Approval expiry** | **Yes.** The eligibility snapshot + verification are TTL-bound (default 24h). If the drawer is stale or the candidate drifts, the button disables and shows "Re-verify — the candidate changed / verification expired." | Never publish a stale/drifted candidate. |
| **Server re-check at click** | **Mandatory.** On submit, re-run the eligibility evaluator server-side (drift + freshness) before recording approval. UI approval is never the gate. | Defeats TOCTOU. |

**Permanently recorded on approval** (audit): business id · owner sub · approvedAt · source→candidate version · candidate branch + approvedCommit · preview deployment id · prior production deployment id (rollback target) · verification result snapshot · the typed-confirmation acknowledgement · a correlation id linking every downstream event. (Persistence = 3B.3; 3B.2 records the **approval** transition + correlation id.)

---

## 5. Failure UX

```
Publish failed            ● red    "Publishing didn't complete. Production is unchanged."
                                     [ View details ]  [ Retry ]  [ Roll back ]
Verification failed (prod) ● red    "The new version failed production health checks."
                                     Auto-rollback: on → "Restoring previous version…"
                                                    off → [ Roll back to 1.0.0 ]
Rolling back…              ● busy   progress: Restoring previous production deployment
Rolled back               ● amber  "Restored 1.0.0. The update was not published."  [ View audit ]
Rollback failed           ● red    "Automatic rollback did not complete — manual action needed."
                                     [ Open Vercel deployment ↗ ]  [ Contact / runbook ]
```

Rules:
- **Honest, calm copy** — "Production is unchanged" when nothing shipped; never blame the user.
- **Retry re-enters the review** (re-verify first) — never a silent re-fire.
- **Roll back** offered on `publish_failed` / `published`; confirms target version; Instant Vercel
  re-promote + optional `git revert` (3B.4). Migration-carrying candidates disable auto-rollback and
  say so up front (they were refused at eligibility unless `rollbackSupported`).
- **Rollback failed** is terminal + alert-only: point to the runbook + the exact prior deployment id.

---

## 6. Multi-business scalability (hundreds–thousands)
- **List virtualization** — the Businesses section must paginate/virtualize; render only visible rows.
- **Eligibility is lazy** — never evaluate promotion for every row on load. Evaluate **on drawer open**
  (or a cheap "publishable?" boolean from the projection). The 3B.1 endpoint is per-business, on demand.
- **Grouping + filter + search** — group by status (Needs attention → Update available → Publishable →
  Up to date), filter by edition/state, search by name. (The projection already sorts by rank.)
- **Bulk is out of scope / discouraged** — Production promotion is deliberately single-business,
  one-at-a-time, typed-confirmed. No "publish all." (A future "staged rollout" is its own increment.)
- **Server load** — eligibility is pure + reads a bounded snapshot; no fan-out provider calls on list
  render. Live GitHub/Vercel reads happen only inside an open review (cached briefly).
- **Locking** — one promotion lock per business; the list shows "Publishing…" for locked rows without
  re-evaluating.

---

## 7. Accessibility
- **Drawer** already traps focus, restores focus, closes on Esc, has `role=dialog aria-modal`. Reuse it.
- **Keyboard:** Tab order Review → collapsibles (Enter/Space toggle, `aria-expanded`) → confirm input →
  Cancel/Publish. Publish stays disabled (with `aria-disabled` + a reason) until valid.
- **Screen readers:** section headings (`h2/h3`), the risk banner is `role=status`/`role=alert` by
  severity, eligibility list uses `ul`/`li` with per-item pass/fail conveyed by **text not color**,
  live progress announced via `aria-live=polite` (Publishing… → Verifying… → Published).
- **Color independence:** every status pairs an icon/word with color (existing `StatusBadge` dot+label).
- **Contrast:** reuse `--status-*` + `--ink-muted` tokens (AA-validated).
- **Mobile:** the Drawer is full-width `min(460px,94vw)`; the danger button and confirm input meet the
  44px touch target; no horizontal overflow (`.safe-x`, `overflow-x: clip`).
- **Reduced motion:** progress uses the existing reduced-motion-aware spinners/steppers.

---

## 8. State diagrams

### Release-facing (from 3B.1; the drawer renders these)
```
update_available → updating → preview_ready → ready_to_publish
                                                     │ (Review & Publish → typed confirm)
                                                     ▼
                                              awaiting_approval → publishing → verifying_production → published
                                                     │                │              │
                                                     └──────────── publish_failed ◄──┘
                                            publish_failed / published → rolling_back → rolled_back
                                                                                     └→ rollback_failed
```

### Approval sub-flow (3B.2 UI)
```
[Row: Review & Publish] → open Drawer
  → load eligibility (owner GET)  ──ineligible──► show reasons, Publish disabled
  → eligible                       ──► type name ──match──► enable Publish (danger)
  → click Publish → server re-check (drift+fresh)
        ├─ still eligible → record approval + correlationId → job: awaiting_owner_review → approved_for_production → Drawer switches to progress
        └─ drifted/stale  → toast "candidate changed — re-verify"; keep Production untouched
```

---

## 9. User flow (happy path)
1. Owner opens Release Center → sees a business at **Ready to publish**.
2. Clicks **Review & Publish** → Drawer opens; eligibility loads (10/10).
3. Reads what-changes / verification / diff / risk (Low).
4. Types the business name → **Publish to Production** enables.
5. Clicks it → server re-verifies → approval recorded → Drawer shows **Publishing…**.
6. (3B.3/3B.4 execute) → **Verifying production…** → **Published** (or failure UX §5).
7. Audit entry available under "View audit".

---

## 10. Component inventory

**Reuse (design system / existing):** `Drawer`, `Button` (primary/secondary/danger), `FormField`,
`Input`, `StatusBadge`, `Chip`, `Section`, tokens, `mapJobToProgress`/promotion stages, the release
resolver + 3B.1 eligibility types.

**New (3B.2, small + isolated):**
- `PublishReviewDrawer` — the review surface (composed from `Drawer` + sub-cards).
- `EligibilityChecklist` — renders 3B.1 `requirements[]`/`reasons[]`.
- `RiskBanner` — severity → tone (pure mapper `deriveRisk(update, releaseType)`).
- `TypedConfirm` — `Input` + match logic + `aria` wiring (reusable; also useful elsewhere).
- `PublishProgress` — promotion stepper (Approved→Merging→Deploying→Verifying→Live) from `PROMOTION_STAGES`.
- `RollbackControl` — confirm + target display (execution deferred to 3B.4).
- Wire `BusinessRow` action `publish` → open drawer (replace the placeholder `setNote`).

---

## 11. Required APIs
- **Reuse:** `GET …/promotion-eligibility` (3B.1).
- **New (3B.2, thin, owner+flag-gated, NO execution):**
  - `GET …/businesses/[id]/publish-review` → the assembled review payload (versions, commit, preview,
    verification checklist, files-changed summary, risk, rollback target, audit preview). Read-only.
  - `POST …/businesses/[id]/approve` → re-runs the evaluator, and **only if eligible** records the
    approval + correlation id and transitions `awaiting_owner_review → approved_for_production`.
    Still **no merge/deploy** (that is 3B.3). Returns typed refusal on ineligibility.

## 12. Required data
- **No new store for 3B.2.** Approval is recorded on the existing job (`approvedBy`, `approvedAt`,
  `approvedCommit`, plus a `correlationId`/`traceId` — fields already present). The audit **entry** is
  the job's transition log now; a first-class `platform:release:audit:*` family lands in 3B.5.
- The review payload is **assembled**, not stored (projection over business + job + update + reconciliation).

## 13. Risks
- **TOCTOU / drift** — mitigated by mandatory server re-check at click + freshness TTL. (Highest risk.)
- **Owner over-trust of green** — mitigated by typed confirm + explicit risk banner + files-changed.
- **Ineligible-but-visible** — mitigated by mirroring server eligibility, never a client gate.
- **List performance at scale** — mitigated by lazy per-business eligibility + virtualization.
- **Copy that implies success too early** — mitigated by state-accurate, honest microcopy.
- **Accidental prod from preview** — impossible in 3B.2 (approve records intent only; execution
  backstop from 3B.1 still refuses; flag off in prod).

## 14. Recommended implementation order (3B.2)
1. **`deriveRisk` + review payload builder (pure) + `GET publish-review`** — read-only, fully testable.
2. **`PublishReviewDrawer` + `EligibilityChecklist` + `RiskBanner`** — render the payload; no submit yet.
3. **`TypedConfirm` + enable/disable logic + a11y** — the deliberate gate.
4. **`POST approve`** (server re-check → record approval + correlation id → status transition only).
5. **Row wiring** (`publish` action → drawer) + **PublishProgress** shell for the new states.
6. Tests (payload builder, risk, typed-confirm gating, approve re-check/refusal, a11y) + Preview verify.
   **Stop before any merge/deploy execution (that is 3B.3).**

---

## 15. Recommendation — UX changes before coding 3B.2?
**Yes — three small, foundational ones, all additive:**
1. **Promote the design system's `Drawer` to the standard "deliberate action" surface** and add a
   reusable **`TypedConfirm`** primitive (name-match confirm) to `app/components/ui` — it is generic
   (also useful for destructive admin actions) and prevents each screen re-inventing it.
2. **Change the `ready_to_publish` row action label/route** from a direct "Publish to Production" to
   **"Review & Publish"** that opens the review drawer — so the row never fires an irreversible action.
   (Label/route only; behavior lands in 3B.2.)
3. **Add a lightweight "publishable" hint to the Businesses projection** (a cheap boolean) so the list
   can show "Ready to publish" vs "Not ready" without evaluating full eligibility per row — the
   scalability prerequisite.

Everything else reuses existing primitives and the 3B.1 foundation. No resolver or eligibility change
is needed before 3B.2; these are purely presentational + one projection hint.

_Stop point: design approved → implement 3B.2 in the order above, execution-free._
