'use client';

import { useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';

type Status = 'idle' | 'sending' | 'done' | 'error';

/**
 * OpsPilot early-access capture.
 *
 * Shown in the "Coming Soon" callouts. `source` records which page converted, so
 * we can tell whether the carrier guide or the OpsPilot page is doing the work.
 *
 * `tone` matches the surrounding surface — the carrier guide is dark throughout,
 * the /opspilot close is dark too, but the About page may want light.
 */
export default function EarlyAccessForm({
  source,
  tone = 'dark',
  compact = false,
}: {
  source: string;
  tone?: 'dark' | 'light';
  compact?: boolean;
}) {
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');

  const dark = tone === 'dark';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (status === 'sending') return;
    setStatus('sending');
    setError('');
    try {
      const res = await fetch('/api/opspilot/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, company, source }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
      setStatus('done');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    }
  }

  if (status === 'done') {
    return (
      <div
        role="status"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          padding: '13px 18px',
          borderRadius: 12,
          fontSize: 14,
          fontWeight: 600,
          color: dark ? '#fff' : 'var(--ink)',
          background: dark ? 'rgba(204,212,224,.08)' : 'rgba(12,14,18,.04)',
          border: `1px solid ${dark ? 'rgba(204,212,224,.2)' : 'var(--line-ink)'}`,
        }}
      >
        <Check size={16} style={{ color: 'var(--ops-steel)' }} />
        You&apos;re on the list. We&apos;ll be in touch when Operion opens up.
      </div>
    );
  }

  const field: React.CSSProperties = {
    flex: '1 1 200px',
    minWidth: 0,
    padding: '13px 15px',
    borderRadius: 11,
    fontSize: 14.5,
    outline: 'none',
    color: dark ? 'var(--text)' : 'var(--ink)',
    background: dark ? 'rgba(255,255,255,.04)' : 'var(--surface)',
    border: `1px solid ${dark ? 'rgba(255,255,255,.12)' : 'var(--line-ink-2)'}`,
  };

  return (
    <form onSubmit={submit} style={{ width: '100%', maxWidth: compact ? 460 : 620 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <input
          type="email"
          required
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="you@company.com"
          aria-label="Email address"
          autoComplete="email"
          style={field}
        />
        {!compact && (
          <input
            type="text"
            value={company}
            onChange={e => setCompany(e.target.value)}
            placeholder="Company (optional)"
            aria-label="Company"
            autoComplete="organization"
            style={field}
          />
        )}
        <button
          type="submit"
          disabled={status === 'sending'}
          className={dark ? 'btn' : 'btn-ink'}
          style={{ borderRadius: 11, padding: '13px 22px', opacity: status === 'sending' ? 0.7 : 1 }}
        >
          {status === 'sending' ? 'Sending…' : 'Request early access'}
          {status !== 'sending' && <ArrowRight size={15} />}
        </button>
      </div>

      {status === 'error' && (
        <p role="alert" style={{ color: '#f87171', fontSize: 13, marginTop: 10 }}>
          {error}
        </p>
      )}
      <p style={{ fontSize: 12, color: dark ? 'rgba(255,255,255,.4)' : 'var(--ink-muted)', marginTop: 11 }}>
        No spam. We&apos;ll only email you when Operion is ready for outside operators.
      </p>
    </form>
  );
}
