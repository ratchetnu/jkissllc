# 10 — Communications Safety Runbook

Anything that can send SMS or email to a customer routes through this. The overriding
rule: **no accidental live send, ever, from a non-production environment.**

## Send-mode model (`app/lib/comms/policy.ts`)

The comms layer is **default-suppressed**. Effective send mode resolves as:

| Mode | Behavior |
|------|----------|
| `off` (default) | Nothing sends. |
| `test` | Renders + validates the message and logs a simulated ledger entry, but **never** calls Twilio/Resend. |
| `live` | Real provider calls — **only** when `COMMS_SEND_MODE=live` **AND** running in production. |

Hard guarantee in code: **Preview and dev never send live**, regardless of
`COMMS_SEND_MODE`. Live requires production + explicit `live`.

## Channels & providers

- **SMS** — Twilio (`TWILIO_*`, messaging service + from number). A2P registration and
  number details: `docs/twilio-a2p-sms.md`.
- **Email** — Resend (`RESEND_API_KEY`).
- Inbound webhooks are signature-verified (`TWILIO_WEBHOOK_SECRET`,
  `EMAIL_WEBHOOK_SECRET`).

## Before shipping a comms change

- [ ] Default state stays **suppressed** — new event wiring lands `off`/`test`, not
      `live`.
- [ ] Templates contain no secrets and no unnecessary PII; every marketing/automated
      message honors opt-out.
- [ ] Idempotency: an event can't fire the same message twice (dedupe key / status
      guard). Duplicate customer messages are a Sev-1 class defect.
- [ ] Verified in `test` mode first — inspect the simulated ledger entry, not a real
      send.

## Turning something live (deliberate)

1. Confirm the exact event and audience.
2. Confirm you are targeting **production** and set `COMMS_SEND_MODE=live` there only.
3. Roll out narrowly first (one event type), watch the ledger + delivery + opt-outs.
4. Keep the flag/mode reversible — flipping back to `off` stops sends immediately.

## Incident: wrong / duplicate / unexpected messages

1. **Stop the source now**: set `COMMS_SEND_MODE=off` in production (fastest kill), or
   roll back the offending change (doc 06).
2. Assess blast radius from the ledger: who received what.
3. Root-cause the trigger (event wiring, missing dedupe) before re-enabling.
4. Record in the incident log (doc 08).

> The Update Center foundation sprint sends nothing and touches no comms wiring.
