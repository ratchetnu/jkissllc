import Link from 'next/link';
import { ClipboardList, CalendarClock, MessageSquare, CheckCircle2, ArrowRight } from 'lucide-react';
import Reveal from '../Reveal';

const STEPS = [
  {
    icon: ClipboardList,
    title: 'Tell us the job',
    body: 'Answer a few quick questions or send photos. Get an honest estimate range in seconds — no waiting on a callback.',
  },
  {
    icon: CalendarClock,
    title: 'Pick your window',
    body: 'Choose the date and arrival window that fits your schedule, and lock it in with a small deposit.',
  },
  {
    icon: MessageSquare,
    title: 'We keep you posted',
    body: 'Follow your job from dispatch to done — Scheduled, On The Way, Crew On Site, Complete. You are never left wondering.',
  },
  {
    icon: CheckCircle2,
    title: 'Done & documented',
    body: 'We finish, haul off, and send a clean invoice and receipt. The number we quote is the number you pay — barring changes you approve first.',
  },
];

/** Light "How It Works" — the logistics-you-can-see promise, tied to /track. */
export default function HowItWorks() {
  return (
    <section id="how" className="section section-alt">
      <div className="wrap">
        <Reveal><span className="eyebrow">Logistics you can see</span></Reveal>
        <Reveal as="h2" delay={70} className="display-2" style={{ marginTop: 16, maxWidth: '20ch' }}>
          Booking to done, in full view.
        </Reveal>
        <Reveal as="p" delay={130} className="lede" style={{ marginTop: 16, maxWidth: '54ch' }}>
          The stressful part of hauling is not knowing what is happening. We built the whole process
          to be visible — so you always know exactly where your job stands.
        </Reveal>

        <div style={{ marginTop: 48, display: 'grid', gap: 18, gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))' }}>
          {STEPS.map((s, i) => (
            <Reveal key={s.title} delay={i * 70}>
              <div className="card-light" style={{ padding: 26, height: '100%', display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div
                    aria-hidden
                    style={{ width: 46, height: 46, borderRadius: 13, display: 'grid', placeItems: 'center', background: 'rgba(224,0,42,.08)', border: '1px solid rgba(224,0,42,.16)', color: 'var(--red)' }}
                  >
                    <s.icon size={21} />
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 30, fontWeight: 700, color: 'var(--surface-3)', lineHeight: 1 }}>
                    {String(i + 1).padStart(2, '0')}
                  </span>
                </div>
                <h3 className="display-2" style={{ fontSize: '1.18rem', marginTop: 18 }}>{s.title}</h3>
                <p style={{ color: 'var(--ink-muted)', fontSize: 14.5, lineHeight: 1.55, marginTop: 10, flex: 1 }}>{s.body}</p>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal delay={120} style={{ marginTop: 28 }}>
          <Link href="/track" className="btn-ghost-ink" style={{ display: 'inline-flex' }}>
            Track a job <ArrowRight size={16} aria-hidden />
          </Link>
        </Reveal>
      </div>
    </section>
  );
}
