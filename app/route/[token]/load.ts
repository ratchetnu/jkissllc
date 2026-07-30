// ─────────────────────────────────────────────────────────────────────────────
// Loading the public route link — and telling "this link is dead" apart from
// "your signal dropped".
//
// THE BUG THIS EXISTS TO PREVENT. The page used to `catch` a failed read and fall
// through to a render guard of `notFound || !route`, so ANY failure — a dropped
// connection, an exhausted retry, a 503 — showed a contractor the words "Link not
// found · This confirmation link isn't valid. It may have been mistyped." On a
// surface where the token is the only way that person can work, telling them their
// link is invalid because they walked into a basement is the worst thing this
// screen can do.
//
// `not_found` is now reserved for an ACTUAL 404 from the server. Everything else —
// a thrown fetch, retry exhaustion, 408/425/429, any 5xx, any other non-OK status,
// or an unreadable body — is a connection/service error that keeps whatever route
// details are already on screen.
//
// Split out of page.tsx so these rules are behaviourally testable with an injected
// fetcher instead of only asserted against source text.
// ─────────────────────────────────────────────────────────────────────────────

import { fetchWithRetry, type FetchRetryOptions } from '../../portal/network'

export type PublicRoute = {
  token: string
  routeNumber: string
  status: string
  businessName: string
  contactPerson?: string
  contactPhone?: string
  reportAddress: string
  reportTime: string
  routeDate: string
  description?: string
  payRate?: string   // THIS crew member's own pay, and only if the owner enabled it
  vehicle?: string
  dispatchReady: boolean
  dispatchHold?: 'crew' | 'equipment'
  specialNotes?: string
  assignedStaffName?: string
  confirmedAt?: number
  declinedAt?: number
  completedAt?: number
  completionNote?: string
  completionPhotos?: string[]
  clockInAt?: number
  clockOutAt?: number
  timeclock?: boolean
  expired: boolean
}

/** What one attempt to load the link produced. */
export type RouteLoadOutcome =
  | { kind: 'ok'; route: PublicRoute; disclaimer: string }
  /** The server said 404 — unknown, malformed, revoked, or another tenant's token. */
  | { kind: 'not_found' }
  /** Anything else. Never renders as a missing link. */
  | { kind: 'error'; message: string }

export const CONNECTION_ERROR =
  'Could not reach the server. Check your connection and try again.'
export const SERVICE_ERROR =
  'The server is having trouble right now. Please try again in a moment.'

/**
 * Fetch the link once (with the shared bounded read retry) and classify the result.
 *
 * Only a literal 404 yields `not_found`. Retry exhaustion returns the last response,
 * so a 503 that never recovered arrives here as a non-OK status and is classified as
 * a service error — not as a dead link.
 */
export async function loadPublicRoute(
  token: string,
  opts: Pick<FetchRetryOptions, 'fetcher' | 'sleep' | 'onRetry'> = {},
): Promise<RouteLoadOutcome> {
  let res: Response
  try {
    res = await fetchWithRetry(`/api/route/${token}`, { cache: 'no-store' }, opts)
  } catch {
    // Thrown = the request never completed: offline, DNS, TLS, abort, or the retry
    // budget ran out on a connection that kept failing.
    return { kind: 'error', message: CONNECTION_ERROR }
  }

  if (res.status === 404) return { kind: 'not_found' }
  if (!res.ok) return { kind: 'error', message: SERVICE_ERROR }

  try {
    const d = await res.json()
    if (!d || typeof d !== 'object' || !d.route) return { kind: 'error', message: SERVICE_ERROR }
    return { kind: 'ok', route: d.route as PublicRoute, disclaimer: String(d.disclaimer ?? '') }
  } catch {
    // A 200 whose body could not be read is a service problem, not a missing link.
    return { kind: 'error', message: SERVICE_ERROR }
  }
}

/** The three pieces of view state a load can move. */
export type RouteViewState = {
  route: PublicRoute | null
  notFound: boolean
  loadError: string
}

export const INITIAL_VIEW_STATE: RouteViewState = { route: null, notFound: false, loadError: '' }

/**
 * Fold an outcome into the view state.
 *
 * The rule that matters: an `error` NEVER clears `route`. A contractor who already
 * has their route on screen keeps reading it when the connection drops; the error is
 * additive and non-blocking, with a Retry beside it.
 */
export function applyLoadOutcome(prev: RouteViewState, outcome: RouteLoadOutcome): RouteViewState {
  switch (outcome.kind) {
    case 'ok':
      return { route: outcome.route, notFound: false, loadError: '' }
    case 'not_found':
      // A real 404 on reload means the token stopped being valid — say so plainly.
      return { route: null, notFound: true, loadError: '' }
    case 'error':
      return { route: prev.route, notFound: prev.notFound, loadError: outcome.message }
  }
}
