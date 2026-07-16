'use client';

import { useEffect, useState } from 'react';
import { COMPANY } from '../../lib/company';

const LINKS: [string, string][] = [
  ['Services', '#services'],
  ['How it works', '#how'],
  ['Coverage', '#coverage'],
  ['Operion', '/operion'],
  ['Reviews', '/reviews'],
  ['Track', '/track'],
];

export default function SiteNav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className="fixed top-0 left-0 right-0 z-50 transition-all duration-300"
      style={{
        background: scrolled ? 'rgba(11,11,12,0.95)' : 'transparent',
        backdropFilter: scrolled ? 'blur(12px)' : 'none',
        borderBottom: scrolled ? '1px solid rgba(255,255,255,.08)' : '1px solid transparent',
      }}
    >
      <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
        <a href="#top" className="text-xl font-black tracking-tight" style={{ color: '#fff', letterSpacing: '-0.03em' }}>
          {COMPANY.nameLead} <span style={{ color: 'var(--red)' }}>{COMPANY.nameAccent}</span>
        </a>

        <nav className="hidden md:flex items-center gap-7">
          {LINKS.map(([label, href]) => (
            <a key={href} href={href} className="text-sm font-medium transition hover:text-white" style={{ color: 'var(--muted)' }}>{label}</a>
          ))}
        </nav>

        <div className="hidden md:flex items-center gap-4">
          <a href="/careers" className="btn-ghost" style={{ padding: '10px 18px', fontSize: '13px' }}>Apply Now</a>
          <a href="/quote" className="btn" style={{ padding: '10px 20px', fontSize: '13px' }}>Get My Quote</a>
        </div>

        <button
          className="md:hidden flex flex-col items-center justify-center gap-1.5 p-2"
          style={{ minWidth: 44, minHeight: 44 }}
          onClick={() => setOpen(!open)}
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
        >
          <span className="block w-6 h-0.5 bg-white transition-all" style={{ transform: open ? 'rotate(45deg) translate(4px, 4px)' : 'none' }} />
          <span className="block w-6 h-0.5 bg-white transition-all" style={{ opacity: open ? 0 : 1 }} />
          <span className="block w-6 h-0.5 bg-white transition-all" style={{ transform: open ? 'rotate(-45deg) translate(4px, -4px)' : 'none' }} />
        </button>
      </div>

      {open && (
        <div className="md:hidden px-6 pb-6 flex flex-col gap-4" style={{ background: 'rgba(11,11,12,0.98)' }}>
          {([
            ['Services', '#services'], ['How it works', '#how'], ['Coverage', '#coverage'],
            ['Operion — our platform', '/operion'],
            ['Track a job', '/track'], ['Reviews', '/reviews'], ['Safety / FMCSA', '/safety'], ['Request COI', '/coi'],
          ] as [string, string][]).map(([label, href]) => (
            <a key={href} href={href} className="text-base font-medium py-2" style={{ color: 'var(--muted)' }} onClick={() => setOpen(false)}>{label}</a>
          ))}
          <a href="/careers" className="text-base font-bold py-2" style={{ color: '#ff6680' }} onClick={() => setOpen(false)}>Careers — We&apos;re Hiring</a>
          <a href="/start-your-carrier" className="text-base font-bold py-2" style={{ color: '#ff6680' }} onClick={() => setOpen(false)}>Start a Carrier (Guide)</a>
          <a href="/admin/bookings" className="text-base font-medium py-2" style={{ color: 'var(--muted)' }} onClick={() => setOpen(false)}>Admin Login</a>
          <a href="/quote" className="btn mt-2" onClick={() => setOpen(false)}>Get My Quote</a>
        </div>
      )}
    </header>
  );
}
