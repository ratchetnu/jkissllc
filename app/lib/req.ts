import type { NextRequest } from 'next/server'

export function getIP(req: NextRequest): string {
  return (
    req.headers.get('x-vercel-forwarded-for')?.split(',')[0].trim() ||
    req.headers.get('x-real-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    'unknown'
  )
}

export function getUA(req: NextRequest): string {
  return (req.headers.get('user-agent') ?? 'unknown').slice(0, 400)
}
