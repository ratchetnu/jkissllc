import { NextRequest, NextResponse } from 'next/server'
import { COOKIE_NAME, slideSessionToken, setSessionCookie, getPrincipalFromToken } from './app/api/admin/_lib/session'
import { isStaffRole } from './app/lib/rbac'

// Renamed from `middleware.ts` — Next 16 deprecated that file convention in favour
// of `proxy.ts` (same API, same matcher, just a clearer name). Behavior unchanged.
//
// Redirect apex domain (jkissllc.com) → www.jkissllc.com to match the canonical URL.
// This also consolidates SEO signals on a single origin.
export async function proxy(request: NextRequest) {
  const host = request.headers.get('host') ?? ''

  if (host === 'jkissllc.com') {
    const url = new URL(request.url)
    url.host = 'www.jkissllc.com'
    return NextResponse.redirect(url, 308)
  }

  // Anti-spoofing: strip any client-supplied tenant header before the request
  // reaches a handler. Tenant identity is ALWAYS derived server-side from the
  // signed session (see requireTenantSession), never trusted from the wire.
  const requestHeaders = new Headers(request.headers)
  requestHeaders.delete('x-tenant-id')
  const res = NextResponse.next({ request: { headers: requestHeaders } })

  const path = request.nextUrl.pathname
  const isAdminRequest = path.startsWith('/admin') || path.startsWith('/api/admin')
  const isPortalRequest = path.startsWith('/portal') || path.startsWith('/api/portal')
  const isCookieRoute =
    path === '/api/admin/auth' || path === '/api/admin/logout' || path === '/api/auth/login'

  const token = request.cookies.get(COOKIE_NAME)?.value

  // ── RBAC choke point ──
  // Crew principals must never reach the admin/operations surface. This is a
  // central, server-side block (the token's signed `role` claim is authoritative
  // and un-forgeable). Route-level guards remain as defense in depth, but this
  // stops a crew session at the door regardless of any missed per-route check.
  if (isAdminRequest && !isCookieRoute && token) {
    try {
      const who = await getPrincipalFromToken(token)
      if (who && !isStaffRole(who.role)) {
        if (path.startsWith('/api/')) {
          return NextResponse.json({ error: 'forbidden' }, { status: 403 })
        }
        return NextResponse.redirect(new URL('/portal', request.url))
      }
    } catch {
      // Fall through — the route's own guard is the source of truth for access.
    }
  }

  // Sliding idle timeout: on any authenticated admin OR portal request, push the
  // session's 10-minute idle window forward (identity preserved — see
  // slideSessionToken). Once requests stop, the token lapses server-side and is
  // rejected, so a stolen/abandoned cookie can't be used past 10 idle minutes.
  if ((isAdminRequest || isPortalRequest) && !isCookieRoute && token) {
    try {
      const refreshed = await slideSessionToken(token)
      if (refreshed) setSessionCookie(res, refreshed)
    } catch {
      // Never let a session-refresh hiccup break the request.
    }
  }

  return res
}

export const config = {
  matcher: [
    // Run on every request except Next internals and static assets.
    '/((?!_next/|_static/|_vercel|favicon.ico|robots.txt|sitemap.xml|.*\\..*).*)',
  ],
}
