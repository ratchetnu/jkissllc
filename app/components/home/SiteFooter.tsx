import PoweredByBand from '../opspilot/PoweredByBand';
import { COMPANY, CREDENTIALS_DOT } from '../../lib/company';

// Root-relative, not bare hashes: this footer now renders on /about and /opspilot
// too, where "#services" would scroll to nothing. "/#services" works from anywhere.
const FOOTER_LINKS: [string, string][] = [
  ['Get My Quote', '/quote'],
  ['Track a Job', '/track'],
  ['Request COI', '/coi'],
  ['Safety / FMCSA', '/safety'],
  ['Reviews', '/reviews'],
  ['Careers', '/careers'],
  ['Carrier Guide', '/start-your-carrier'],
  ['About', '/about'],
  ['OpsPilot', '/opspilot'],
  ['Services', '/#services'],
  ['Contact', '/#contact'],
];

/**
 * Dark footer close.
 *
 * `platformBand` is suppressed on /opspilot itself — a "Powered by OpsPilot →
 * Learn more" band that links to the page you're already reading is noise.
 */
export default function SiteFooter({ platformBand = true }: { platformBand?: boolean }) {
  return (
    <footer className="py-12 px-6" style={{ background: 'var(--bg)', borderTop: '1px solid var(--line)' }}>
      <div className="max-w-6xl mx-auto">
        {/* The platform, stated once, quietly — above the company close. */}
        {platformBand && <PoweredByBand />}

        <div className="flex flex-col md:flex-row items-start justify-between gap-8 mb-10">
          <div>
            <p className="text-xl font-black text-white mb-2" style={{ letterSpacing: '-0.03em' }}>
              {COMPANY.nameLead} <span style={{ color: 'var(--red)' }}>{COMPANY.nameAccent}</span>
            </p>
            <p className="text-sm" style={{ color: 'var(--muted)' }}>{COMPANY.tagline}</p>
            <p className="text-xs mt-3 font-mono" style={{ color: 'rgba(255,255,255,.6)' }}>{CREDENTIALS_DOT}</p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-8 gap-y-2 text-sm" style={{ color: 'var(--muted)' }}>
            {FOOTER_LINKS.map(([label, href]) => (
              <a key={label} href={href} className="transition hover:text-white">{label}</a>
            ))}
          </div>
        </div>
        <div className="pt-8 text-xs flex flex-col md:flex-row items-center justify-between gap-3" style={{ borderTop: '1px solid var(--line)', color: 'rgba(255,255,255,.55)' }}>
          <p>© {new Date().getFullYear()} {COMPANY.legalName}. All rights reserved.</p>
          <div className="flex items-center gap-4">
            <a href={`tel:${COMPANY.phoneE164}`} className="transition hover:text-white">{COMPANY.phoneDisplay}</a>
            <a href={`mailto:${COMPANY.email}`} className="transition hover:text-white">{COMPANY.email}</a>
            <a href="/admin/bookings" className="px-3 py-1.5 rounded-lg font-semibold transition hover:text-white" style={{ background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', color: 'var(--muted)' }}>Admin</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
