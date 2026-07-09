'use client'

import { useEffect } from 'react'
import { COMPANY } from './lib/company';
import Link from 'next/link'

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Surface to the console / Vercel logs; never show the raw message to users.
    console.error('[app error]', error)
  }, [error])

  return (
    <main className="flex min-h-screen items-center justify-center px-6" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <div className="glass-card max-w-md w-full p-10 text-center" style={{ borderRadius: '22px' }}>
        <p className="text-5xl">⚠️</p>
        <h1 className="text-2xl font-black text-white mt-3" style={{ letterSpacing: '-0.03em' }}>Something went wrong</h1>
        <p className="text-sm mt-3 leading-relaxed" style={{ color: 'var(--muted)' }}>
          A hiccup on our end — it&apos;s been logged. Try again, or head back home.
        </p>
        <div className="mt-7 flex gap-3 justify-center flex-wrap">
          <button onClick={reset} className="btn" style={{ padding: '12px 22px', fontSize: '14px' }}>Try Again</button>
          <Link href="/" className="btn-ghost" style={{ padding: '12px 22px', fontSize: '14px' }}>← Back to Home</Link>
        </div>
        <p className="text-xs mt-6" style={{ color: 'rgba(255,255,255,.3)' }}>
          Still stuck? Call or text <a href={"tel:" + COMPANY.phoneE164} style={{ color: 'var(--muted)' }}>{COMPANY.phoneDisplay}</a>
        </p>
      </div>
    </main>
  )
}
