// Inbound SMS keyword handling, shared by the Twilio inbound webhook and its tests.
// Pure — no I/O — so keyword classification and the HELP reply can be unit-tested
// without Redis or a live request.

export const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT'])
export const START_WORDS = new Set(['START', 'YES', 'UNSTOP'])
export const HELP_WORDS = new Set(['HELP', 'INFO'])

export type InboundKeyword = 'stop' | 'start' | 'help' | 'none'

// Normalize an inbound body to a single comparable keyword. Safe on undefined/empty:
// trims surrounding whitespace and matches case-insensitively. STOP takes precedence,
// then START, then HELP/INFO; anything else is a normal message ('none').
export function classifyInboundKeyword(body: string | undefined | null): InboundKeyword {
  const kw = (body ?? '').trim().toUpperCase()
  if (!kw) return 'none'
  if (STOP_WORDS.has(kw)) return 'stop'
  if (START_WORDS.has(kw)) return 'start'
  if (HELP_WORDS.has(kw)) return 'help'
  return 'none'
}

// The HELP/INFO auto-reply. Concise, exposes no internal system details, points to
// public support channels, and restates the STOP opt-out. Fixed copy for carrier
// consistency (contains no XML-special characters, so it is TwiML-safe as-is).
export const HELP_REPLY = 'JKISSLLC support: Call 817-909-4312 or visit jkissllc.com. Reply STOP to opt out.'

export function helpTwiml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${HELP_REPLY}</Message></Response>`
}
