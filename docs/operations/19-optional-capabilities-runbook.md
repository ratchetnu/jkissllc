# 19 — Optional capabilities & sending an update to Supercharged

Two operational procedures that used to be one confusing surface:
**turning an optional feature on or off for a business**, and
**shipping a software update from Operion to a managed target**.

They are deliberately separate. Operion owns update/release/deployment state; each
target owns its capability profile and its credentials. Neither can block the other.

---

## 1. What "optional" means here

Payments, SMS and email are **optional capabilities**. The records they deliver —
a payment, a message, a notification — are core and always work. Only the leg that
leaves the building is optional.

| State | What it means | What to do |
|---|---|---|
| **Not in use** | This business does not run it. | Nothing. It is a decision, not a fault: health stays green and updates keep arriving. |
| **Setup needed** | Switched ON, credentials missing. | Set the variables the panel names, in the hosting environment. Only this capability is affected. |
| **On** | Enabled and credentialed. | Nothing. Presence only — a real call is the only proof of reachability. |
| **Problem** | Configured, and the last real call failed. | Treat as an outage for that channel. |
| **Not on your plan** | Offered, but your plan does not include it. | Nothing here. (Not enforced today — no capability restricts tiers yet.) |
| **Needs another feature first** | A prerequisite is switched off. | Turn the named prerequisite on. |

Beyond the three delivery channels, the same switchboard now covers **online booking**
(the public Book Now form, separate from the booking record everything else is built
on), **photo estimates**, **contractor pay**, **damage claims**, **careers and
onboarding**, **GPS verification**, **compliance photos**, **crew reliability**,
**equipment** and **fleet**. Each one states, in the panel, what stops working before
you switch it off — and every one keeps its existing records when you do.

### Before anything is decided: the backfill

A business that has never recorded its choices is still being read from its
credentials — the panel says so, in amber. `backfillCapabilityProfile(tenantId,
{ dryRun: false })` records what is true today as real decisions and changes nothing.
It is idempotent, only ever adds, never removes a credential reference or an existing
choice, and a dry run (the default) writes nothing at all — not even the marker.

### Turning one on or off

`/admin/operations/settings` → **Optional features**. Admin only
(`settings:manage`). Every change is audited with your name on it; so is every
refused attempt.

The API is `GET`/`PATCH /api/admin/capabilities`. The tenant is resolved from your
signed session — naming another business in the request body does nothing.

**Credentials are never stored here.** A capability may carry a `credentialRef`,
which must be a variable NAME or a path (`STRIPE_SECRET_KEY`,
`vercel://prj_1/STRIPE_SECRET_KEY`). Pasting a value is refused outright, not
truncated: a truncated key is still most of a key.

### What still works with all three switched off

| Without | You still have |
|---|---|
| Stripe | Invoices, booking totals, and the payment ledger. Record cash / check / Zelle from the booking or invoice; the invoice marks paid normally. Customer checkout routes refuse with a message naming Zelle rather than reporting a failure. |
| SMS | Every message record and thread, the crew portal, and the admin surfaces. Assignments and links are handed over in the admin. |
| Email | Every notification record. **Admin → booking → Send link** returns the secure link for you to pass on by hand, with the reason attached; the booking is NOT marked "link sent" until you confirm you delivered it (`Send link` with `manualDelivered`), which is recorded as a manual delivery. |

One real coupling worth knowing: on Supercharged, `alerting` accepts **either**
Slack **or** Resend + `ALERT_EMAIL_TO`. Switch email off there without Slack
configured and operational alerts notify nobody. The health endpoint says so.

### Inbound webhooks while a capability is off

Applied **after** signature verification, never before:

| Situation | Response |
|---|---|
| Cannot verify (no secret) | `503`, fail closed. Nothing is parsed. |
| Signature invalid | `403`/`400`. Not a retry candidate. |
| Verified, capability **disabled** | `200 { ignored: true }`. Authentic, deliberately discarded. A `5xx` here would make the provider retry for hours against a business that opted out. |
| Verified, **enabled but broken** | `503`. A real outage — that retry is wanted. |

**One carve-out:** a Stripe checkout confirmation is always recorded, even with card
payments switched off. It confirms a charge this deployment created against a card
the customer has already been debited; dropping it declines nothing and only loses
our record, leaving a paid booking marked unpaid. An arriving payment for a channel
nobody expects to be live raises an alert.

---

## 2. Sending an update to Supercharged

`/admin/operations/platform` → **Send an update**. Owner only.

1. Choose the update, choose Supercharged.
2. Operion checks compatibility and readiness. If anything blocks, you get **one
   plain sentence and one thing to do** — the gate ids live under **Advanced**.
3. **Send to Supercharged Preview.** Copies the approved files to a Supercharged
   branch, runs Supercharged's own typecheck, tests and build, and opens a Preview.
   Nothing goes live; nothing is merged.
4. Progress updates itself. **You can close the tab** — every fact is server-held,
   so a refresh, a logout or a different device resumes where it was.
5. **Review Preview** → one screen: what changed, the Preview link, the checks,
   optional-feature impact, and the rollback target. Approving records intent with
   a typed phrase. It does not publish.
6. **Publish** takes a second, different typed phrase. Two phrases on purpose, so
   approving and publishing never become the same muscle memory.
7. **Live in Supercharged** appears only after the live build verifies.
8. Anything fails → one plain blocker and one recovery action. Nothing is
   half-applied; the target stays on its previous build.

### What optional features do NOT do

They never block a deployment. There is no preflight gate that reads Stripe, Twilio
or Resend readiness, and none may be added — a test greps the rendered gate set for
those names and fails if any appears.

- A disabled capability makes an update **dormant**, never "not applicable".
  Dormant means installed; turning the capability on later needs no redeployment.
- A `platform_core` or `shared_module` update is **never** dormant.
- The one capability fact that MAY block is missing capability **code** on the
  target — the same class of blocker as `requiredModules`, because the transfer
  would not compile.

### The evidence Supercharged returns

After a Preview run, Supercharged reports what it is actually running and which
optional channels are live there, inside the existing signed callback. Booleans,
stable state codes, and variable NAMES only — never an environment value. It comes
from the **running deployment**, never computed in CI: a GitHub runner has no KV
binding and no provider credentials, so anything it inferred locally would report
every capability as disabled, indistinguishable from a business that genuinely
switched them off.

To enable it, set on the Supercharged repository:
`OPERION_EVIDENCE_URL` (the deployment to ask) and `OPERION_EVIDENCE_SECRET` (the
value `/api/platform/capability-evidence` requires). Without them the callback
reports the commit alone and never guesses.

---

## 3. Advanced / recovery

Under **Advanced** in the guided view: the job id and status, the approval and
publish states, the raw gate list, **Refresh**, and **Cancel this run**. Everything
that was on the old screen is still reachable — it is not on the normal path
because the normal path should not require knowing that `awaiting_owner_review`
means "your turn".

Rollback is offered as the recovery action when a publish fails, and it goes
through the same controlled executor.

---

## 4. Multi-tenant GA

`GET /api/admin/platform/ga-readiness` (owner only, read-only) reports thirteen
dimensions separately. **Update distribution working is not multi-tenancy** — the
projection keeps them apart on purpose, because a single green light would let the
first stand in for the second.

Three verdicts: `proven` (evidence exists in this deployment), `built`
(implemented, and nothing here has ever exercised it), `gap`. `gaReady` requires
every dimension; `tenancyEnablementSafe` is narrower and is never satisfied by
`built`.

**Do not enable `TENANCY_ENABLED` in Production while it reports false.** The
remaining actions it names today are listed in `OPERION_CURRENT_STATE.md` §0.5.
