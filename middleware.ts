import { NextRequest, NextResponse } from 'next/server'
import { COOKIE_NAME, slideSessionToken, setSessionCookie } from './app/api/admin/_lib/session'

// Redirect apex domain (jkissllc.com) → www.jkissllc.com to match the canonical URL.
// This also consolidates SEO signals on a single origin.
export async function middleware(request: NextRequest) {
  const host = request.headers.get('host') ?? ''

  if (host === 'jkissllc.com') {
    const url = new URL(request.url)
    url.host = 'www.jkissllc.com'
    return NextResponse.redirect(url, 308)
  }

  const res = NextResponse.next()

  // Sliding idle timeout: on any authenticated admin request, push the session's
  // 10-minute idle window forward. Once requests stop, the token lapses server-
  // side and verifySessionToken rejects it — so a stolen/abandoned cookie can't
  // be used past 10 idle minutes. Auth/logout manage the cookie themselves.
  const path = request.nextUrl.pathname
  const isAdminRequest = path.startsWith('/admin') || path.startsWith('/api/admin')
  const isCookieRoute = path === '/api/admin/auth' || path === '/api/admin/logout'
  if (isAdminRequest && !isCookieRoute) {
    const token = request.cookies.get(COOKIE_NAME)?.value
    if (token) {
      try {
        const refreshed = await slideSessionToken(token)
        if (refreshed) setSessionCookie(res, refreshed)
      } catch {
        // Never let a session-refresh hiccup break the request — the route's own
        // requireSession check remains the source of truth for access.
      }
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
