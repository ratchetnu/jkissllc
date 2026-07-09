import Link from 'next/link'
import { COMPANY } from './lib/company';

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <div className="glass-card max-w-md w-full p-10 text-center" style={{ borderRadius: '22px' }}>
        <p className="text-6xl font-black" style={{ color: 'var(--red)', letterSpacing: '-0.04em' }}>404</p>
        <h1 className="text-2xl font-black text-white mt-3" style={{ letterSpacing: '-0.03em' }}>Page not found</h1>
        <p className="text-sm mt-3 leading-relaxed" style={{ color: 'var(--muted)' }}>
          The page you&apos;re looking for moved or never existed. Let&apos;s get you back on track.
        </p>
        <div className="mt-7 flex gap-3 justify-center flex-wrap">
          <Link href="/" className="btn" style={{ padding: '12px 22px', fontSize: '14px' }}>← Back to Home</Link>
          <Link href="/quote" className="btn-ghost" style={{ padding: '12px 22px', fontSize: '14px' }}>Get a Quote</Link>
        </div>
        <p className="text-xs mt-6" style={{ color: 'rgba(255,255,255,.3)' }}>
          Need help? Call or text <a href={"tel:" + COMPANY.phoneE164} style={{ color: 'var(--muted)' }}>{COMPANY.phoneDisplay}</a>
        </p>
      </div>
    </main>
  )
}
