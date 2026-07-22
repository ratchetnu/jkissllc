import Image from 'next/image';
import Link from 'next/link';

export default function SitesByNuCredit() {
  return (
    <Link
      href="/#contact"
      aria-label="Need a website? Contact J KISS LLC about Sites By Nu web design"
      className="group"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 14,
        width: '100%',
        maxWidth: 360,
        boxSizing: 'border-box',
        padding: 10,
        borderRadius: 16,
        border: '1px solid rgba(224,0,42,.22)',
        background: 'rgba(255,255,255,.025)',
        color: 'inherit',
        textDecoration: 'none',
      }}
    >
      <Image
        src="/sites-by-nu-jkiss.png"
        alt="Sites By Nu — We Build. You Grow."
        width={1254}
        height={1254}
        sizes="76px"
        style={{ width: 76, height: 76, flex: '0 0 auto', borderRadius: 12 }}
      />
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', color: '#fff', fontSize: 13.5, fontWeight: 800 }}>Need a website?</span>
        <span style={{ display: 'block', marginTop: 4, color: 'var(--muted)', fontSize: 12.5, lineHeight: 1.45 }}>
          Designed by Sites By Nu. Let&apos;s build yours.
        </span>
        <span style={{ display: 'block', marginTop: 6, color: 'var(--red)', fontSize: 12, fontWeight: 750 }}>
          Contact us →
        </span>
      </span>
    </Link>
  );
}
