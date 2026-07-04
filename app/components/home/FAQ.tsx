'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import Reveal from '../Reveal';

const FAQS = [
  {
    q: 'How fast can you come out?',
    a: 'Same-day and next-day slots are available for most junk removal and brush jobs when a window is open. Deliveries and moves are scheduled to a window that fits your day — and we text you before we roll.',
  },
  {
    q: 'How does pricing work?',
    a: 'For junk removal, brush, and cleanouts you get an instant range based on how much fills the truck and how many disposal trips it takes. Deliveries and moves are quoted on distance and load. Disposal is included, and there are no hidden fees — the number we quote is the number you pay, barring changes you approve.',
  },
  {
    q: 'Do you haul it away and dispose of it?',
    a: 'Yes. We load it, haul it, and dispose of it responsibly — recycling and donating where we can. You don’t lift a thing or make a single dump run.',
  },
  {
    q: 'What areas do you cover?',
    a: 'The Dallas–Fort Worth metroplex and the surrounding cities. Don’t see yours? Ask — we can often still help.',
  },
  {
    q: 'Are you licensed and insured?',
    a: 'Fully licensed and insured. US DOT 3484556 · MC 01155352. You’re covered before we ever lift a thing.',
  },
  {
    q: 'Do I need to be home?',
    a: 'For most jobs, no — as long as we can access the items and you’ve confirmed the details. Either way, we keep you updated by text from dispatch to done.',
  },
  {
    q: 'Can you handle stairs, tight spaces, or heavy items?',
    a: 'Yes. Just tell us in the quote so we bring the right crew size and equipment — that’s exactly what the questions and photo step are for.',
  },
  {
    q: 'How do I pay, and is a deposit required?',
    a: 'You can lock your window online with a small deposit; the balance is due at completion. We accept cards, and you get a clean invoice and receipt when the job is done.',
  },
];

/** Light FAQ accordion. */
export default function FAQ() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section className="section section-alt">
      <div className="wrap-narrow">
        <Reveal style={{ textAlign: 'center' }}>
          <span className="eyebrow" style={{ justifyContent: 'center' }}>Good questions</span>
        </Reveal>
        <Reveal as="h2" delay={70} className="display-2" style={{ marginTop: 16, textAlign: 'center' }}>
          Everything you’re wondering.
        </Reveal>

        <div style={{ marginTop: 40 }}>
          {FAQS.map((f, i) => {
            const isOpen = open === i;
            return (
              <Reveal key={f.q} delay={Math.min(i, 6) * 40}>
                <div className={isOpen ? 'faq-open' : ''} style={{ borderTop: i === 0 ? '1px solid var(--line-ink)' : undefined, borderBottom: '1px solid var(--line-ink)' }}>
                  <button
                    className="faq-q"
                    aria-expanded={isOpen}
                    aria-controls={`faq-panel-${i}`}
                    id={`faq-q-${i}`}
                    onClick={() => setOpen(isOpen ? null : i)}
                  >
                    <span>{f.q}</span>
                    <Plus className="faq-icon" size={20} aria-hidden />
                  </button>
                  <div className="faq-a" id={`faq-panel-${i}`} role="region" aria-labelledby={`faq-q-${i}`}>
                    <div>
                      <p style={{ color: 'var(--ink-muted)', fontSize: 15, lineHeight: 1.6, paddingBottom: 22, maxWidth: '62ch' }}>{f.a}</p>
                    </div>
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
