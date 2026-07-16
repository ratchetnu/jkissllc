'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import Reveal from '../Reveal';
import { OPERION_FAQ } from '../../lib/operion-faq';

/**
 * Operion FAQ — dark accordion. Questions/answers come from lib/operion-faq (a
 * plain, non-client module), so the SAME strings feed both this accordion and the
 * page's FAQPage JSON-LD — the structured data can never drift from the screen.
 */
export default function OperionFAQ() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <div className="wrap-narrow" style={{ padding: 0 }}>
      {OPERION_FAQ.map((f, i) => {
        const isOpen = open === i;
        return (
          <Reveal key={f.q} delay={Math.min(i, 6) * 40}>
            <div className={isOpen ? 'faq-open' : ''} style={{ borderTop: i === 0 ? '1px solid var(--line)' : undefined, borderBottom: '1px solid var(--line)' }}>
              <button
                className="faq-q"
                style={{ color: '#fff' }}
                aria-expanded={isOpen}
                aria-controls={`ofaq-panel-${i}`}
                id={`ofaq-q-${i}`}
                onClick={() => setOpen(isOpen ? null : i)}
              >
                <span>{f.q}</span>
                <Plus className="faq-icon" size={20} aria-hidden style={{ color: 'var(--ops-steel)' }} />
              </button>
              <div className="faq-a" id={`ofaq-panel-${i}`} role="region" aria-labelledby={`ofaq-q-${i}`}>
                <div>
                  <p style={{ color: 'var(--muted)', fontSize: 15, lineHeight: 1.65, paddingBottom: 22, maxWidth: '66ch' }}>{f.a}</p>
                </div>
              </div>
            </div>
          </Reveal>
        );
      })}
    </div>
  );
}
