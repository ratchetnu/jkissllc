# 11 — Book Now Operational Runbook

"Book Now" is the online booking + AI-quote funnel and its admin queue.

## The flow

1. Customer submits an online booking (photos + details) on the public site.
2. Intake creates a booking record and queues an AI job.
3. The AI worker (`/api/cron/ai-jobs`, */3m) advances: analysis → pricing → quote-ready.
   See doc 09 for the AI internals.
4. The booking surfaces in the admin **Book Now** queue (`/admin/operations/book-now`)
   with a status the owner acts on.
5. Confirmation / reminders may go out via the comms layer (doc 10), subject to send mode.

## Statuses the queue counts as "needs attention"

The dock badge sums: `new`, `awaiting_photos`, `ai_queued`, `ai_processing`, `ai_failed`,
`manual_review`, `quote_ready` (see `OperationsShell.tsx`). A booking sitting in
`ai_failed` or `manual_review` is the operator's cue to step in.

## Symptom → action

| Symptom | Check |
|---------|-------|
| New online booking not showing | Intake error? Check the booking API / intake logs. Is `INTAKE_WORKFLOW_ENABLED` involved (governed intake is flag-gated; OFF = identical to legacy)? |
| Stuck in `ai_processing` / `ai_queued` | AI worker — doc 09. |
| `ai_failed` | Open the booking; read the job error. Retry is automatic within backoff; persistent failure needs a fix. |
| Quote looks wrong | Compare with shadow output; doc 09. |
| Customer didn't get confirmation | Comms send mode + dedupe — doc 10. |
| Detail page blanking / fl[...]| Known-fixed rendering issues live in git history (poll-driven remounts). If it recurs, capture the network tab and check the poll interval logic. |

## Verifying a Book Now change

1. On Preview, submit a booking with **real** photos end-to-end.
2. Watch it advance through `ai-jobs` ticks to `quote_ready`.
3. Confirm the admin queue badge + statuses update.
4. Keep comms in `test`/`off` (doc 10) unless deliberately verifying live confirmation.

> This sprint does not modify Book Now. This runbook documents the existing flow.
