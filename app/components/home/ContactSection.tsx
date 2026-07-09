'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { COMPANY } from '../../lib/company';
import { Phone, Mail, User, CheckCircle2 } from 'lucide-react';
import Reveal from '../Reveal';

const SERVICE_OPTIONS = [
  'Junk Removal',
  'Brush & Debris Removal',
  'Appliance Delivery',
  'Furniture Delivery',
  'Box-Truck / Palletized Delivery',
  'Local Moves',
  'Material Runs & Jobsite Debris',
  'Commercial Delivery',
  'Eviction & Property Cleanout',
  'COI Request',
  'Other',
];

const iStyle: CSSProperties = {
  width: '100%', padding: '12px 14px', background: 'rgba(255,255,255,.04)',
  border: '1px solid rgba(255,255,255,.10)', borderRadius: 10, color: '#f3f4f6', fontSize: 14,
};

function ContactForm() {
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [service, setService] = useState('');

  useEffect(() => {
    const preset = new URLSearchParams(window.location.search).get('service');
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing form state from URL on mount
    if (preset) setService(preset);
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus('sending');
    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (res.ok) { setStatus('sent'); form.reset(); }
      else setStatus('error');
    } catch { setStatus('error'); }
  }

  if (status === 'sent') {
    return (
      <div className="glass-card p-8 text-center" style={{ padding: 32 }}>
        <div className="mb-4 flex justify-center"><CheckCircle2 size={44} strokeWidth={1.75} color="#ff6680" /></div>
        <p className="text-lg font-black text-white mb-2">Message sent!</p>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>We&apos;ll get back to you within one business day.</p>
      </div>
    );
  }

  return (
    <div className="glass-card p-8">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Name</label>
            <input name="name" required placeholder="Your name" style={iStyle} />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Company</label>
            <input name="company" placeholder="Company (optional)" style={iStyle} />
          </div>
        </div>
        <div>
          <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Email</label>
          <input name="email" type="email" required placeholder="you@email.com" style={iStyle} />
        </div>
        <div>
          <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Phone</label>
          <input name="phone" type="tel" placeholder="(555) 000-0000" style={iStyle} />
        </div>
        <div>
          <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Service Needed</label>
          <select name="service" value={service} onChange={(e) => setService(e.target.value)} style={{ ...iStyle, cursor: 'pointer' }}>
            <option value="">Select a service</option>
            {SERVICE_OPTIONS.map((o) => <option key={o}>{o}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>Message</label>
          <textarea name="message" rows={4} placeholder="Tell us about your job — what, where, and when…" style={{ ...iStyle, resize: 'vertical' }} />
        </div>
        {status === 'error' && <p className="text-sm text-red-400">Something went wrong. Please email us directly at {COMPANY.email}</p>}
        <button type="submit" disabled={status === 'sending'} className="btn w-full" style={{ justifyContent: 'center' }}>
          {status === 'sending' ? 'Sending…' : 'Send Message'}
        </button>
        <p className="text-xs" style={{ color: 'rgba(255,255,255,.4)' }}>
          Prefer an instant price? <a href="/quote" style={{ color: '#ff6680', fontWeight: 600 }}>Build a quote →</a>
        </p>
      </form>
    </div>
  );
}

/** Dark Contact band — info column + message form (posts to /api/contact). */
export default function ContactSection() {
  return (
    <section id="contact" className="section section-dark">
      <div className="wrap">
        <div className="grid md:grid-cols-2 gap-16">
          <Reveal>
            <span className="eyebrow">Get in touch</span>
            <h2 className="display-2" style={{ color: '#fff', marginTop: 16 }}>
              Have a job in mind?
            </h2>
            <p className="lede" style={{ marginTop: 16, maxWidth: '44ch' }}>
              Tell us what you need — junk removal, a cleanout, delivery, or a commercial run — and we&apos;ll
              get back to you within one business day. For insurance certificates, choose &quot;COI Request.&quot;
            </p>
            <div className="space-y-4" style={{ marginTop: 28 }}>
              <a href={`tel:${COMPANY.phoneE164}`} className="flex items-center gap-3 text-base font-bold text-white transition hover:opacity-80">
                <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--red)' }}><Phone size={17} strokeWidth={2} color="#fff" /></span>
                Call or text {COMPANY.phoneDisplay}
              </a>
              <a href={`mailto:${COMPANY.email}`} className="flex items-center gap-3 text-sm font-medium transition hover:text-white" style={{ color: 'var(--muted)' }}>
                <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'rgba(224,0,42,.12)', border: '1px solid rgba(224,0,42,.25)' }}><Mail size={17} strokeWidth={1.75} color="#ff6680" /></span>
                {COMPANY.email}
              </a>
              <a href={`mailto:${COMPANY.ownerEmail}`} className="flex items-center gap-3 text-sm font-medium transition hover:text-white" style={{ color: 'var(--muted)' }}>
                <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'rgba(224,0,42,.12)', border: '1px solid rgba(224,0,42,.25)' }}><User size={17} strokeWidth={1.75} color="#ff6680" /></span>
                {COMPANY.ownerEmail}
              </a>
            </div>
          </Reveal>

          <Reveal delay={100}><ContactForm /></Reveal>
        </div>
      </div>
    </section>
  );
}
