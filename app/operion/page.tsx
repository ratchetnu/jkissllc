import type { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import {
  ArrowRight, MessagesSquare, ImageOff, PhoneMissed, Notebook,
  Wrench as WrenchIcon, EyeOff, Boxes, ShieldCheck, ScanSearch, Route as RouteIcon,
  Users, Wallet, Bell, BarChart3, Smartphone, Layers, Lock, CircleUserRound, Clock, TrendingDown,
} from 'lucide-react';
import { COMPANY } from '../lib/company';
import Reveal from '../components/Reveal';
import SubPageNav from '../components/home/SubPageNav';
import SiteFooter from '../components/home/SiteFooter';
import CapabilityGrid from '../components/opspilot/CapabilityGrid';
import ProductTour from '../components/opspilot/ProductTour';
import IndustrySelector from '../components/opspilot/IndustrySelector';
import OperionFAQ from '../components/opspilot/OperionFAQ';
import RequestDemoForm from '../components/opspilot/RequestDemoForm';
import { CAPABILITIES } from '../lib/opspilot';
import { OPERION_FAQ } from '../lib/operion-faq';

const CANONICAL = 'https://www.jkissllc.com/operion';

export const metadata: Metadata = {
  title: 'Operion — Operations Software for Trucking, Delivery & Crew-Based Businesses',
  description:
    'Operion runs a crew-based operation end to end: dispatch and recurring routes, crew and employee records, time and attendance, equipment and fleet, invoicing, payouts, claims, and owner analytics — in one platform. Built and run inside J KISS LLC.',
  keywords: [
    'trucking operations software', 'dispatch software for small fleets', 'crew scheduling software',
    'field crew time tracking', 'contractor pay management', 'route management software',
    'fleet maintenance tracking', 'delivery operations platform', 'service business management software',
    'junk removal software',
  ],
  alternates: { canonical: CANONICAL },
  openGraph: {
    type: 'website',
    title: 'Operion — The operating system for work in motion',
    description:
      'Dispatch, crews, time and attendance, equipment, invoicing, payouts, and owner analytics — connected in one workspace. Built from real trucking and delivery operations inside J KISS LLC.',
    url: CANONICAL,
    siteName: 'Operion',
    images: [{ url: '/operion-og.png', width: 982, height: 784, alt: 'Operion — operating system for crew-based operations' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Operion — The operating system for work in motion',
    description: 'Dispatch, crews, time, equipment, invoicing, and payouts — connected in one workspace.',
    images: ['/operion-og.png'],
  },
};

/* ── Structured data — kept factual. SoftwareApplication + FAQ mirror on-page copy. ── */
const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'SoftwareApplication',
      name: 'Operion',
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      description:
        'Operations platform for crew-based businesses: dispatch and recurring routes, crew and employee records, time and attendance with GPS-verified clock-ins, equipment and fleet maintenance, invoicing and payments, payout statements, claims, messaging, and owner analytics. Online booking with AI-assisted photo estimating is one of its intake paths.',
      url: CANONICAL,
      creator: { '@type': 'Organization', name: COMPANY.legalName, url: COMPANY.siteUrl },
      offers: { '@type': 'Offer', availability: 'https://schema.org/PreOrder', price: '0', priceCurrency: 'USD' },
    },
    {
      '@type': 'FAQPage',
      mainEntity: OPERION_FAQ.map(f => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    },
  ],
};

/* Small presentational helpers (server-rendered) --------------------------------- */

function PainCard({ Icon, title, body }: { Icon: typeof MessagesSquare; title: string; body: string }) {
  return (
    <div className="ops-card" style={{ padding: 22 }}>
      <span className="ops-icon" style={{ color: '#ff8fa3', background: 'rgba(224,0,42,.08)', borderColor: 'rgba(224,0,42,.2)' }}>
        <Icon size={17} strokeWidth={1.7} />
      </span>
      <h3 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '0.98rem', color: '#fff', marginTop: 14, letterSpacing: '-0.015em' }}>{title}</h3>
      <p style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.55, marginTop: 7 }}>{body}</p>
    </div>
  );
}

function FeatureRow({
  eyebrow, title, body, points, Icon, flip = false,
}: {
  eyebrow: string; title: string; body: string; points: string[]; Icon: typeof RouteIcon; flip?: boolean;
}) {
  return (
    <div className="tour-split" style={{ alignItems: 'center' }}>
      <Reveal style={{ order: flip ? 2 : 1 }}>
        <span className="eyebrow">{eyebrow}</span>
        <h3 className="display-2" style={{ color: '#fff', marginTop: 16, maxWidth: '18ch' }}>{title}</h3>
        <p className="lede" style={{ marginTop: 16, maxWidth: '52ch' }}>{body}</p>
      </Reveal>
      <Reveal delay={100} style={{ order: flip ? 1 : 2 }}>
        <div className="ops-card" style={{ padding: 'clamp(22px, 3vw, 30px)' }}>
          <span className="ops-icon" style={{ width: 44, height: 44 }}><Icon size={20} strokeWidth={1.6} /></span>
          <div style={{ marginTop: 18, display: 'grid', gap: 10 }}>
            {points.map(p => (
              <div key={p} style={{ display: 'flex', alignItems: 'flex-start', gap: 11 }}>
                <span style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--ops-steel)', flexShrink: 0, marginTop: 8 }} />
                <span style={{ color: 'var(--text)', fontSize: 14.5, lineHeight: 1.5 }}>{p}</span>
              </div>
            ))}
          </div>
        </div>
      </Reveal>
    </div>
  );
}

const ROLES = [
  {
    Icon: CircleUserRound,
    role: 'Owner / Admin',
    body: 'The whole business in one view — with the financial and configuration controls only an owner should hold.',
    points: ['Full operational visibility', 'Pricing, pay & financial controls', 'Crew, hiring & user management', 'Reporting & platform settings'],
  },
  {
    Icon: Users,
    role: 'Manager',
    body: 'Everything needed to run the day — without the keys to pay configuration, taxes, or account settings.',
    points: ['Daily operations & dispatch', 'Crew coordination', 'Schedule & route oversight', 'Issue escalation'],
  },
  {
    Icon: Smartphone,
    role: 'Crew / Employee',
    body: 'A private portal scoped to one person: their work, their hours, their pay. They never see anyone else’s.',
    points: ['Assigned routes & confirmations', 'Clock in/out, availability & time-off', 'Documents & reminders', 'Pay statements & YTD earnings'],
  },
];

export default function OperionPage() {
  return (
    <main style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SubPageNav />

      {/* ─────────────────────────── HERO ─────────────────────────── */}
      <section className="pt-36 pb-24 px-6" style={{ position: 'relative', overflow: 'hidden', borderBottom: '1px solid var(--line)' }}>
        <div className="ops-grid" aria-hidden style={{ position: 'absolute', inset: 0 }} />
        <div className="max-w-6xl mx-auto" style={{ position: 'relative' }}>
          <div className="tour-split" style={{ alignItems: 'center', gap: 'clamp(32px, 5vw, 64px)' }}>
            <div>
              <Reveal>
                <Image
                  src="/operion-logo.png"
                  alt="Operion"
                  width={982}
                  height={784}
                  priority
                  sizes="(max-width: 640px) 66vw, 360px"
                  style={{ width: 'min(360px, 66vw)', height: 'auto' }}
                />
              </Reveal>
              <Reveal delay={120}>
                <h1 className="display-1" style={{ color: '#fff', marginTop: 22, maxWidth: '15ch' }}>
                  The operating system for work in motion.
                </h1>
              </Reveal>
              <Reveal delay={200}>
                <p className="lede" style={{ marginTop: 20, maxWidth: '50ch' }}>
                  Dispatch, crews and employees, time and attendance, equipment, invoicing, and payouts —
                  connected in one workspace, so the whole operation moves together.
                </p>
              </Reveal>
              <Reveal delay={280}>
                <div style={{ marginTop: 30, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <Link href="#request" className="btn">Request a Demo <ArrowRight size={16} /></Link>
                  <Link href="#system" className="btn-ghost">Explore Operion</Link>
                </div>
              </Reveal>
              <Reveal delay={340}>
                <p style={{ marginTop: 22, fontSize: 13, color: 'rgba(255,255,255,.5)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <ShieldCheck size={14} style={{ color: 'var(--ops-steel)' }} />
                  Built from real operations inside {COMPANY.legalName}.
                </p>
              </Reveal>
            </div>

            {/* Hero product visual — illustrative composite of real screen shapes */}
            <Reveal delay={220}>
              <div aria-hidden style={{ position: 'relative' }}>
                <div className="ops-card" style={{ padding: 20, background: 'rgba(255,255,255,.035)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ color: '#fff', fontWeight: 600, fontSize: 13.5, display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                      <span className="ops-icon" style={{ width: 26, height: 26 }}><Layers size={13} /></span>
                      Today · Operations
                    </span>
                    <span className="ops-badge">live</span>
                  </div>
                  <div style={{ marginTop: 14, display: 'grid', gap: 10, gridTemplateColumns: '1fr 1fr' }}>
                    {[['Routes', '7'], ['Confirmed', '6'], ['Clocked in', '5'], ['Needs review', '1']].map(([k, v]) => (
                      <div key={k} style={{ padding: '12px 14px', borderRadius: 12, background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.07)' }}>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ops-steel-dim)' }}>{k}</div>
                        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '1.5rem', color: '#fff', marginTop: 4 }}>{v}</div>
                      </div>
                    ))}
                  </div>
                </div>
                {/* Overlapping mobile crew card */}
                <div className="ops-card" style={{ padding: 16, background: '#141416', width: 'min(230px, 62%)', marginTop: -28, marginLeft: 'auto', marginRight: -8, boxShadow: '0 24px 60px rgba(0,0,0,.5)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ color: '#fff', fontWeight: 600, fontSize: 12.5 }}>Your route · Tue</span>
                    <span style={{ width: 8, height: 8, borderRadius: 99, background: '#34d399' }} />
                  </div>
                  <p style={{ color: 'var(--muted)', fontSize: 11.5, marginTop: 8, lineHeight: 1.5 }}>Report 7:30 AM · yard<br />Box-truck delivery · JK-R-1184</p>
                  <div style={{ marginTop: 12, padding: '9px 12px', borderRadius: 10, background: 'var(--ops-steel)', color: '#0b0b0c', fontWeight: 700, fontSize: 12.5, textAlign: 'center' }}>Confirmed ✓</div>
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ─────────────────────────── PROBLEM ─────────────────────────── */}
      <section className="py-24 px-6" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto">
          <Reveal><span className="eyebrow">The problem</span></Reveal>
          <Reveal as="h2" delay={70} className="display-2" style={{ color: '#fff', marginTop: 16, maxWidth: '20ch' }}>
            Your operation shouldn’t run through scattered texts and spreadsheets.
          </Reveal>
          <Reveal as="p" delay={130} className="lede" style={{ marginTop: 16, maxWidth: '58ch' }}>
            As a crew-based business grows, the work spreads across a dozen places — and things fall through
            the gaps between them.
          </Reveal>

          <div style={{ marginTop: 44, display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
            <PainCard Icon={MessagesSquare} title="Work arrives everywhere" body="Calls, texts, standing contracts, and form emails — with no single place they all become organized routes." />
            <PainCard Icon={PhoneMissed} title="Crews don’t confirm" body="You find out at 7 AM that the helper isn’t coming — with no time to reassign." />
            <PainCard Icon={Clock} title="Hours come from memory" body="Nobody knows who was actually on site, or for how long, until someone asks for pay." />
            <PainCard Icon={Notebook} title="Pay math lives in a notebook" body="Route counts, deductions, and payouts get tallied by hand, and mistakes cost trust." />
            <PainCard Icon={WrenchIcon} title="Equipment goes untracked" body="Who has which truck today, and when it was last serviced? Nobody’s quite sure." />
            <PainCard Icon={ImageOff} title="Photos get lost in threads" body="The pictures you need to price a job are buried three group chats deep." />
            <PainCard Icon={TrendingDown} title="You re-run losing work" body="Nothing tells you what a route actually earned, so the bad contract renews itself." />
            <PainCard Icon={EyeOff} title="Owners can’t see the whole business" body="The full picture only exists in your head — and only for as long as you can hold it." />
          </div>

          <Reveal delay={120}>
            <p style={{ marginTop: 40, fontSize: 'clamp(1.15rem, 2.4vw, 1.6rem)', fontFamily: 'var(--font-display)', fontWeight: 700, letterSpacing: '-0.02em', color: '#fff', maxWidth: '24ch' }}>
              Operion connects the entire operation.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ─────────────────── CONNECTED SYSTEM OVERVIEW ─────────────────── */}
      <section id="system" className="py-24 px-6" style={{ borderBottom: '1px solid var(--line)', scrollMarginTop: 80 }}>
        <div className="max-w-6xl mx-auto">
          <Reveal><span className="eyebrow">One system</span></Reveal>
          <Reveal as="h2" delay={70} className="display-2" style={{ color: '#fff', marginTop: 16, maxWidth: '20ch' }}>
            Everything your operation needs. Working as one.
          </Reveal>
          <Reveal as="p" delay={130} className="lede" style={{ marginTop: 16, maxWidth: '58ch' }}>
            Not a grid of disconnected apps — a single pipeline where work flows into a route, a crew, a
            timesheet, an invoice, and a payout without ever being re-entered.
          </Reveal>

          <Reveal delay={180}>
            <div style={{ marginTop: 40, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
              {['Intake', 'Price & quote', 'Schedule & route', 'Crew & confirm', 'Time & attendance', 'Communicate', 'Invoice', 'Pay', 'Insights'].map((stage, i, arr) => (
                <span key={stage} style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                  <span className="ops-badge" style={{ fontSize: 11.5 }}>{stage}</span>
                  {i < arr.length - 1 && <ArrowRight size={13} style={{ color: 'var(--ops-steel-dim)' }} aria-hidden />}
                </span>
              ))}
            </div>
          </Reveal>

          <div style={{ marginTop: 48 }}>
            <Reveal><span className="eyebrow">What it does · {CAPABILITIES.length} capabilities, live today</span></Reveal>
            <Reveal delay={60}>
              <p style={{ marginTop: 12, fontSize: 13.5, color: 'rgba(255,255,255,.45)', maxWidth: '62ch', lineHeight: 1.6 }}>
                Every card below is software {COMPANY.legalName} dispatches with — not a roadmap. Photo-based
                instant quoting is one intake path among these, not the product.
              </p>
            </Reveal>
            <div style={{ marginTop: 24 }}>
              <CapabilityGrid tone="dark" />
            </div>
          </div>
        </div>
      </section>

      {/* ─────────────────── PRODUCT TOUR (interactive) ─────────────────── */}
      <section className="py-24 px-6" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto">
          <Reveal><span className="eyebrow">See it work</span></Reveal>
          <Reveal as="h2" delay={70} className="display-2" style={{ color: '#fff', marginTop: 16, maxWidth: '22ch' }}>
            Follow one job through Operion.
          </Reveal>
          <Reveal as="p" delay={130} className="lede" style={{ marginTop: 16, maxWidth: '56ch' }}>
            From the first request to the final payout — step through the pipeline and watch the data carry
            itself from one stage to the next.
          </Reveal>
          <Reveal as="p" delay={150}>
            <span style={{ display: 'block', marginTop: 14, fontSize: 13.5, color: 'rgba(255,255,255,.45)', maxWidth: '62ch', lineHeight: 1.6 }}>
              This is the on-demand lane, where a customer starts the job. Contract and recurring work enters
              at step four instead — the route builds itself from the standing contract — and every stage after
              that is identical.
            </span>
          </Reveal>
          <Reveal delay={160}>
            <div style={{ marginTop: 40 }}>
              <ProductTour />
            </div>
          </Reveal>
        </div>
      </section>

      {/* ─────────────────── AI PHOTO ANALYSIS ─────────────────── */}
      <section className="py-24 px-6" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto">
          <FeatureRow
            Icon={ScanSearch}
            eyebrow="AI-assisted analysis"
            title="AI where it helps. Control where it matters."
            body="For the work that gets quoted from photos — hauls, cleanouts, moves — customers upload job photos and AI helps your team read the load: visible items and how much truck it will fill. But the AI only ever observes. A deterministic pricing engine does the math against your own rules, and anything uncertain is flagged for a person to review."
            points={[
              'Analyzes uploaded job photos for visible items and volume',
              'Deterministic engine sets the estimate — never the AI',
              'Low-confidence reads route to manual review, not a bad quote',
              'Never touches dispatch, time, or pay — those stay deterministic',
            ]}
          />
          <Reveal delay={120}>
            <p style={{ marginTop: 28, fontSize: 12.5, color: 'rgba(255,255,255,.4)', fontFamily: 'var(--font-mono)', maxWidth: '60ch' }}>
              Designed for consistency, not to replace judgment. Estimates are ranges built from your own rules — and a low-confidence read is handed to a person instead of quoted.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ─────────────────── OPERATIONS & ROUTES ─────────────────── */}
      <section className="py-24 px-6" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto">
          <FeatureRow
            flip
            Icon={RouteIcon}
            eyebrow="Operations & routes"
            title="From assignment to completion, everyone knows what happens next."
            body="Every job becomes a route with a named crew, an address, a report time, and pay attached. Standing contracts generate their own routes on schedule, and each crew member confirms — or declines — from their phone, so a gap surfaces while you can still fill it."
            points={[
              'Named crew assignment with per-person pay snapshotted at assign',
              'Confirm, decline, and clock in/out from the field',
              'Recurring contracts that build next week’s routes automatically',
              'Contract routes and one-off customer jobs on a single schedule',
              'Equipment matched to the routes that need it',
            ]}
          />
        </div>
      </section>

      {/* ─────────────────── CREW & ROLES ─────────────────── */}
      <section className="py-24 px-6" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto">
          <Reveal><span className="eyebrow">Role-based experience</span></Reveal>
          <Reveal as="h2" delay={70} className="display-2" style={{ color: '#fff', marginTop: 16, maxWidth: '20ch' }}>
            Every role sees exactly what it needs. Nothing it doesn’t.
          </Reveal>
          <Reveal as="p" delay={130} className="lede" style={{ marginTop: 16, maxWidth: '56ch' }}>
            Access is enforced on the server, not just hidden in the interface — so a crew member’s view is
            genuinely limited to their own work and pay.
          </Reveal>

          <div style={{ marginTop: 44, display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
            {ROLES.map((r, i) => (
              <Reveal key={r.role} delay={i * 70}>
                <div className="ops-card" style={{ padding: 26, height: '100%' }}>
                  <span className="ops-icon" style={{ width: 42, height: 42 }}><r.Icon size={19} strokeWidth={1.6} /></span>
                  <h3 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '1.2rem', color: '#fff', marginTop: 16, letterSpacing: '-0.02em' }}>{r.role}</h3>
                  <p style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.6, marginTop: 8 }}>{r.body}</p>
                  <div style={{ marginTop: 16, display: 'grid', gap: 8, borderTop: '1px solid var(--line)', paddingTop: 16 }}>
                    {r.points.map(p => (
                      <div key={p} style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
                        <span style={{ width: 5, height: 5, borderRadius: 99, background: 'var(--ops-steel)', flexShrink: 0, marginTop: 7 }} />
                        <span style={{ color: 'var(--text)', fontSize: 13.5, lineHeight: 1.5 }}>{p}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ─────────────────── WORKFORCE, TIME & COMPLIANCE ─────────────────── */}
      <section className="py-24 px-6" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto">
          <FeatureRow
            Icon={Clock}
            eyebrow="Workforce & time"
            title="The people side of a trucking operation, not just the trucks."
            body="Drivers, helpers, contractors, and employees live in one roster — with pay rates and rate history, documents, availability, and a reliability record built from how they actually show up. Crew clock in and out from the field, and the clock-in is checked against the job’s own coordinates."
            points={[
              'Driver, helper, contractor, and employee records in one roster',
              'Clock in/out from the field, with timesheets by person and period',
              'A correction never erases the original punch — both stay on the record',
              'Weekly availability and time-off requests feed scheduling',
              'Documents, uniform checks, and W-9 status tracked per person',
            ]}
          />
          <Reveal delay={120}>
            <p style={{ marginTop: 28, fontSize: 12.5, color: 'rgba(255,255,255,.4)', fontFamily: 'var(--font-mono)', maxWidth: '64ch' }}>
              GPS is operational evidence, not a pay input or a verdict — a job with no stored coordinates reads as unverified, never as a failure.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ─────────────────── PAY (cautious wording) ─────────────────── */}
      <section className="py-24 px-6" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto">
          <FeatureRow
            Icon={Wallet}
            eyebrow="Crew pay"
            title="Completed work becomes a clean pay statement."
            body="Payouts are computed from completed routes, adjusted for any claim deductions, and issued as an immutable pay statement each period — with year-to-date earnings a crew member can see for themselves. Year-end readiness is tracked alongside it: who crosses the 1099 reporting threshold, whose W-9 is on file, and what’s still missing."
            points={[
              'Payouts computed from completed routes, not tallied by hand',
              'Claim deductions applied automatically, capped at what was earned',
              'Immutable pay statements with a stable statement number',
              'Crew see their own earnings and can submit a pay-correction request',
              '1099 threshold and W-9 status assessed per person',
            ]}
          />
          <Reveal delay={120}>
            <p style={{ marginTop: 28, fontSize: 12.5, color: 'rgba(255,255,255,.4)', fontFamily: 'var(--font-mono)', maxWidth: '64ch' }}>
              Operion produces 1099 contractor payout statements, earnings summaries, and year-end readiness checks — it does not withhold taxes, run W-2 payroll, or file forms for you.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ─────────────────── COMMUNICATION ─────────────────── */}
      <section className="py-24 px-6" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto">
          <FeatureRow
            flip
            Icon={Bell}
            eyebrow="Communication"
            title="The right message, to the right person, at the right time."
            body="Text and email go out at every step — to the crew and the customer — without anyone remembering to send them. Replies land in one inbox, threaded to the job they belong to, and a customer reply automatically pauses the reminders so no one gets nagged after they’ve answered."
            points={[
              'Automatic step-by-step texts and emails',
              'Inbound replies threaded to the right job',
              'Crew reminders: please-confirm, morning-of, no-response alerts',
              'A delivery ledger for every message sent',
            ]}
          />
        </div>
      </section>

      {/* ─────────────────── EQUIPMENT, CLAIMS & ANALYTICS ─────────────────── */}
      <section className="py-24 px-6" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto">
          <div className="tour-split">
            <Reveal>
              <span className="ops-icon" style={{ width: 44, height: 44 }}><Boxes size={20} strokeWidth={1.6} /></span>
              <h3 className="display-2" style={{ color: '#fff', marginTop: 16, maxWidth: '16ch' }}>Fleet, claims & accountability.</h3>
              <p className="lede" style={{ marginTop: 14, maxWidth: '50ch' }}>
                Track trucks and gear by ownership, with service and inspection intervals per vehicle —
                anything out of service is benched and can’t be dispatched. When a claim is opened, it’s
                logged against the route, the crew, and the client. If a crew member is responsible, recovery
                schedules fairly against their pay, capped at what they earned, and never silently forgiven.
              </p>
              <div style={{ marginTop: 18, display: 'grid', gap: 8 }}>
                {['Equipment inventory, company- or contractor-owned', 'Maintenance and inspection intervals per vehicle', 'Out-of-service equipment refused on dispatch', 'Claims with evidence, status, and audit history', 'Fair, capped crew cost recovery — on the record'].map(p => (
                  <div key={p} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <span style={{ width: 5, height: 5, borderRadius: 99, background: 'var(--ops-steel)', flexShrink: 0, marginTop: 7 }} />
                    <span style={{ color: 'var(--text)', fontSize: 14, lineHeight: 1.5 }}>{p}</span>
                  </div>
                ))}
              </div>
            </Reveal>
            <Reveal delay={100}>
              <span className="ops-icon" style={{ width: 44, height: 44 }}><BarChart3 size={20} strokeWidth={1.6} /></span>
              <h3 className="display-2" style={{ color: '#fff', marginTop: 16, maxWidth: '16ch' }}>See the business, not just today’s jobs.</h3>
              <p className="lede" style={{ marginTop: 14, maxWidth: '50ch' }}>
                An owner dashboard pulls the whole operation together: the booking pipeline, revenue by service,
                crew and route performance, and the handful of things that actually need a decision today.
              </p>
              <div style={{ marginTop: 18, display: 'grid', gap: 8 }}>
                {['Booking pipeline and revenue by service', 'Crew and route performance trends', 'Revenue and claims-recovery reports, exportable as CSV', 'First-party traffic — top paths and referrers', 'Attention-required items surfaced first'].map(p => (
                  <div key={p} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <span style={{ width: 5, height: 5, borderRadius: 99, background: 'var(--ops-steel)', flexShrink: 0, marginTop: 7 }} />
                    <span style={{ color: 'var(--text)', fontSize: 14, lineHeight: 1.5 }}>{p}</span>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ─────────────────── INDUSTRIES ─────────────────── */}
      <section className="py-24 px-6" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto">
          <Reveal><span className="eyebrow">Built for different operations</span></Reveal>
          <Reveal as="h2" delay={70} className="display-2" style={{ color: '#fff', marginTop: 16, maxWidth: '20ch' }}>
            Built for your operation. Configured for your workflow.
          </Reveal>
          <Reveal as="p" delay={130} className="lede" style={{ marginTop: 16, maxWidth: '56ch' }}>
            The same core modules, arranged around the kind of work you do. Pick an operation to see how it fits.
          </Reveal>
          <Reveal delay={160}>
            <div style={{ marginTop: 36 }}>
              <IndustrySelector />
            </div>
          </Reveal>
        </div>
      </section>

      {/* ─────────────────── MOBILE ─────────────────── */}
      <section className="py-24 px-6" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto">
          <div className="tour-split" style={{ alignItems: 'center' }}>
            <Reveal>
              <span className="eyebrow">In the field</span>
              <h2 className="display-2" style={{ color: '#fff', marginTop: 16, maxWidth: '16ch' }}>The office travels with the operation.</h2>
              <p className="lede" style={{ marginTop: 16, maxWidth: '50ch' }}>
                Operion is mobile-first where it counts. Crews confirm routes, clock in, read messages, and
                check pay from their phone. Owners get the same command center on a laptop or in their pocket —
                the page never scrolls sideways and touch targets stay honest.
              </p>
              <div style={{ marginTop: 18, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {['Route details', 'Confirmations', 'Clock in/out', 'Availability', 'Time off', 'Documents', 'Messages', 'Pay'].map(t => (
                  <span key={t} className="ops-badge">{t}</span>
                ))}
              </div>
            </Reveal>
            <Reveal delay={100}>
              <div style={{ display: 'flex', gap: 14, justifyContent: 'center' }}>
                {[
                  { title: 'Your route', rows: [['Tue', '7:30 AM'], ['Garage cleanout', 'JK-B-1042'], ['Pay', 'Confirmed']], cta: 'Clock in' },
                  { title: 'Your pay', rows: [['This week', '$—'], ['Statement', 'JK-PS-318'], ['YTD', 'Updated']], cta: 'View statement' },
                ].map((card, i) => (
                  <div key={card.title} className="ops-card" style={{ padding: 16, width: 'min(180px, 44vw)', background: '#141416', marginTop: i === 1 ? 24 : 0 }}>
                    <p style={{ color: '#fff', fontWeight: 600, fontSize: 13 }}>{card.title}</p>
                    <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
                      {card.rows.map(([k, v]) => (
                        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                          <span style={{ color: 'var(--ops-steel-dim)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>{k}</span>
                          <span className="break-anywhere" style={{ color: 'var(--text)', fontSize: 11.5, fontWeight: 600, textAlign: 'right' }}>{v}</span>
                        </div>
                      ))}
                    </div>
                    <div style={{ marginTop: 14, padding: '8px 10px', borderRadius: 9, background: 'var(--ops-steel)', color: '#0b0b0c', fontWeight: 700, fontSize: 11.5, textAlign: 'center' }}>{card.cta}</div>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ─────────────────── PLATFORM & SECURITY ─────────────────── */}
      <section className="py-24 px-6" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto">
          <div className="tour-split">
            <Reveal>
              <span className="ops-icon" style={{ width: 44, height: 44 }}><Layers size={20} strokeWidth={1.6} /></span>
              <h3 className="display-2" style={{ color: '#fff', marginTop: 16, maxWidth: '16ch' }}>A platform that keeps improving.</h3>
              <p className="lede" style={{ marginTop: 14, maxWidth: '50ch' }}>
                Operion is centrally managed software, not a box you install and outgrow. Improvements ship
                over time, and your operation is set up around how it actually runs — your pricing rules, pay
                rates, contract terms, and recurring routes — so your workflow is respected while the platform
                gets better underneath you.
              </p>
              <div style={{ marginTop: 18, display: 'grid', gap: 8 }}>
                {['Managed, continuously improved platform', 'Your pricing, pay rates, and contracts, configured to your business', 'Your operational workflow stays intact', 'Releases validated before they reach you'].map(p => (
                  <div key={p} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <span style={{ width: 5, height: 5, borderRadius: 99, background: 'var(--ops-steel)', flexShrink: 0, marginTop: 7 }} />
                    <span style={{ color: 'var(--text)', fontSize: 14, lineHeight: 1.5 }}>{p}</span>
                  </div>
                ))}
              </div>
            </Reveal>
            <Reveal delay={100}>
              <span className="ops-icon" style={{ width: 44, height: 44 }}><Lock size={20} strokeWidth={1.6} /></span>
              <h3 className="display-2" style={{ color: '#fff', marginTop: 16, maxWidth: '16ch' }}>Control, on the record.</h3>
              <p className="lede" style={{ marginTop: 14, maxWidth: '50ch' }}>
                Access is role-based and enforced on the server. Every status change is written to an audit
                trail, sensitive proof is encrypted, and financial actions are gated to the roles that should
                hold them.
              </p>
              <div style={{ marginTop: 18, display: 'grid', gap: 8 }}>
                {['Role-based access, enforced server-side', 'Audit history on every transition', 'Sensitive payment proof encrypted at rest', 'Owner-only financial and configuration controls'].map(p => (
                  <div key={p} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <span style={{ width: 5, height: 5, borderRadius: 99, background: 'var(--ops-steel)', flexShrink: 0, marginTop: 7 }} />
                    <span style={{ color: 'var(--text)', fontSize: 14, lineHeight: 1.5 }}>{p}</span>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ─────────────────── PRODUCT STORY ─────────────────── */}
      <section className="py-24 px-6" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-4xl mx-auto">
          <Reveal><span className="eyebrow">Where it came from</span></Reveal>
          <Reveal as="h2" delay={70} className="display-2" style={{ color: '#fff', marginTop: 16, maxWidth: '22ch' }}>
            Not designed in a boardroom. Built inside a working company.
          </Reveal>
          <Reveal delay={130}>
            <div style={{ marginTop: 20, display: 'grid', gap: 18, maxWidth: '62ch' }}>
              <p style={{ color: 'var(--muted)', fontSize: 16, lineHeight: 1.75 }}>
                {COMPANY.legalName} is a Dallas–Fort Worth carrier: box trucks, contract delivery routes, and
                crews on the road every day — with junk removal and cleanouts as the on-demand side of the
                business. We lived the actual problems. Routes rebuilt by hand every week, crews that didn’t
                confirm, hours tallied from memory, pay math in a notebook, equipment nobody could account for.
              </p>
              <p style={{ color: 'var(--muted)', fontSize: 16, lineHeight: 1.75 }}>
                Nothing off the shelf fit how a small carrier really runs, so we built the system we needed —
                dispatch, crew, time, equipment, and money in one place, one job flowing cleanly from
                assignment to payout. Every capability on this page is software we dispatch with every
                morning. Today a second Dallas–Fort Worth business runs on Operion too, and it is opening up
                to more.
              </p>
            </div>
          </Reveal>
          <Reveal delay={180}>
            <div style={{ marginTop: 30, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <span className="ops-badge">Built In-House</span>
              <span className="ops-badge">Running in Production</span>
              <span className="ops-badge">Two businesses running on it</span>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ─────────────────── FAQ ─────────────────── */}
      <section className="py-24 px-6" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-4xl mx-auto">
          <Reveal style={{ textAlign: 'center' }}><span className="eyebrow" style={{ justifyContent: 'center' }}>Good questions</span></Reveal>
          <Reveal as="h2" delay={70} className="display-2" style={{ color: '#fff', marginTop: 16, textAlign: 'center' }}>
            Everything you’re wondering.
          </Reveal>
          <div style={{ marginTop: 40 }}>
            <OperionFAQ />
          </div>
        </div>
      </section>

      {/* ─────────────────── FINAL CTA + DEMO FORM ─────────────────── */}
      <section id="request" className="py-24 px-6" style={{ scrollMarginTop: 80 }}>
        <div className="max-w-4xl mx-auto">
          <Reveal>
            <div className="glass-card" style={{ padding: 'clamp(28px, 5vw, 54px)', borderRadius: 24, background: 'linear-gradient(135deg, rgba(204,212,224,.05), rgba(255,255,255,.015))' }}>
              <span className="eyebrow">Request access</span>
              <h2 className="display-2" style={{ color: '#fff', marginTop: 16, maxWidth: '20ch' }}>
                Your operation has outgrown disconnected tools.
              </h2>
              <p className="lede" style={{ marginTop: 16, maxWidth: '56ch' }}>
                Bring dispatch, crews, hours, equipment, and money into one connected system. Tell us how your
                operation runs and we’ll show you Operion.
              </p>
              <div style={{ marginTop: 32 }}>
                <RequestDemoForm source="/operion" />
              </div>
            </div>
          </Reveal>

          <Reveal delay={120}>
            <div style={{ marginTop: 40, textAlign: 'center' }}>
              <p style={{ fontSize: 14, color: 'var(--muted)' }}>Prefer to talk it through, or looking to move freight instead?</p>
              <div style={{ marginTop: 12, display: 'inline-flex', gap: 20, flexWrap: 'wrap', justifyContent: 'center' }}>
                <a href={`mailto:${COMPANY.email}`} style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--ops-steel)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  Talk to J KISS <ArrowRight size={15} />
                </a>
                <Link href="/quote" style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--red)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  Get a freight quote <ArrowRight size={15} />
                </Link>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      <SiteFooter platformBand={false} />
    </main>
  );
}
