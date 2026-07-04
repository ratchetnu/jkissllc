'use client';

import { useEffect, useRef } from 'react';
import { Phone } from 'lucide-react';

/** Scroll-progress bar + a sticky mobile Quote/Call bar. */
export default function SiteChrome() {
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onScroll = () => {
      const el = bar.current;
      if (!el) return;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      el.style.transform = `scaleX(${max > 0 ? window.scrollY / max : 0})`;
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  return (
    <>
      <div ref={bar} className="scroll-progress" style={{ width: '100%', transform: 'scaleX(0)' }} />

      {/* Sticky mobile Quote + Call bar */}
      <div className="sticky-cta md:hidden">
        <a href="/quote" className="btn" style={{ flex: 1, justifyContent: 'center', padding: '14px' }}>Get My Quote</a>
        <a
          href="tel:+18179094312"
          className="btn-ghost"
          aria-label="Call J Kiss LLC"
          style={{ padding: '14px 18px', justifyContent: 'center' }}
        >
          <Phone size={18} aria-hidden />
        </a>
      </div>
    </>
  );
}
