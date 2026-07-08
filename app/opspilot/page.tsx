import type { Metadata } from 'next';
import Link from 'next/link';
import { Lock, ArrowRight } from 'lucide-react';
import Reveal from '../components/Reveal';
import SubPageNav from '../components/home/SubPageNav';
import SiteFooter from '../components/home/SiteFooter';
import CapabilityGrid from '../components/opspilot/CapabilityGrid';
import EarlyAccessForm from '../components/opspilot/EarlyAccessForm';
import { OpsPilotMark, OpsPilotWordmark } from '../components/opspilot/OpsPilotMark';
import { CAPABILITIES } from '../lib/opspilot';

export const metadata: Metadata = {
  title: 'OpsPilot — The operating system behind J KISS Freight',
  description:
    'OpsPilot is the proprietary operations platform built and run by J KISS LLC. Route assignment, recurring contracts, crew management, claims, payroll, and financial tracking in one system. Coming soon for other owner-operators.',
  alternates: { canonical: 'https://www.jkissllc.com/opspilot' },
  openGraph: {
    title: 'OpsPilot — The operating system behind J KISS Freight',
    description: 'The proprietary operations platform powering J KISS. Coming soon for other owner-operators.',
    url: 'https://www.jkissllc.com/opspilot',
  },
};

/**
 * /opspilot — the one page where the platform gets to speak.
 *
 * Everywhere else on this site OpsPilot whispers. Here it can be direct, but it
 * still is not a SaaS landing page: no pricing table, no logo wall, no
 * testimonials, no "trusted by." The pitch is simply that this software exists,
 * it runs a real freight company today, and you can ask for it.
 */
export default function OpsPilotPage() {
  return (
    <main style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <SubPageNav />

      {/* ── Hero ── */}
      <section className="pt-36 pb-24 px-6" style={{ position: 'relative', overflow: 'hidden', borderBottom: '1px solid var(--line)' }}>
        <div className="ops-grid" aria-hidden style={{ position: 'absolute', inset: 0 }} />
        <div className="max-w-4xl mx-auto" style={{ position: 'relative' }}>
          <Reveal>
            <span style={{ color: 'var(--ops-steel)', display: 'inline-flex' }}>
              <OpsPilotMark size={54} className="ops-mark-in" title="OpsPilot" />
            </span>
          </Reveal>

          <Reveal delay={80}>
            <h1
              className="display-1"
              style={{ color: '#fff', marginTop: 28 }}
            >
              <OpsPilotWordmark tm />
            </h1>
          </Reveal>

          <Reveal delay={140}>
            <p className="lede" style={{ marginTop: 20, maxWidth: '46ch', fontSize: 'clamp(1.15rem, 2vw, 1.45rem)', color: 'var(--muted)' }}>
              The operating system behind J KISS Freight.
            </p>
          </Reveal>

          <Reveal delay={200}>
            <p style={{ marginTop: 22, maxWidth: '58ch', fontSize: 15.5, lineHeight: 1.7, color: 'var(--muted)' }}>
              Every quote, dispatch, crew assignment, route confirmation, claim, financial calculation,
              and customer notification at J KISS is managed through OpsPilot. We built it because nothing
              off the shelf fit how a small carrier actually runs.
            </p>
          </Reveal>

          <Reveal delay={260}>
            <div style={{ marginTop: 30, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <span className="ops-badge">Built In-House</span>
              <span className="ops-badge">Running in Production</span>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Capabilities ── */}
      <section className="py-24 px-6" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto">
          <Reveal>
            <span className="eyebrow">What it does</span>
          </Reveal>
          <Reveal as="h2" delay={70} className="display-2" style={{ color: '#fff', marginTop: 16, maxWidth: '22ch' }}>
            One system, end to end.
          </Reveal>
          <Reveal as="p" delay={130} className="lede" style={{ marginTop: 16, maxWidth: '58ch' }}>
            {CAPABILITIES.length} capabilities, all of them live today. Nothing on this page is a mockup —
            it is the software J KISS dispatches with every morning.
          </Reveal>

          <div style={{ marginTop: 48 }}>
            <CapabilityGrid tone="dark" />
          </div>
        </div>
      </section>

      {/* ── Coming soon / early access ── */}
      <section className="py-24 px-6">
        <div className="max-w-4xl mx-auto">
          <Reveal>
            <div
              className="glass-card"
              style={{
                padding: 'clamp(30px, 5vw, 54px)',
                borderRadius: 24,
                background: 'linear-gradient(135deg, rgba(204,212,224,.05), rgba(255,255,255,.015))',
              }}
            >
              <span className="ops-badge">
                <Lock size={12} strokeWidth={2} /> Coming Soon
              </span>

              <h2 className="display-2" style={{ color: '#fff', marginTop: 20, maxWidth: '20ch' }}>
                Built for us. Soon, for you.
              </h2>

              <p style={{ marginTop: 16, maxWidth: '56ch', fontSize: 15.5, lineHeight: 1.7, color: 'var(--muted)' }}>
                OpsPilot will become available for other owner-operators and service businesses.
                If you run crews, routes, or contracts and you&apos;re tired of stitching together
                spreadsheets and group texts — tell us where to reach you.
              </p>

              <div style={{ marginTop: 30 }}>
                <EarlyAccessForm source="/opspilot" tone="dark" />
              </div>
            </div>
          </Reveal>

          {/* Back to the business that pays for all this. */}
          <Reveal delay={120}>
            <div style={{ marginTop: 44, textAlign: 'center' }}>
              <p style={{ fontSize: 14.5, color: 'var(--muted)' }}>
                Looking to move freight instead?
              </p>
              <Link
                href="/quote"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  marginTop: 10,
                  fontSize: 14.5,
                  fontWeight: 700,
                  color: 'var(--red)',
                  textDecoration: 'none',
                }}
              >
                Get a quote from J KISS <ArrowRight size={15} />
              </Link>
            </div>
          </Reveal>
        </div>
      </section>

      <SiteFooter platformBand={false} />
    </main>
  );
}
