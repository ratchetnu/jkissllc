import { ClipboardList, ShieldCheck, CalendarDays, Truck, Ban, DollarSign, FileText, Zap } from 'lucide-react';
import Reveal from './components/Reveal';
import SiteChrome from './components/home/SiteChrome';
import SiteNav from './components/home/SiteNav';
import Hero from './components/home/Hero';
import ChooseService from './components/home/ChooseService';
import HowItWorks from './components/home/HowItWorks';
import Industries from './components/home/Industries';
import TrustBand from './components/home/TrustBand';
import Projects from './components/home/Projects';
import Reviews from './components/home/Reviews';
import CoverageSection from './components/home/CoverageSection';
import QuoteCTA from './components/home/QuoteCTA';
import FAQ from './components/home/FAQ';
import ContactSection from './components/home/ContactSection';
import SiteFooter from './components/home/SiteFooter';

const CARRIER_CARDS = [
  { Icon: ClipboardList, title: '12-Step Startup Checklist', desc: 'USDOT, authority, BOC-3, insurance, DOT compliance — sequenced in order.' },
  { Icon: ShieldCheck, title: 'Insurance Requirements', desc: 'Federal & Texas minimums broken down by vehicle type and cargo.' },
  { Icon: CalendarDays, title: 'Compliance Calendar', desc: 'Monthly, quarterly, and annual checkpoints to stay audit-ready.' },
  { Icon: Truck, title: 'Weight-Class Comparison', desc: 'Non-CDL box truck vs. Class B vs. Class A — what applies, what doesn’t.' },
];

const CLAIMGUARD_CARDS = [
  { Icon: Ban, title: 'Claim Denied?', desc: 'Understand why and what your options are to fight back.' },
  { Icon: DollarSign, title: 'Unpaid Invoices', desc: 'Brokers and carriers stiffing you on payment? Know your rights.' },
  { Icon: FileText, title: 'Confusing Paperwork', desc: 'We break down the forms, filings, and deadlines in plain English.' },
  { Icon: Zap, title: 'Fast Answers', desc: 'No waiting. Get guidance on your situation right away.' },
];

export default function Home() {
  return (
    <main id="top" style={{ background: 'var(--bg)' }}>
      <SiteChrome />
      <SiteNav />

      {/* ── Core customer journey ── */}
      <Hero />
      <ChooseService />
      <HowItWorks />
      <Industries />
      <TrustBand />
      <Projects />
      <Reviews />
      <CoverageSection />

      {/* ── Secondary resource: carrier startup guide (existing funnel, preserved) ── */}
      <section className="section section-light">
        <div className="wrap">
          <div style={{ borderRadius: 26, overflow: 'hidden', padding: 'clamp(32px,5vw,56px)', background: 'linear-gradient(135deg, #1a0508 0%, #0b0b0c 60%)', border: '1px solid rgba(224,0,42,.25)' }}>
            <div className="grid md:grid-cols-2 gap-10 items-center">
              <Reveal>
                <span className="eyebrow">Free industry guide</span>
                <h2 className="display-2" style={{ color: '#fff', marginTop: 16 }}>
                  Starting a motor carrier<br />business in <span style={{ color: 'var(--red)' }}>Texas?</span>
                </h2>
                <p style={{ color: 'var(--muted)', fontSize: 15.5, lineHeight: 1.65, marginTop: 16, maxWidth: '48ch' }}>
                  We put together a complete guide based on 5+ years running box-truck delivery in DFW
                  (in business since September 2020). Every federal and state requirement broken down by
                  weight class — non-CDL under 26K, Class B over 26K, and Class A semi — plus a compliance
                  calendar so you never miss a deadline.
                </p>
                <a href="/start-your-carrier" className="btn" style={{ marginTop: 26, width: 'fit-content' }}>Read the Free Guide</a>
              </Reveal>
              <Reveal delay={100}>
                <div className="grid grid-cols-2 gap-4">
                  {CARRIER_CARDS.map((c) => (
                    <div key={c.title} className="spotlight-card glass-card" style={{ padding: 20, borderRadius: 16 }}>
                      <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg" style={{ background: 'rgba(224,0,42,.12)', border: '1px solid rgba(224,0,42,.22)' }}>
                        <c.Icon size={20} strokeWidth={1.75} color="#ff6680" />
                      </span>
                      <p className="text-sm font-black text-white mb-1" style={{ marginTop: 12, letterSpacing: '-0.01em' }}>{c.title}</p>
                      <p className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>{c.desc}</p>
                    </div>
                  ))}
                </div>
              </Reveal>
            </div>
          </div>
        </div>
      </section>

      {/* ── ClaimGuard cross-promo ── */}
      <section className="section section-alt">
        <div className="wrap">
          <Reveal>
            <a href="https://www.claimguardhelp.com" target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', display: 'block' }}>
              <div className="transition-all hover:scale-[1.005]" style={{ borderRadius: 26, padding: 'clamp(32px,5vw,56px)', background: 'linear-gradient(135deg, #030d1a 0%, #071a30 50%, #0b0b0c 100%)', border: '1px solid rgba(30,120,255,.3)', cursor: 'pointer' }}>
                <div className="grid md:grid-cols-2 gap-10 items-center">
                  <div>
                    <span className="inline-block text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full mb-6" style={{ background: 'rgba(30,120,255,.15)', border: '1px solid rgba(30,120,255,.3)', color: '#4d9fff', letterSpacing: '0.12em' }}>Partner Resource</span>
                    <h2 className="display-2" style={{ color: '#fff' }}>
                      Got a claim denied?<br /><span style={{ color: '#4d9fff' }}>We can help.</span>
                    </h2>
                    <p style={{ color: 'rgba(255,255,255,.55)', fontSize: 15.5, lineHeight: 1.65, marginTop: 16, maxWidth: '48ch' }}>
                      Independent contractors and owner-operators get stuck with denied claims, delayed
                      payments, and confusing paperwork every day. <strong className="text-white">ClaimGuard Help</strong> is
                      built for contractors who need someone in their corner — just straight answers and
                      real help getting what you’re owed.
                    </p>
                    <span className="inline-flex items-center gap-2 font-bold text-sm px-6 py-3 rounded-xl" style={{ background: '#1e78ff', color: '#fff', borderRadius: 12, marginTop: 24 }}>
                      Get Help with Your Claim →
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    {CLAIMGUARD_CARDS.map((c) => (
                      <div key={c.title} className="spotlight-card spotlight-blue" style={{ padding: 20, borderRadius: 16, background: 'rgba(30,120,255,.07)', border: '1px solid rgba(30,120,255,.15)' }}>
                        <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg" style={{ background: 'rgba(30,120,255,.12)', border: '1px solid rgba(30,120,255,.25)' }}>
                          <c.Icon size={20} strokeWidth={1.75} color="#4d9fff" />
                        </span>
                        <p className="text-sm font-black text-white mb-1" style={{ marginTop: 12 }}>{c.title}</p>
                        <p className="text-xs leading-relaxed" style={{ color: 'rgba(255,255,255,.72)' }}>{c.desc}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </a>
          </Reveal>
        </div>
      </section>

      <QuoteCTA />
      <FAQ />
      <ContactSection />
      <SiteFooter />
    </main>
  );
}
