import PoweredByBand from '../opspilot/PoweredByBand';

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
              J Kiss <span style={{ color: 'var(--red)' }}>LLC</span>
            </p>
            <p className="text-sm" style={{ color: 'var(--muted)' }}>Box-Truck Delivery, Junk Removal &amp; Cleanouts · Dallas–Fort Worth</p>
            <p className="text-xs mt-3 font-mono" style={{ color: 'rgba(255,255,255,.6)' }}>US DOT 3484556 · MC 01155352</p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-8 gap-y-2 text-sm" style={{ color: 'var(--muted)' }}>
            {FOOTER_LINKS.map(([label, href]) => (
              <a key={label} href={href} className="transition hover:text-white">{label}</a>
            ))}
          </div>
        </div>
        <div className="pt-8 text-xs flex flex-col md:flex-row items-center justify-between gap-3" style={{ borderTop: '1px solid var(--line)', color: 'rgba(255,255,255,.55)' }}>
          <p>© {new Date().getFullYear()} J Kiss LLC. All rights reserved.</p>
          <div className="flex items-center gap-4">
            <a href="tel:+18179094312" className="transition hover:text-white">(817) 909-4312</a>
            <a href="mailto:info@jkissllc.com" className="transition hover:text-white">info@jkissllc.com</a>
            <a href="/admin/bookings" className="px-3 py-1.5 rounded-lg font-semibold transition hover:text-white" style={{ background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', color: 'var(--muted)' }}>Admin</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
