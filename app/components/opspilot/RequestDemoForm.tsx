'use client';

import { useId, useState } from 'react';
import { track } from '@vercel/analytics';
import { ArrowRight, Check } from 'lucide-react';

type Status = 'idle' | 'sending' | 'done' | 'error';

const INDUSTRIES = [
  'Junk Removal',
  'Moving',
  'Delivery & Freight',
  'Estate Cleanouts',
  'Property Turnovers',
  'Field Services',
  'Other',
];

const TEAM_SIZES = ['Just me', '2–5', '6–15', '16–50', '50+'];

const MODULES = [
  'Booking & customer intake',
  'AI-assisted photo analysis',
  'Routes & dispatch',
  'Crew & contractor portal',
  'Contractor pay & statements',
  'Claims & cost recovery',
  'Messaging & notifications',
  'Analytics & owner visibility',
];

/**
 * Operion "Request a Demo" capture — the qualified sibling of EarlyAccessForm.
 *
 * Posts to /api/operion/demo, which applies the same rate-limit + bot-check +
 * server-side validation as every other public form, stores a durable record,
 * and notifies the owner. Only field-shape events reach analytics — never the
 * contents a business types.
 */
export default function RequestDemoForm({ source = '/operion' }: { source?: string }) {
  const uid = useId();
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const [interests, setInterests] = useState<string[]>([]);
  const [started, setStarted] = useState(false);

  function markStarted() {
    if (!started) {
      setStarted(true);
      track('operion_demo_started');
    }
  }

  function toggleInterest(m: string) {
    markStarted();
    setInterests(prev => (prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m]));
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status === 'sending') return;
    setStatus('sending');
    setError('');

    const fd = new FormData(e.currentTarget);
    const payload = {
      businessName: String(fd.get('businessName') || ''),
      contactName: String(fd.get('contactName') || ''),
      email: String(fd.get('email') || ''),
      phone: String(fd.get('phone') || ''),
      industry: String(fd.get('industry') || ''),
      teamSize: String(fd.get('teamSize') || ''),
      currentTools: String(fd.get('currentTools') || ''),
      challenge: String(fd.get('challenge') || ''),
      message: String(fd.get('message') || ''),
      interests,
      source,
    };

    try {
      const res = await fetch('/api/operion/demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
      setStatus('done');
      track('operion_demo_submitted', { industry: payload.industry || 'unspecified' });
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    }
  }

  if (status === 'done') {
    return (
      <div
        role="status"
        className="glass-card"
        style={{ padding: 'clamp(24px, 4vw, 36px)', display: 'flex', gap: 16, alignItems: 'flex-start' }}
      >
        <span className="ops-icon" style={{ flexShrink: 0 }}>
          <Check size={18} />
        </span>
        <div>
          <h3 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '1.25rem', color: '#fff', letterSpacing: '-0.02em' }}>
            Request received.
          </h3>
          <p style={{ color: 'var(--muted)', fontSize: 14.5, lineHeight: 1.6, marginTop: 8, maxWidth: '46ch' }}>
            Thanks — someone from J KISS will reach out to walk you through Operion and understand how your
            operation runs. No obligation, no automated drip.
          </p>
        </div>
      </div>
    );
  }

  const label: React.CSSProperties = {
    display: 'block',
    fontFamily: 'var(--font-mono)',
    fontSize: 11.5,
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--ops-steel-dim)',
    marginBottom: 7,
  };
  const field: React.CSSProperties = {
    width: '100%',
    padding: '12px 14px',
    borderRadius: 11,
    fontSize: 14.5,
    outline: 'none',
    color: 'var(--text)',
    background: 'rgba(255,255,255,.04)',
    border: '1px solid rgba(255,255,255,.12)',
  };

  return (
    <form onSubmit={submit} onChange={markStarted} noValidate>
      <div style={{ display: 'grid', gap: 18, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
        <div>
          <label htmlFor={`${uid}-biz`} style={label}>Business name *</label>
          <input id={`${uid}-biz`} name="businessName" required maxLength={200} autoComplete="organization" style={field} placeholder="Acme Hauling" />
        </div>
        <div>
          <label htmlFor={`${uid}-name`} style={label}>Your name *</label>
          <input id={`${uid}-name`} name="contactName" required maxLength={200} autoComplete="name" style={field} placeholder="Jordan Rivera" />
        </div>
        <div>
          <label htmlFor={`${uid}-email`} style={label}>Email *</label>
          <input id={`${uid}-email`} name="email" type="email" required autoComplete="email" style={field} placeholder="you@company.com" />
        </div>
        <div>
          <label htmlFor={`${uid}-phone`} style={label}>Phone</label>
          <input id={`${uid}-phone`} name="phone" type="tel" maxLength={40} autoComplete="tel" style={field} placeholder="(555) 123-4567" />
        </div>
        <div>
          <label htmlFor={`${uid}-industry`} style={label}>Industry</label>
          <select id={`${uid}-industry`} name="industry" style={{ ...field, appearance: 'auto' }} defaultValue="">
            <option value="" disabled>Select one…</option>
            {INDUSTRIES.map(i => <option key={i} value={i}>{i}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${uid}-team`} style={label}>Team size</label>
          <select id={`${uid}-team`} name="teamSize" style={{ ...field, appearance: 'auto' }} defaultValue="">
            <option value="" disabled>Select one…</option>
            {TEAM_SIZES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        <label htmlFor={`${uid}-tools`} style={label}>What are you running the operation on today?</label>
        <input id={`${uid}-tools`} name="currentTools" maxLength={400} style={field} placeholder="Spreadsheets, group texts, paper schedules…" />
      </div>

      <fieldset style={{ marginTop: 22, border: 'none', padding: 0, margin: '22px 0 0' }}>
        <legend style={{ ...label, marginBottom: 12 }}>What are you most interested in?</legend>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 9 }}>
          {MODULES.map(m => {
            const on = interests.includes(m);
            return (
              <button
                type="button"
                key={m}
                onClick={() => toggleInterest(m)}
                aria-pressed={on}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '9px 14px',
                  borderRadius: 100,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  color: on ? '#0b0b0c' : 'var(--muted)',
                  background: on ? 'var(--ops-steel)' : 'rgba(255,255,255,.04)',
                  border: `1px solid ${on ? 'var(--ops-steel)' : 'rgba(255,255,255,.12)'}`,
                  transition: 'background .18s var(--ops-ease), color .18s var(--ops-ease), border-color .18s var(--ops-ease)',
                }}
              >
                {on && <Check size={13} strokeWidth={2.4} />}
                {m}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div style={{ marginTop: 22 }}>
        <label htmlFor={`${uid}-challenge`} style={label}>Biggest operational headache right now</label>
        <textarea id={`${uid}-challenge`} name="challenge" maxLength={2000} rows={3} style={{ ...field, resize: 'vertical' }} placeholder="Crews not confirming, quotes taking too long, pay math by hand…" />
      </div>

      <div style={{ marginTop: 18 }}>
        <label htmlFor={`${uid}-message`} style={label}>Anything else? (optional)</label>
        <textarea id={`${uid}-message`} name="message" maxLength={2000} rows={2} style={{ ...field, resize: 'vertical' }} />
      </div>

      {status === 'error' && (
        <p role="alert" style={{ color: '#f87171', fontSize: 13.5, marginTop: 16 }}>{error}</p>
      )}

      <div style={{ marginTop: 24, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <button type="submit" disabled={status === 'sending'} className="btn" style={{ opacity: status === 'sending' ? 0.7 : 1 }}>
          {status === 'sending' ? 'Sending…' : 'Request a Demo'}
          {status !== 'sending' && <ArrowRight size={16} />}
        </button>
        <p style={{ fontSize: 12.5, color: 'rgba(255,255,255,.42)', maxWidth: '34ch' }}>
          No spam, no automated sales sequence. A real person from J KISS follows up.
        </p>
      </div>
    </form>
  );
}
