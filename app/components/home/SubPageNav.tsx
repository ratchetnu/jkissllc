import Link from 'next/link';

/**
 * Fixed nav for standalone pages (/about, /opspilot). The homepage's SiteNav is
 * scroll-aware and anchored to on-page sections; off the homepage those anchors
 * need the root prefix, and the transparent-until-scrolled treatment doesn't work
 * over a non-hero page top. So: same visual language, always solid.
 */
const LINKS: [string, string][] = [
  ['Services', '/#services'],
  ['About', '/about'],
  ['OpsPilot', '/opspilot'],
  ['Coverage', '/#coverage'],
  ['Contact', '/#contact'],
];

export default function SubPageNav() {
  return (
    <div
      className="fixed top-0 left-0 right-0 z-50"
      style={{ background: 'rgba(11,11,12,0.95)', backdropFilter: 'blur(12px)', borderBottom: '1px solid rgba(255,255,255,.08)' }}
    >
      <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
        <Link
          href="/"
          className="text-xl font-black tracking-tight"
          style={{ color: '#fff', letterSpacing: '-0.03em', textDecoration: 'none' }}
        >
          J Kiss <span style={{ color: 'var(--red)' }}>LLC</span>
        </Link>

        <nav className="hidden md:flex items-center gap-8">
          {LINKS.map(([label, href]) => (
            <Link
              key={href}
              href={href}
              className="text-sm font-medium transition hover:text-white"
              style={{ color: 'var(--muted)', textDecoration: 'none' }}
            >
              {label}
            </Link>
          ))}
        </nav>

        <Link href="/quote" className="btn" style={{ padding: '10px 20px', fontSize: 13 }}>
          Get My Quote
        </Link>
      </div>
    </div>
  );
}
