import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import Reveal from '../components/Reveal';
import SubPageNav from '../components/home/SubPageNav';
import SiteFooter from '../components/home/SiteFooter';
import { OpsPilotMark, OpsPilotWordmark } from '../components/opspilot/OpsPilotMark';

export const metadata: Metadata = {
  title: 'About J Kiss LLC — DFW Box-Truck Delivery, Junk Removal & Cleanouts',
  description:
    'J Kiss LLC has run box-truck delivery across the Dallas–Fort Worth metroplex since September 2020. Our story, our equipment, and the operations platform we built in-house to run it all.',
  alternates: { canonical: 'https://www.jkissllc.com/about' },
  openGraph: {
    title: 'About J Kiss LLC',
    description: 'Box-truck delivery, junk removal, and cleanouts across DFW since September 2020.',
    url: 'https://www.jkissllc.com/about',
  },
};

/**
 * /about — the company story.
 *
 * This page did not exist; the nav has been linking to a dead "/#about" anchor.
 * It is now the home for the OpsPilot origin story, which belongs here rather than
 * on the homepage: it's context for people who already care who we are.
 *
 * Every claim on this page is one the site already makes elsewhere (founding date,
 * DOT/MC, equipment class, service lines). Nothing is invented for effect.
 */
export default function AboutPage() {
  return (
    <main style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <SubPageNav />

      {/* ── Hero ── */}
      <section className="pt-36 pb-20 px-6" style={{ background: 'linear-gradient(135deg, #0b0b0c 0%, #1a0508 100%)', borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-4xl mx-auto">
          <Reveal>
            <span className="eyebrow">Our story</span>
          </Reveal>
          <Reveal delay={70}>
            <h1 className="display-1" style={{ color: '#fff', marginTop: 18 }}>
              Five years moving<br />
              <span style={{ color: 'var(--red)' }}>DFW freight.</span>
            </h1>
          </Reveal>
          <Reveal delay={130}>
            <p className="lede" style={{ marginTop: 20, maxWidth: '54ch', color: 'var(--muted)' }}>
              J Kiss LLC has run box-truck delivery across the Dallas–Fort Worth metroplex since
              September 2020. Furniture, appliances, building materials, junk removal, and full
              property cleanouts.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ── The business ── */}
      <section className="section section-light">
        <div className="wrap-narrow">
          <Reveal>
            <h2 className="display-2">What we actually do</h2>
          </Reveal>
          <Reveal delay={70}>
            <p style={{ marginTop: 20, fontSize: 16.5, lineHeight: 1.75, color: 'var(--ink-body)' }}>
              We run 16&ndash;26 ft straight trucks. Not semis, not 53&apos; vans &mdash; box trucks, the
              equipment that fits the loading dock behind a furniture showroom and the driveway of a
              house in Oak Cliff. That constraint is deliberate. It&apos;s the work we know, and it&apos;s
              the work we&apos;re good at.
            </p>
          </Reveal>
          <Reveal delay={130}>
            <p style={{ marginTop: 20, fontSize: 16.5, lineHeight: 1.75, color: 'var(--ink-body)' }}>
              Over five years that has meant last-mile and white-glove delivery for retailers,
              retail replenishment runs, junk removal, and eviction and property cleanouts. Every
              job is run by a two-person crew of licensed, insured contractors, out of a company
              that has held its own operating authority since day one.
            </p>
          </Reveal>

          <Reveal delay={190}>
            <div
              style={{
                marginTop: 44,
                display: 'grid',
                gap: 20,
                gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                paddingTop: 36,
                borderTop: '1px solid var(--line-ink)',
              }}
            >
              {[
                ['2020', 'In business since September'],
                ['DFW', 'Dallas–Fort Worth metroplex'],
                ['3484556', 'US DOT number'],
                ['01155352', 'MC number'],
              ].map(([value, label]) => (
                <div key={label}>
                  <p className="kpi tabular-nums" style={{ fontSize: 'clamp(1.4rem, 2.4vw, 1.9rem)' }}>{value}</p>
                  <p style={{ fontSize: 13.5, color: 'var(--ink-muted)', marginTop: 6, lineHeight: 1.45 }}>{label}</p>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Why we built OpsPilot ── */}
      <section className="section section-dark" style={{ position: 'relative', overflow: 'hidden' }}>
        <div className="ops-grid" aria-hidden style={{ position: 'absolute', inset: 0 }} />
        <div className="wrap-narrow" style={{ position: 'relative' }}>
          <Reveal>
            <span style={{ color: 'var(--ops-steel)', display: 'inline-flex' }}>
              <OpsPilotMark size={40} title="OpsPilot" />
            </span>
          </Reveal>

          <Reveal delay={70}>
            <h2 className="display-2" style={{ color: '#fff', marginTop: 24, maxWidth: '20ch' }}>
              Why we built our own software
            </h2>
          </Reveal>

          <Reveal delay={130}>
            <p style={{ marginTop: 22, fontSize: 16.5, lineHeight: 1.75, color: 'var(--muted)' }}>
              For a long time we ran the company the way most small carriers do: a spreadsheet for
              routes, a group text for the crew, a notes app for what each client pays, and a
              memory for everything else. Every tool we tried was built either for a fleet of two
              hundred trucks or for a solo driver with an app. Nothing fit a company our size, and
              the parts that mattered most to us &mdash; who confirmed, who declined, what a route
              actually earned after payout &mdash; weren&apos;t in any of them.
            </p>
          </Reveal>

          <Reveal delay={190}>
            <p style={{ marginTop: 20, fontSize: 16.5, lineHeight: 1.75, color: 'var(--muted)' }}>
              So we built our own. It started as a way to stop losing track of route confirmations.
              It grew into the system that now runs the entire business: dispatch, recurring
              contracts, crew profiles, digital agreements, damage claims, weekly payroll,
              per-route profitability, and every text and email that goes out to a customer or a
              driver. We called it <OpsPilotWordmark tm style={{ color: '#fff' }} />.
            </p>
          </Reveal>

          <Reveal delay={250}>
            <p style={{ marginTop: 20, fontSize: 16.5, lineHeight: 1.75, color: 'var(--muted)' }}>
              It isn&apos;t a side project. It&apos;s the operational backbone of J Kiss, and it&apos;s
              in use every morning before the first truck rolls. When you book with us, you&apos;re
              working with a company that knows exactly where your job stands &mdash; because the
              software we wrote tells us.
            </p>
          </Reveal>

          <Reveal delay={310}>
            <div style={{ marginTop: 32, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <span className="ops-badge">Built In-House</span>
              <Link
                href="/opspilot"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 14.5, fontWeight: 600, color: '#fff', textDecoration: 'none' }}
              >
                See what OpsPilot does <ArrowRight size={15} />
              </Link>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="section section-alt">
        <div className="wrap-narrow" style={{ textAlign: 'center' }}>
          <Reveal>
            <h2 className="display-2">Need something moved?</h2>
          </Reveal>
          <Reveal delay={70}>
            <p className="lede" style={{ marginTop: 16, maxWidth: '44ch', marginInline: 'auto' }}>
              Tell us about the job and we&apos;ll give you an honest range up front.
            </p>
          </Reveal>
          <Reveal delay={130}>
            <div style={{ marginTop: 30, display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap' }}>
              <Link href="/quote" className="btn">Get My Quote</Link>
              <Link href="/start-your-carrier" className="btn-ghost-ink">Read the Carrier Guide</Link>
            </div>
          </Reveal>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
