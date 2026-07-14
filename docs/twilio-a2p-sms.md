# Twilio A2P SMS — HELP, opt-out, and delivery-status configuration

This documents how the application handles inbound keywords and delivery receipts, and
how to configure the Twilio Messaging Service so the two don't conflict.

## What the application does (code)

- **Inbound webhook** — `POST /api/webhooks/twilio/sms`
  - Verifies `X-Twilio-Signature` (HMAC-SHA1 over URL + sorted params, `TWILIO_AUTH_TOKEN`); also accepts a shared secret via `?key=` (`TWILIO_WEBHOOK_SECRET`). **Fails closed** (503) if neither is configured.
  - **STOP / opt-out** (`STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPTOUT`) → records `sms:optout:<e164>` in Redis. Every outbound send checks this key first and skips opted-out numbers.
  - **START / resubscribe** (`START, YES, UNSTOP`) → clears the opt-out.
  - **HELP / INFO** → replies with TwiML:
    `JKISSLLC support: Call 817-909-4312 or visit jkissllc.com. Reply STOP to opt out.`
    No customer record is created and no booking workflow runs.
- **Delivery-status webhook** — `POST /api/webhooks/twilio/status`
  - Verifies `X-Twilio-Signature` (signature only — no secret is placed in the callback URL). Fails closed (503) if `TWILIO_AUTH_TOKEN` is unset.
  - Records `queued/sent/delivered/undelivered/failed` per `MessageSid` (idempotent), correlates to a booking when the SID is in the message ledger, and raises the existing owner alert on a first-time `failed`/`undelivered` (never for a message sent to the owner's own alert number, to avoid loops).
- **Outbound sends** attach `StatusCallback = ${PUBLIC_BASE_URL}/api/webhooks/twilio/status`. If no base origin (`PUBLIC_BASE_URL` / `NEXT_PUBLIC_SITE_URL`) is configured, the message still sends but without delivery tracking, and a structured warning is logged. **No URL is invented.**

## Required configuration

| Setting | Where | Purpose |
|---|---|---|
| `TWILIO_AUTH_TOKEN` | env | Verifies BOTH webhooks' `X-Twilio-Signature`. Required even when sends use API-key auth, because Twilio signs callbacks with the account auth token. |
| `PUBLIC_BASE_URL` = `https://www.jkissllc.com` | env | Origin used to build + verify the StatusCallback URL. **Without it, delivery callbacks are not attached.** |
| Inbound webhook | Twilio Console → Messaging Service → Integration → "A message comes in" → `https://www.jkissllc.com/api/webhooks/twilio/sms` | STOP/START/HELP + reply capture. |
| Status callback | Attached per-message by the app (no console step) | Delivery receipts. A Messaging Service-level status callback is **not** required and should be left unset to avoid duplicate ingestion. |

## HELP: choose ONE responder (avoid duplicate replies)

The application-level HELP responder works independently. Twilio Messaging Services also
have **Advanced Opt-Out**, which can auto-respond to HELP with its own configured message.
If BOTH are active, a customer texting HELP receives **two** replies.

**Recommended configuration — application handles HELP:**

- In Twilio Console → Messaging Service → **Opt-Out Management**:
  - Keep **STOP/START opt-out keyword management ENABLED** (Twilio's carrier-level opt-out is a compliance backstop; our app also tracks opt-out, so the two are complementary, not conflicting — both simply prevent sends to an opted-out number).
  - **Disable the HELP auto-response** (clear/blank the HELP reply, or turn off HELP handling) so only the application replies to HELP/INFO. This keeps the HELP copy in one place (versioned in code) and prevents double replies.

Alternative — **Twilio handles HELP**: enable Twilio's HELP auto-response and remove the
app-level HELP reply. Not recommended: the copy then lives in the console (unversioned)
and can drift from the site's support details.

Either way: **do not enable both.**

## Note on STOP

STOP is intentionally handled in **both** places (Twilio Advanced Opt-Out + the app's
`sms:optout` list). These do not produce duplicate replies — Twilio sends at most its
single opt-out confirmation, and the app does not reply to STOP. Both independently stop
future sends, which is the desired defense-in-depth.
