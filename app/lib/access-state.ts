// ── Access state — what a page should render after a required request answers ──
//
// The defect this exists to prevent: a page fetched its data, the server said 403,
// and the page had nowhere to put that answer. Six admin surfaces therefore sat in a
// permanent skeleton (finance, settings), or showed a red "error" card for what was
// really a permission decision (the AI Command Center), or silently rendered an EMPTY
// section that is indistinguishable from "there is genuinely nothing here"
// (businesses → invoices).
//
// Those are three different truths and a user must be able to tell them apart:
//
//   denied  — the server refused this principal. Authorization working as designed.
//             Terminal: never retried, never a spinner, never an empty list.
//   error   — the request failed for a reason that might not repeat. Retryable.
//   ready   — the request succeeded. Whether the RESULT is empty is a separate
//             question the page answers with its own empty state.
//
// Keeping this a pure function (rather than inline `res.status === 403` at each call
// site) is the point: the mapping is asserted once in tests, and every page that
// consumes it is guaranteed to classify 401/403/500 the same way.

/** What a page should render for a required request. */
export type AccessState = 'ready' | 'denied' | 'error'

/** The full lifecycle a page tracks, including the state before an answer arrives. */
export type LoadState = 'loading' | AccessState

/**
 * Classify an HTTP status from a REQUIRED request.
 *
 * 401 is grouped with 403 deliberately. Inside the admin shell the session is already
 * established, so a 401 from one endpoint means "this principal may not read this",
 * which is the same thing the user needs to be told. The shell — not an inner card —
 * owns the signed-out case.
 */
export function accessStateForStatus(status: number): AccessState {
  if (status === 401 || status === 403) return 'denied'
  if (status >= 400) return 'error'
  return 'ready'
}

/** True when the status means "refused", and so must never be shown as empty or retried. */
export function isDenied(status: number): boolean {
  return accessStateForStatus(status) === 'denied'
}

/**
 * A denied request is terminal. Retrying it produces the same 403, so offering a
 * "Try again" button (or polling) just repeats a decision the server already made.
 */
export function isRetryable(state: AccessState): boolean {
  return state === 'error'
}

/**
 * Whether a page is still waiting. A page must stop waiting once ANY terminal state is
 * known — the permanent-skeleton bug was precisely a page that kept `loading` true
 * because it keyed the spinner off "do I have data yet" instead of "did I get an answer".
 */
export function isResolved(state: LoadState): boolean {
  return state !== 'loading'
}
