'use client';

import { useState } from 'react';
import { track } from '@vercel/analytics';
import { Trash2, Truck, PackageCheck, Home, KeyRound, Wrench, type LucideIcon } from 'lucide-react';

/**
 * "Built for different operations" — the same Operion modules, configured around
 * a specific kind of service business. Deliberately careful: it describes how the
 * shared, verified modules apply to each industry, and never claims industry-
 * specific features that don't exist.
 */

type Industry = {
  id: string;
  label: string;
  Icon: LucideIcon;
  headline: string;
  body: string;
  uses: string[];
};

const INDUSTRIES: Industry[] = [
  {
    id: 'junk',
    label: 'Junk Removal',
    Icon: Trash2,
    headline: 'From a photo to a paid, disposed load.',
    body: 'Customers book with photos, get an instant range from your own disposal pricing, and the crew that hauls it clocks in on the route. Truck-fill and disposal trips are already in the math.',
    uses: ['Photo-assisted estimates', 'Disposal-trip pricing', 'Route assignment', 'Client invoicing'],
  },
  {
    id: 'moving',
    label: 'Moving',
    Icon: Truck,
    headline: 'Every move, crewed and confirmed.',
    body: 'Book the job, assign a driver and helpers, and let each of them confirm from their phone. The address, arrival window, and pay ride along with the route — and the customer gets texted before you roll.',
    uses: ['Crew assignment', 'Contractor confirmations', 'Arrival-window texts', 'Pay statements'],
  },
  {
    id: 'delivery',
    label: 'Delivery & Freight',
    Icon: PackageCheck,
    headline: 'Standing routes that build themselves.',
    body: 'Recurring contracts generate their routes on schedule, so nobody rebuilds Monday every Monday. Confirmations, clock-in, and per-route profitability come standard — this is the workflow Operion was born in.',
    uses: ['Recurring route templates', 'Per-route profitability', 'Equipment matching', 'Audit trail'],
  },
  {
    id: 'estate',
    label: 'Estate Cleanouts',
    Icon: Home,
    headline: 'Big, sensitive jobs — kept on the record.',
    body: 'Scope a whole-property cleanout with photos and notes, price it against your minimums, and keep every status change and message threaded to the job. Nothing lives in someone’s texts.',
    uses: ['Guided intake + photos', 'Owner-approved quotes', 'Threaded messaging', 'Claims tracking'],
  },
  {
    id: 'turnover',
    label: 'Property Turnovers',
    Icon: KeyRound,
    headline: 'Trash-outs and turns, on a schedule.',
    body: 'Property managers and turnover crews run on repeat work. Set the standing routes, assign the crew, and track equipment and claims per job — with a private client link to share status without a login.',
    uses: ['Recurring routes', 'Client portals', 'Equipment roster', 'Crew cost recovery'],
  },
  {
    id: 'field',
    label: 'Field Services',
    Icon: Wrench,
    headline: 'The office travels with the crew.',
    body: 'Any operation that sends people to addresses can run on the same core: intake, dispatch, confirmations, messaging, and pay. Configure the modules you need around how your business actually works.',
    uses: ['Scheduling & dispatch', 'Crew portal', 'Notifications', 'Analytics'],
  },
];

export default function IndustrySelector() {
  const [active, setActive] = useState(0);
  const ind = INDUSTRIES[active];

  function select(i: number) {
    setActive(i);
    track('operion_industry_selected', { industry: INDUSTRIES[i].id });
  }

  return (
    <div>
      <div role="tablist" aria-label="Industries" style={{ display: 'flex', flexWrap: 'wrap', gap: 9 }}>
        {INDUSTRIES.map((i, idx) => {
          const on = idx === active;
          return (
            <button
              key={i.id}
              role="tab"
              aria-selected={on}
              aria-controls={`ind-panel-${i.id}`}
              id={`ind-tab-${i.id}`}
              onClick={() => select(idx)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 16px',
                borderRadius: 100,
                fontSize: 13.5,
                fontWeight: 600,
                cursor: 'pointer',
                color: on ? '#0b0b0c' : 'var(--muted)',
                background: on ? 'var(--ops-steel)' : 'rgba(255,255,255,.04)',
                border: `1px solid ${on ? 'var(--ops-steel)' : 'rgba(255,255,255,.1)'}`,
                transition: 'background .2s var(--ops-ease), color .2s var(--ops-ease)',
              }}
            >
              <i.Icon size={15} strokeWidth={1.7} />
              {i.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`ind-panel-${ind.id}`}
        aria-labelledby={`ind-tab-${ind.id}`}
        key={ind.id}
        className="ops-card ops-rise"
        style={{ marginTop: 22, padding: 'clamp(24px, 4vw, 40px)' }}
      >
        <div className="tour-split" style={{ alignItems: 'center' }}>
          <div>
            <span className="ops-icon"><ind.Icon size={18} strokeWidth={1.6} /></span>
            <h3 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'clamp(1.4rem, 2.4vw, 1.9rem)', letterSpacing: '-0.025em', color: '#fff', marginTop: 16, lineHeight: 1.15 }}>
              {ind.headline}
            </h3>
            <p style={{ color: 'var(--muted)', fontSize: 15, lineHeight: 1.7, marginTop: 14, maxWidth: '52ch' }}>
              {ind.body}
            </p>
          </div>
          <div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ops-steel-dim)' }}>
              Modules it uses
            </span>
            <div style={{ marginTop: 14, display: 'grid', gap: 9 }}>
              {ind.uses.map(u => (
                <div key={u} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 15px', borderRadius: 12, background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.07)' }}>
                  <span style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--ops-steel)', flexShrink: 0 }} />
                  <span style={{ color: 'var(--text)', fontSize: 14, fontWeight: 500 }}>{u}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
