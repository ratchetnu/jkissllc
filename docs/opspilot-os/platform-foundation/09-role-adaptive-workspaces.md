# 09 — Role-Adaptive Workspaces

**Files:** `app/lib/platform/workspaces/{types,registry,route-map}.ts` ·
**Tests:** `scripts/workspaces.test.ts`.

## Model (`types.ts`, `registry.ts`)
Nine personas — platform-owner, org-owner, administrator, manager, dispatcher,
office, crew, contractor, customer — each mapped to an RBAC role (or platform/
public). The owner destinations are the requested top-level IA: **Today, Jobs,
Customers, Team, Messages, Money, Assets, Insights, Automations, Settings**, plus
portal destinations (crew-home/jobs/messages, my-bookings). Every destination
declares a backing capability and which personas may see it.

Each `RoleWorkspace` exposes destinations, capabilities (**derived from visible
destinations**, so a persona can never receive an inaccessible destination),
primary actions, visible metrics, available AI workers, approval authority, and
mobile priorities.

## Integrity (tested)
- Every destination references a real capability in the registry.
- No persona is handed a destination outside its capability set.
- Crew/contractor never see Money/Settings; customer sees only their bookings.
- Approval authority: admins + manager yes; crew/customer no.

## Compatibility map (`route-map.ts`)
Maps each destination to the **current** routes that already serve it
(`today → /admin/operations`, `jobs → /admin/operations/list` + `/admin/routes`,
`money → finance` + `pay-statements` + `/admin/invoices`, etc.), so a future nav
cutover is a re-label, not a rebuild. `destinationGaps()` flags destinations with
no current home — notably **customers** (no first-class customer surface yet).

## Not done
The production nav cutover and any rendering — this is IA only, validated against
today's routes. Deferred until validated with the owner.
