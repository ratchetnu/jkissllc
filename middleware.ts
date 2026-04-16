import { NextRequest, NextResponse } from 'next/server'

// Redirect apex domain (jkissllc.com) → www.jkissllc.com to match the canonical URL.
// This also consolidates SEO signals on a single origin.
export function middleware(request: NextRequest) {
  const host = request.headers.get('host') ?? ''

  if (host === 'jkissllc.com') {
    const url = new URL(request.url)
    url.host = 'www.jkissllc.com'
    return NextResponse.redirect(url, 308)
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    // Run on every request except Next internals and static assets.
    '/((?!_next/|_static/|_vercel|favicon.ico|robots.txt|sitemap.xml|.*\\..*).*)',
  ],
}
