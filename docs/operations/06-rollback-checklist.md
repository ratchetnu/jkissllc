# 06 — Rollback Checklist

When production is wrong, getting back to a known-good state is the priority. Diagnose
*after* you are stable, not before.

## Decide fast

Roll back now if any of these are true:
- Customer-facing flow is broken (booking, quote, payment, tracking).
- Data is being written incorrectly.
- Error rate or alert volume spiked right after the promotion.
- A customer-communication defect could send wrong/duplicate messages.

If it's cosmetic or low-impact and clearly isolated, a forward hotfix may be better —
but the default under uncertainty is **roll back**.

## Code rollback (Vercel)

1. Identify the last known-good production deployment (its commit SHA — the Release
   Center and the platform console record recent commits).
2. **Promote the previous good deployment** back to production (Vercel "Promote"/
   "Rollback" on the prior deployment, or a Rolling Release revert). This is instant and
   does not rebuild.
3. Confirm `/admin/operations/release` shows the restored commit + `production`.
4. Smoke the previously-broken flow.

> Operion now provides an **owner-only controlled rollback** from Release History when a
> distinct prior READY production deployment is available. It requires the release gate,
> production-promotion flag, and the exact typed rollback phrase, and it records the result
> in release history. Vercel CLI remains the break-glass fallback. Fully automatic rollback
> is separate and remains behind `OPERION_AUTOMATIC_ROLLBACK_ENABLED` (doc 15). Both paths use
> Operion's server-side Vercel provider; target repositories do not receive a second Production
> token or an independently dispatchable rollback workflow.

## Config / flag rollback

- If the incident was caused by **flipping a flag on**, turn it **off** (dashboard) —
  usually faster than a code rollback and enough on its own. Flags are designed so OFF
  restores prior behavior.
- If caused by a bad env value, correct it and redeploy (or promote a build that
  predates it).

## Data considerations

- Code rollback does **not** undo data already written. If the bad build wrote malformed
  records:
  - Stop the source (rollback/flag-off) first.
  - Assess blast radius (how many records, which key prefix).
  - Records carry `recordVersion`; a forward-fix reader that tolerates the bad shape is
    often safer than mutating data. Coordinate with doc 07.
- Never mass-delete records to "clean up" without a verified backup/plan.

## After you're stable

- [ ] Confirm customers are unaffected going forward.
- [ ] Note the bad commit and the restored commit.
- [ ] Open an incident record (doc 08) and write the root cause before re-attempting.
- [ ] Update the release note (doc 16) with the rollback + reason.
