'use client';

import { useState } from 'react';
import { track } from '@vercel/analytics';
import {
  Inbox, ScanSearch, FileText, Route as RouteIcon, CheckCircle2, Banknote,
  type LucideIcon,
} from 'lucide-react';

/**
 * Product tour — the one interactive on the page.
 *
 * It walks a real job through Operion, step by step. Every screen here is an
 * ILLUSTRATIVE representation built from the platform's actual data shapes
 * (booking/route/pay numbers, real status values from the audit) — it is a tour,
 * not a live admin control, and it renders no private customer data.
 */

type Line = { k: string; v: string; accent?: boolean };
type Step = {
  id: string;
  tab: string;
  Icon: LucideIcon;
  eyebrow: string;
  title: string;
  body: string;
  screenTitle: string;
  badge: string;
  lines: Line[];
};

const STEPS: Step[] = [
  {
    id: 'intake',
    tab: 'Request comes in',
    Icon: Inbox,
    eyebrow: 'Booking & intake',
    title: 'The job arrives organized, not as a text.',
    body: 'A customer books online — service, address, load size, preferred date, and up to twenty photos. It lands as a structured request with a booking number, before anyone picks up the phone.',
    screenTitle: 'New request',
    badge: 'quote_received',
    lines: [
      { k: 'Booking', v: 'JK-B-1042', accent: true },
      { k: 'Service', v: 'Garage cleanout' },
      { k: 'Preferred', v: 'Tue · 8–10 AM' },
      { k: 'Photos', v: '6 attached' },
    ],
  },
  {
    id: 'ai',
    tab: 'AI reads the photos',
    Icon: ScanSearch,
    eyebrow: 'AI-assisted analysis',
    title: 'AI helps your team see the load — it never sets the price.',
    body: 'Uploaded photos are analyzed for visible items and how much truck they’ll fill. The read is advisory: a deterministic pricing engine does the math, and anything uncertain is flagged for manual review. You stay in control.',
    screenTitle: 'Photo analysis',
    badge: 'advisory',
    lines: [
      { k: 'Est. fill', v: '~45% of one truck' },
      { k: 'Disposal', v: '1 trip' },
      { k: 'Confidence', v: 'High' },
      { k: 'Decision', v: 'Ready for review', accent: true },
    ],
  },
  {
    id: 'quote',
    tab: 'Quote goes out',
    Icon: FileText,
    eyebrow: 'Quote workflow',
    title: 'An owner-approved range, sent in a tap.',
    body: 'The estimate is built from your own pricing rules — per-trip disposal, labor, margin — never below your set minimum. You approve it, and the customer can lock the window with a deposit online.',
    screenTitle: 'Quote',
    badge: 'sent',
    lines: [
      { k: 'Estimate', v: '$340 – $420', accent: true },
      { k: 'Disposal', v: 'Included' },
      { k: 'Deposit', v: 'Card or Zelle' },
      { k: 'Status', v: 'Awaiting confirm' },
    ],
  },
  {
    id: 'assign',
    tab: 'Crew gets the route',
    Icon: RouteIcon,
    eyebrow: 'Routes & dispatch',
    title: 'Assigned to a named crew, confirmed from their phone.',
    body: 'The job becomes a route with an address, report time, and pay attached. Each crew member gets their own link, confirms or declines, and a decline surfaces instantly for reassignment.',
    screenTitle: 'Route · Tue',
    badge: 'confirmed',
    lines: [
      { k: 'Driver', v: 'Marcus — confirmed', accent: true },
      { k: 'Helper', v: 'Dre — confirmed' },
      { k: 'Report', v: '7:30 AM · yard' },
      { k: 'Pay', v: 'Snapshotted at assign' },
    ],
  },
  {
    id: 'complete',
    tab: 'Work gets done',
    Icon: CheckCircle2,
    eyebrow: 'Field operations',
    title: 'Clock in, do the work, mark it complete.',
    body: 'Crew clock in and out from the field. Status moves to completed, the customer gets a text automatically, and every transition is written to an audit trail — no one has to remember to send anything.',
    screenTitle: 'On site',
    badge: 'completed',
    lines: [
      { k: 'Clock-in', v: '8:04 AM' },
      { k: 'Clock-out', v: '9:41 AM' },
      { k: 'Customer', v: 'Auto-notified', accent: true },
      { k: 'Audit', v: '7 events logged' },
    ],
  },
  {
    id: 'pay',
    tab: 'Everyone gets paid',
    Icon: Banknote,
    eyebrow: 'Invoicing & pay',
    title: 'One completed job. Two clean records.',
    body: 'The completed route becomes a client invoice — stamped so it can never be billed twice — and flows into each contractor’s pay statement, with any claim deductions already accounted for.',
    screenTitle: 'Close-out',
    badge: 'paid',
    lines: [
      { k: 'Invoice', v: 'JK-INV-2091', accent: true },
      { k: 'Marcus', v: 'Pay statement JK-PS-318' },
      { k: 'Deductions', v: 'None this week' },
      { k: 'YTD', v: 'Updated' },
    ],
  },
];

export default function ProductTour() {
  const [active, setActive] = useState(0);
  const step = STEPS[active];

  function select(i: number) {
    setActive(i);
    track('operion_tour_step', { step: STEPS[i].id });
  }

  return (
    <div>
      {/* Step selector — horizontal, scrollable on mobile */}
      <div
        role="tablist"
        aria-label="Product tour steps"
        className="cc-subnav"
        style={{ gap: 8, paddingBottom: 4 }}
      >
        {STEPS.map((s, i) => {
          const on = i === active;
          return (
            <button
              key={s.id}
              role="tab"
              aria-selected={on}
              aria-controls={`tour-panel-${s.id}`}
              id={`tour-tab-${s.id}`}
              onClick={() => select(i)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                whiteSpace: 'nowrap',
                padding: '10px 15px',
                borderRadius: 100,
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                color: on ? '#0b0b0c' : 'var(--muted)',
                background: on ? 'var(--ops-steel)' : 'rgba(255,255,255,.04)',
                border: `1px solid ${on ? 'var(--ops-steel)' : 'rgba(255,255,255,.1)'}`,
                transition: 'background .2s var(--ops-ease), color .2s var(--ops-ease)',
              }}
            >
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, opacity: 0.7 }}>{String(i + 1).padStart(2, '0')}</span>
              {s.tab}
            </button>
          );
        })}
      </div>

      {/* Panel */}
      <div
        role="tabpanel"
        id={`tour-panel-${step.id}`}
        aria-labelledby={`tour-tab-${step.id}`}
        key={step.id}
        className="ops-rise"
        style={{
          marginTop: 24,
          display: 'grid',
          gap: 28,
          gridTemplateColumns: 'minmax(0, 1fr)',
          alignItems: 'center',
        }}
      >
        <div className="tour-split">
          {/* Copy */}
          <div>
            <span className="eyebrow">{step.eyebrow}</span>
            <h3 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'clamp(1.5rem, 2.6vw, 2rem)', letterSpacing: '-0.025em', color: '#fff', marginTop: 14, lineHeight: 1.12 }}>
              {step.title}
            </h3>
            <p style={{ color: 'var(--muted)', fontSize: 15.5, lineHeight: 1.7, marginTop: 16, maxWidth: '50ch' }}>
              {step.body}
            </p>
          </div>

          {/* Illustrative screen */}
          <div className="ops-card" style={{ padding: 22, background: 'rgba(255,255,255,.03)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, color: '#fff', fontWeight: 600, fontSize: 14.5 }}>
                <span className="ops-icon" style={{ width: 30, height: 30 }}><step.Icon size={15} strokeWidth={1.7} /></span>
                {step.screenTitle}
              </span>
              <span className="ops-badge" style={{ fontFamily: 'var(--font-mono)' }}>{step.badge}</span>
            </div>
            <div style={{ marginTop: 16, display: 'grid', gap: 1, borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(255,255,255,.07)' }}>
              {step.lines.map(l => (
                <div key={l.k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: '11px 14px', background: 'rgba(255,255,255,.02)' }}>
                  <span style={{ color: 'var(--ops-steel-dim)', fontSize: 12.5, fontFamily: 'var(--font-mono)', letterSpacing: '0.02em' }}>{l.k}</span>
                  <span className="break-anywhere" style={{ color: l.accent ? 'var(--ops-steel)' : 'var(--text)', fontSize: 13.5, fontWeight: l.accent ? 700 : 500, textAlign: 'right' }}>{l.v}</span>
                </div>
              ))}
            </div>
            <p style={{ marginTop: 12, fontSize: 11, color: 'rgba(255,255,255,.32)', fontFamily: 'var(--font-mono)' }}>
              Illustrative — real screen, sample job.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
