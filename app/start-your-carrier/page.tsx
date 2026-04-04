'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'

function useFadeUp() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { el.classList.add('visible'); obs.disconnect() }
    }, { threshold: 0.08 })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])
  return ref
}

function FadeUp({ children, delay = 0, className = '' }: { children: React.ReactNode; delay?: number; className?: string }) {
  const ref = useFadeUp()
  return (
    <div ref={ref} className={`fade-up ${className}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  )
}

// ── Data ─────────────────────────────────────────────────────────────────────

const STARTUP_STEPS = [
  {
    step: '01',
    time: 'Day 1',
    title: 'Form Your Business Entity',
    desc: 'Register your LLC or corporation with the Texas Secretary of State. Get an EIN from the IRS (free, same day online). Open a dedicated business bank account.',
    links: [
      { label: 'TX Secretary of State', url: 'https://www.sos.state.tx.us' },
      { label: 'IRS EIN Application', url: 'https://www.irs.gov/businesses/small-businesses-self-employed/apply-for-an-employer-identification-number-ein-online' },
    ],
  },
  {
    step: '02',
    time: 'Day 1–3',
    title: 'Apply for Your USDOT Number',
    desc: 'All carriers operating commercial vehicles in interstate commerce must register with FMCSA. Apply through the Unified Registration System (URS) or the new Motus platform. This number is your federal identifier — it replaced the standalone MC number as of October 2025.',
    links: [
      { label: 'FMCSA Registration (Motus)', url: 'https://www.fmcsa.dot.gov/registration' },
    ],
  },
  {
    step: '03',
    time: 'Day 1–3',
    title: 'Apply for Operating Authority',
    desc: 'Interstate carriers hauling regulated freight must apply for operating authority (formerly the MC number). The $300 non-refundable fee starts a 21-day protest period. Your authority status will show as "Pending" until all insurance and BOC-3 filings are received.',
    links: [
      { label: 'FMCSA Operating Authority', url: 'https://www.fmcsa.dot.gov/registration/get-mc-number-authority-operate' },
    ],
  },
  {
    step: '04',
    time: 'Same Day as Step 03',
    title: 'File Your BOC-3 (Process Agent)',
    desc: 'A BOC-3 designates a legal process agent in every state where you operate. You cannot activate your authority without it. File through a registered process agent service — costs are typically $25–$50 one-time.',
    links: [
      { label: 'Find BOC-3 Filers', url: 'https://www.fmcsa.dot.gov/registration/registration-forms' },
    ],
  },
  {
    step: '05',
    time: 'Week 1–2',
    title: 'Secure Your Insurance & File with FMCSA',
    desc: 'Your insurer must file proof of coverage directly with FMCSA using Form MCS-90. Coverage minimums:\n• Interstate, non-hazardous cargo (10,001+ lbs): $750,000 CSL\n• Hauling oil or hopper vehicles: $1,000,000 CSL\n• Hazardous materials: $5,000,000 CSL\n• Texas intrastate only: $500,000 CSL\nInsurance must be active before authority activates.',
    links: [
      { label: 'FMCSA Insurance Requirements', url: 'https://www.fmcsa.dot.gov/registration/insurance-filing-requirements' },
    ],
  },
  {
    step: '06',
    time: 'Week 2–3',
    title: 'Register with Texas DMV (Intrastate or IRP)',
    desc: 'If you operate intrastate (Texas only), register with TxDMV Motor Carrier Division and obtain your TxDMV number. For interstate operations, register under the International Registration Plan (IRP) through TxDMV to get apportioned plates that cover all 48 contiguous states.',
    links: [
      { label: 'TxDMV Motor Carrier', url: 'https://www.txdmv.gov/motor-carriers/how-to-be-a-motor-carrier' },
      { label: 'TxDMV IRP (Apportioned Plates)', url: 'https://www.txdmv.gov/motor-carriers/commercial-fleet-registration/apportioned-registration' },
    ],
  },
  {
    step: '07',
    time: 'Week 2–3',
    title: 'Register for IFTA (Fuel Tax)',
    desc: 'If your truck exceeds 26,000 lbs GVWR and crosses state lines, you need an IFTA license from the Texas Comptroller. IFTA simplifies fuel tax — you file one quarterly return instead of separate returns in each state you operated in.',
    links: [
      { label: 'Texas IFTA Registration', url: 'https://comptroller.texas.gov/taxes/motor-fuel/ifta/' },
    ],
  },
  {
    step: '08',
    time: 'Week 3',
    title: 'Complete UCR Registration',
    desc: 'Unified Carrier Registration (UCR) is an annual federal registration for interstate carriers with vehicles weighing 10,001 lbs or more. Fees are based on fleet size. Renews each year — TxDMV IRP renewal requires current UCR.',
    links: [
      { label: 'UCR Registration', url: 'https://www.ucr.gov' },
      { label: 'TxDMV UCR Info', url: 'https://www.txdmv.gov/motor-carriers/unified-carrier-registration' },
    ],
  },
  {
    step: '09',
    time: 'Before First Load',
    title: 'Set Up ELD & Hours of Service',
    desc: 'Electronic Logging Devices (ELDs) are mandatory for most CDL drivers. Your ELD must be FMCSA-registered. Train your drivers on Hours of Service (HOS) rules. Retain ELD records for at least 6 months.',
    links: [
      { label: 'FMCSA ELD Checklist', url: 'https://www.fmcsa.dot.gov/hours-service/elds/eld-checklist-carriers' },
    ],
  },
  {
    step: '10',
    time: 'Before First Load',
    title: 'Establish Drug & Alcohol Testing Program',
    desc: 'All CDL drivers must be enrolled in a DOT-compliant drug and alcohol testing consortium. Required test types: pre-employment, random (50% drug / 10% alcohol annually), post-accident, reasonable suspicion, return-to-duty, and follow-up. Maintain all testing records for 5 years.',
    links: [
      { label: 'FMCSA Drug Testing', url: 'https://www.fmcsa.dot.gov/regulations/drug-alcohol-testing/overview-drug-alcohol-rules' },
    ],
  },
  {
    step: '11',
    time: 'Before First Load',
    title: 'Build Your Driver Qualification File',
    desc: 'Every driver must have a complete DQ file including: valid CDL, medical examiner certificate (DOT physical), motor vehicle record (MVR), PSP (Pre-Employment Screening Program) report, employment history (3 years), and signed drug testing consent. Review annually.',
    links: [
      { label: 'FMCSA Driver Qualification', url: 'https://www.fmcsa.dot.gov/regulations/title49/part391' },
    ],
  },
  {
    step: '12',
    time: 'Before First Load',
    title: 'Annual Vehicle Inspection & DVIR',
    desc: 'Every commercial vehicle must pass an annual inspection by a qualified inspector. Drivers must complete a pre- and post-trip Driver Vehicle Inspection Report (DVIR) for every run. Keep inspection records for 14 months.',
    links: [],
  },
]

const MONTHLY = [
  'Review driver Hours of Service (HOS) logs for violations',
  'Verify all ELD records are backed up and stored',
  'Confirm drug testing pool is current and compliant',
  'Check vehicle maintenance logs — oil changes, tire checks, brake inspections',
  'Review any roadside inspection reports (DataQ challenges if needed)',
  'Confirm all drivers have valid CDLs and current medical certificates',
  'Reconcile fuel receipts with IFTA mileage logs',
  'Review insurance policy — no lapses, coverage still adequate',
  'Check for any FMCSA compliance alerts or safety score changes (SMS)',
]

const QUARTERLY = [
  'File IFTA fuel tax return (due: Jan 31, Apr 30, Jul 31, Oct 31)',
  'Conduct internal mock DOT audit — review DQ files, maintenance records, ELD data',
  'Run MVR (Motor Vehicle Record) checks on all drivers',
  'Review Compliance, Safety, Accountability (CSA) scores at safer.fmcsa.dot.gov',
  'Confirm random drug testing selections have been completed at required rates',
  'Review and update accident register with any incidents',
  'Verify BOC-3 filing is still active and agents are reachable',
  'Review operating revenue vs. expenses — fuel, insurance, maintenance',
  'Check for any changes to FMCSA or TxDMV regulations',
]

const ANNUAL = [
  'Renew UCR registration (opens Oct 1 each year, enforced Jan 1)',
  'Renew IRP apportioned plates through TxDMV',
  'Update MCS-150 (USDOT biennial update — required every 2 years, but review annually)',
  'Renew IFTA license (Texas Comptroller — January)',
  'Renew all commercial vehicle registrations',
  'Complete annual vehicle inspections for entire fleet',
  'Review and renew insurance policies — shop rates if needed',
  'Review all driver qualification files — update MVRs, medical certs, employment history',
  'Review and update safety management plan and driver handbook',
  'File Texas franchise tax report (if applicable to your entity type)',
  'Review profit and loss — plan for next year\'s fleet, fuel, and insurance costs',
  'Confirm ELD provider subscription is active and device firmware is updated',
]

const BOX_TRUCK_COMPARE = [
  {
    req: 'CDL Required',
    boxUnder: { text: 'No — standard license', ok: true },
    boxOver:  { text: 'Class B CDL', ok: false },
    semi:     { text: 'Class A CDL', ok: false },
  },
  {
    req: 'USDOT Number',
    boxUnder: { text: 'Yes — if interstate & 10,001+ lbs', ok: false },
    boxOver:  { text: 'Yes — required', ok: false },
    semi:     { text: 'Yes — required', ok: false },
  },
  {
    req: 'DOT Medical Card',
    boxUnder: { text: 'Yes — if 10,001+ lbs interstate', ok: false },
    boxOver:  { text: 'Yes — required', ok: false },
    semi:     { text: 'Yes — required', ok: false },
  },
  {
    req: 'Operating Authority',
    boxUnder: { text: 'Yes — for-hire interstate', ok: false },
    boxOver:  { text: 'Yes — required', ok: false },
    semi:     { text: 'Yes — required', ok: false },
  },
  {
    req: 'ELD / HOS',
    boxUnder: { text: '150-mile short-haul exemption available', ok: true },
    boxOver:  { text: 'Full ELD — short-haul exemption still possible within 150 mi', ok: false },
    semi:     { text: 'Full ELD & HOS — no exemption on most runs', ok: false },
  },
  {
    req: 'IFTA Fuel Tax',
    boxUnder: { text: 'NOT required', ok: true },
    boxOver:  { text: 'Required — quarterly', ok: false },
    semi:     { text: 'Required — quarterly', ok: false },
  },
  {
    req: 'IRP Plates',
    boxUnder: { text: 'NOT required', ok: true },
    boxOver:  { text: 'Required interstate', ok: false },
    semi:     { text: 'Required interstate', ok: false },
  },
  {
    req: 'Insurance Min. (Interstate)',
    boxUnder: { text: '$750K CSL (brokers require $1M)', ok: false },
    boxOver:  { text: '$750K CSL (brokers require $1M)', ok: false },
    semi:     { text: '$750K CSL (brokers require $1M)', ok: false },
  },
  {
    req: 'UCR Registration',
    boxUnder: { text: 'Yes — for-hire interstate 10,001+ lbs', ok: false },
    boxOver:  { text: 'Yes — required', ok: false },
    semi:     { text: 'Yes — required', ok: false },
  },
  {
    req: 'Drug & Alcohol Testing',
    boxUnder: { text: 'Yes — if CDL not required, still applies for interstate CMV', ok: false },
    boxOver:  { text: 'Yes — full program required', ok: false },
    semi:     { text: 'Yes — full program required', ok: false },
  },
]

const AUTHORITY_TIMELINE = [
  { day: 'Day 1–3', event: 'Submit USDOT + Operating Authority application', note: 'Pay $300 non-refundable fee. 21-day protest period starts immediately.' },
  { day: 'Day 1–3', event: 'File BOC-3 process agent', note: 'Must be done same week as authority application. Authority will not activate without it.' },
  { day: 'Day 1–7', event: 'Secure insurance & insurer files MCS-90 with FMCSA', note: 'Your insurance provider files electronically. Can take 3–7 business days to show in FMCSA system.' },
  { day: 'Day 21', event: '21-day protest period ends', note: 'If no protests filed, FMCSA reviews your application for activation.' },
  { day: 'Day 21–30', event: 'Authority activates — status changes to "Active"', note: 'FMCSA confirms BOC-3 on file + insurance on file + protest period complete. Check at safer.fmcsa.dot.gov.' },
  { day: 'After Active', event: 'Register UCR, IRP (if applicable), IFTA (if applicable)', note: 'These can be done during the waiting period but are enforced once you start operating.' },
]

// ── Page ─────────────────────────────────────────────────────────────────────

export default function StartYourCarrierPage() {
  return (
    <main style={{ background: 'var(--bg)', color: 'var(--text)' }}>

      {/* ── Nav back ── */}
      <div className="fixed top-0 left-0 right-0 z-50" style={{ background: 'rgba(11,11,12,0.95)', backdropFilter: 'blur(12px)', borderBottom: '1px solid rgba(255,255,255,.08)' }}>
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="text-xl font-black tracking-tight" style={{ color: '#fff', letterSpacing: '-0.03em', textDecoration: 'none' }}>
            J Kiss <span style={{ color: 'var(--red)' }}>LLC</span>
          </Link>
          <Link href="/#contact" className="btn" style={{ padding: '10px 20px', fontSize: '13px' }}>Get a Quote</Link>
        </div>
      </div>

      {/* ── Hero ── */}
      <section className="pt-36 pb-20 px-6" style={{ background: 'linear-gradient(135deg, #0b0b0c 0%, #1a0508 100%)', borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-4xl mx-auto">
          <FadeUp>
            <div className="label mb-6">Free Industry Guide</div>
            <h1 className="font-black text-white mb-6" style={{ fontSize: 'clamp(2rem, 4.5vw, 3.5rem)', lineHeight: 1.1, letterSpacing: '-0.04em' }}>
              How to Start a Motor Carrier<br />
              Business in <span style={{ color: 'var(--red)' }}>Texas</span>
            </h1>
            <p className="text-lg max-w-2xl leading-relaxed" style={{ color: 'var(--muted)' }}>
              A step-by-step guide covering every federal and state requirement — from your USDOT number to your first load. Includes a full compliance calendar so you stay legal and audit-ready.
            </p>
            <div className="mt-8 flex flex-wrap gap-4 text-sm font-semibold" style={{ color: 'rgba(255,255,255,.35)' }}>
              <span>✓ FMCSA / USDOT</span>
              <span>✓ Texas TxDMV</span>
              <span>✓ Insurance Requirements</span>
              <span>✓ IFTA &amp; IRP</span>
              <span>✓ ELD &amp; Drug Testing</span>
              <span>✓ Compliance Calendar</span>
            </div>
          </FadeUp>
        </div>
      </section>

      {/* ── Disclaimer ── */}
      <div className="px-6 py-5" style={{ background: 'rgba(224,0,42,.06)', borderBottom: '1px solid rgba(224,0,42,.18)' }}>
        <div className="max-w-4xl mx-auto">
          <p className="text-xs leading-relaxed" style={{ color: 'rgba(255,255,255,.45)' }}>
            <strong style={{ color: 'rgba(255,255,255,.6)' }}>Disclaimer:</strong> This guide is for informational purposes only and reflects requirements as of 2026. Regulations change — always verify current requirements with FMCSA, TxDMV, and a licensed transportation attorney before making business decisions.
          </p>
        </div>
      </div>

      {/* ── Box Truck Requirements ── */}
      <section className="py-24 px-6" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-4xl mx-auto">
          <FadeUp>
            <div className="label mb-4">Start Here — Know Your Vehicle</div>
            <h2 className="text-3xl font-black text-white mb-4" style={{ letterSpacing: '-0.04em' }}>Box Truck vs. All Other CMVs</h2>
            <p className="text-base mb-3" style={{ color: 'var(--muted)' }}>
              Your requirements depend on what you're driving. Box trucks under 26,000 lbs GVWR have a lighter compliance load than larger vehicles. The 26,001 lb line is the most important number in your business — check your door jamb sticker to confirm your truck's GVWR before you do anything else.
            </p>
            <p className="text-sm mb-10" style={{ color: 'rgba(255,255,255,.4)' }}>
              GVWR = Gross Vehicle Weight Rating. It's the manufacturer's maximum operating weight, printed on the door jamb sticker. It does not change based on what you're carrying.
            </p>
          </FadeUp>

          {/* 3-column vehicle cards */}
          <div className="grid sm:grid-cols-3 gap-4 mb-10">
            <FadeUp>
              <div className="p-6 rounded-2xl h-full" style={{ background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.12)' }}>
                <div className="text-2xl mb-3">📦</div>
                <p className="text-xs font-bold uppercase tracking-widest mb-1" style={{ color: 'var(--muted)' }}>Box Truck</p>
                <p className="text-xl font-black text-white mb-2" style={{ letterSpacing: '-0.03em' }}>Under 26,000 lbs</p>
                <p className="text-xs font-semibold mb-3" style={{ color: '#4ade80' }}>No CDL required</p>
                <p className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
                  16 ft, 20 ft, most 24 ft box trucks. No IFTA. No IRP plates. Fewer federal requirements — but USDOT, insurance, and operating authority still apply for interstate for-hire work.
                </p>
              </div>
            </FadeUp>
            <FadeUp delay={60}>
              <div className="p-6 rounded-2xl h-full" style={{ background: 'rgba(224,0,42,.05)', border: '1px solid rgba(224,0,42,.2)' }}>
                <div className="text-2xl mb-3">🚛</div>
                <p className="text-xs font-bold uppercase tracking-widest mb-1" style={{ color: 'rgba(255,102,128,.7)' }}>Box Truck</p>
                <p className="text-xl font-black text-white mb-2" style={{ letterSpacing: '-0.03em' }}>Over 26,000 lbs</p>
                <p className="text-xs font-semibold mb-3" style={{ color: '#ff6680' }}>Class B CDL required</p>
                <p className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
                  Most 26 ft box trucks. Single vehicle, no trailer. Class B CDL required. Full FMCSA compliance: IFTA, IRP, ELD. Short-haul ELD exemption still possible within 150-mile radius.
                </p>
              </div>
            </FadeUp>
            <FadeUp delay={120}>
              <div className="p-6 rounded-2xl h-full" style={{ background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.18)' }}>
                <div className="text-2xl mb-3">🚚</div>
                <p className="text-xs font-bold uppercase tracking-widest mb-1" style={{ color: 'rgba(255,255,255,.5)' }}>Semi / Combination</p>
                <p className="text-xl font-black text-white mb-2" style={{ letterSpacing: '-0.03em' }}>Over 26,000 lbs</p>
                <p className="text-xs font-semibold mb-3" style={{ color: '#facc15' }}>Class A CDL required</p>
                <p className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
                  Tractor-trailer, semi-truck. GCWR over 26,001 lbs with trailer GVWR over 10,000 lbs. Class A CDL required. Full FMCSA compliance: IFTA, IRP, ELD, full HOS with no short-haul exemption on most runs.
                </p>
              </div>
            </FadeUp>
          </div>

          {/* 3-column comparison table */}
          <FadeUp delay={100}>
            <div className="overflow-x-auto">
              <table className="w-full text-xs" style={{ borderCollapse: 'separate', borderSpacing: '0 5px' }}>
                <thead>
                  <tr>
                    <th className="text-left pb-3 font-bold uppercase tracking-widest" style={{ color: 'rgba(255,255,255,.3)', paddingLeft: '14px', fontSize: '10px' }}>Requirement</th>
                    <th className="text-left pb-3 font-bold uppercase tracking-widest" style={{ color: 'rgba(255,255,255,.3)', paddingLeft: '14px', fontSize: '10px' }}>Box Truck &lt;26K lbs</th>
                    <th className="text-left pb-3 font-bold uppercase tracking-widest" style={{ color: 'rgba(255,102,128,.6)', paddingLeft: '14px', fontSize: '10px' }}>Box Truck &gt;26K lbs</th>
                    <th className="text-left pb-3 font-bold uppercase tracking-widest" style={{ color: 'rgba(250,204,21,.6)', paddingLeft: '14px', fontSize: '10px' }}>Semi / Combo</th>
                  </tr>
                </thead>
                <tbody>
                  {BOX_TRUCK_COMPARE.map((row, i) => (
                    <tr key={i}>
                      <td className="py-3 px-4 font-bold text-white rounded-l-xl" style={{ background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)', borderRight: 'none', whiteSpace: 'nowrap' }}>{row.req}</td>
                      <td className="py-3 px-4" style={{ background: 'rgba(255,255,255,.03)', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)', color: row.boxUnder.ok ? '#4ade80' : 'var(--muted)' }}>{row.boxUnder.text}</td>
                      <td className="py-3 px-4" style={{ background: 'rgba(255,255,255,.03)', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)', color: row.boxOver.ok ? '#4ade80' : 'var(--muted)' }}>{row.boxOver.text}</td>
                      <td className="py-3 px-4 rounded-r-xl" style={{ background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)', borderLeft: 'none', color: row.semi.ok ? '#4ade80' : 'var(--muted)' }}>{row.semi.text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </FadeUp>

          {/* Key notes */}
          <FadeUp delay={200}>
            <div className="mt-8 space-y-4">
              <div className="p-5 rounded-2xl" style={{ background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
                <p className="text-sm font-bold text-white mb-1">Short-Haul ELD Exemption</p>
                <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>
                  Available to both box truck weight classes. If your driver operates within a <strong style={{ color: '#fff' }}>150 air-mile radius</strong> of their home terminal and returns within 14 hours, they may use time records instead of an ELD. Semis on long-haul runs typically cannot use this exemption. Applies per driver, per day.
                </p>
              </div>
              <div className="p-5 rounded-2xl" style={{ background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
                <p className="text-sm font-bold text-white mb-1">Broker Insurance Expectations vs. Federal Minimums</p>
                <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>
                  Federal minimum for non-hazardous interstate freight is <strong style={{ color: '#fff' }}>$750,000 CSL</strong> — for all three vehicle types. Most load boards and freight brokers require <strong style={{ color: '#fff' }}>$1,000,000 liability</strong> on your COI before they'll assign loads. Budget for $1M from day one regardless of truck size.
                </p>
              </div>
              <div className="p-5 rounded-2xl" style={{ background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
                <p className="text-sm font-bold text-white mb-1">DOT Medical Card — Non-CDL Box Truck Drivers</p>
                <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>
                  No CDL doesn't mean no DOT medical card. Drivers operating vehicles over <strong style={{ color: '#fff' }}>10,001 lbs GVWR in interstate commerce</strong> must carry a valid DOT medical examiner's certificate — even without a CDL. Renewed every 24 months minimum.
                </p>
              </div>
            </div>
          </FadeUp>
        </div>
      </section>

      {/* ── Earnings Potential ── */}
      <section className="py-24 px-6" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-4xl mx-auto">
          <FadeUp>
            <div className="label mb-4">What You Can Earn</div>
            <h2 className="text-3xl font-black text-white mb-4" style={{ letterSpacing: '-0.04em' }}>Box Truck Earnings — Final Mile Furniture &amp; Appliance Delivery</h2>
            <p className="text-base mb-3" style={{ color: 'var(--muted)' }}>
              Furniture and appliance final-mile delivery is one of the most consistent revenue streams for box truck owner-operators. Local logistics companies contract with independent carriers daily — no load board, no long-haul, home every night. Numbers below are gross revenue before expenses, sourced from ZipRecruiter and Indeed job listings (March 2026).
            </p>
            <p className="text-xs mb-12" style={{ color: 'rgba(255,255,255,.35)' }}>
              Source: ZipRecruiter March 2026 salary data · Indeed owner-operator job listings · Industry per-stop averages. Gross figures — see expense breakdown below.
            </p>
          </FadeUp>

          {/* Per-stop breakdown */}
          <FadeUp delay={40}>
            <div className="glass-card p-6 mb-6" style={{ borderRadius: '18px' }}>
              <p className="text-xs font-bold uppercase tracking-widest mb-4" style={{ color: 'var(--muted)', letterSpacing: '0.1em' }}>How You Get Paid — Per Stop Rate</p>
              <div className="grid sm:grid-cols-3 gap-4">
                <div>
                  <p className="text-2xl font-black mb-1" style={{ color: 'var(--red)', letterSpacing: '-0.03em' }}>$75–$95</p>
                  <p className="text-xs font-semibold text-white mb-1">Per Stop (Gross)</p>
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>Industry average per residential delivery stop for furniture/appliance final-mile work.</p>
                </div>
                <div>
                  <p className="text-2xl font-black mb-1" style={{ color: 'var(--red)', letterSpacing: '-0.03em' }}>5–10</p>
                  <p className="text-xs font-semibold text-white mb-1">Stops Per Day (Local Route)</p>
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>Typical daily stop count on a local DFW route. White-glove installs may be fewer stops at higher pay.</p>
                </div>
                <div>
                  <p className="text-2xl font-black mb-1" style={{ color: 'var(--red)', letterSpacing: '-0.03em' }}>$375–$950</p>
                  <p className="text-xs font-semibold text-white mb-1">Gross Per Day</p>
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>Daily gross range based on stop count × per-stop rate. High end reflects full route with white-glove stops.</p>
                </div>
              </div>
            </div>
          </FadeUp>

          {/* Earnings table */}
          <FadeUp delay={80}>
            <div className="overflow-x-auto mb-8">
              <table className="w-full text-sm" style={{ borderCollapse: 'separate', borderSpacing: '0 6px' }}>
                <thead>
                  <tr>
                    <th className="text-left pb-3 text-xs font-bold uppercase tracking-widest" style={{ color: 'rgba(255,255,255,.3)', paddingLeft: '16px' }}>Timeframe</th>
                    <th className="text-left pb-3 text-xs font-bold uppercase tracking-widest" style={{ color: 'rgba(255,255,255,.3)', paddingLeft: '16px' }}>Entry / Low</th>
                    <th className="text-left pb-3 text-xs font-bold uppercase tracking-widest" style={{ color: 'rgba(255,255,255,.3)', paddingLeft: '16px' }}>Average</th>
                    <th className="text-left pb-3 text-xs font-bold uppercase tracking-widest" style={{ color: 'rgba(255,255,255,.3)', paddingLeft: '16px' }}>Experienced / High</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { period: 'Per Day', low: '$375 – $500', avg: '$600 – $800', high: '$950 – $1,500' },
                    { period: 'Per Week (5 days)', low: '$961 – $1,875', avg: '$2,201 – $2,403', high: '$3,500 – $5,000' },
                    { period: 'Per Month', low: '$3,846 – $7,500', avg: '$8,804 – $9,539', high: '$14,000 – $20,000' },
                    { period: 'Per Year (Gross)', low: '$50,000 – $75,000', avg: '$114,472', high: '$150,000 – $250,000' },
                  ].map((row, i) => (
                    <tr key={i}>
                      <td className="py-3 px-4 font-black text-white text-xs rounded-l-xl" style={{ background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)', borderRight: 'none' }}>{row.period}</td>
                      <td className="py-3 px-4 text-xs" style={{ background: 'rgba(255,255,255,.03)', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)', color: 'var(--muted)' }}>{row.low}</td>
                      <td className="py-3 px-4 text-xs font-bold" style={{ background: 'rgba(255,255,255,.03)', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)', color: '#fff' }}>{row.avg}</td>
                      <td className="py-3 px-4 text-xs font-bold rounded-r-xl" style={{ background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)', borderLeft: 'none', color: '#4ade80' }}>{row.high}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </FadeUp>

          {/* Who's hiring */}
          <FadeUp delay={120}>
            <div className="mb-8">
              <p className="text-sm font-bold text-white mb-4">Who Contracts Local Box Truck Owner-Operators</p>
              <div className="grid sm:grid-cols-2 gap-3">
                {[
                  { name: 'J.B. Hunt Final Mile', desc: 'Contracts owner-ops for furniture set-up and delivery for major retailers. Weekly settlements. Home daily.' },
                  { name: 'Ryder Last Mile', desc: 'White-glove furniture and appliance delivery. 26 ft box truck with liftgate required. Weekly pay.' },
                  { name: 'HomeDeliveryLink', desc: 'Regional network connecting retailers with local owner-operators for last-mile home delivery.' },
                  { name: 'PTG Logistics (Best Buy)', desc: 'Appliance and electronics delivery/install. Active DFW market. Pays per stop or daily rate.' },
                  { name: 'UST Logistical Systems', desc: 'White-glove delivery and installation. Minimum 2 years experience preferred. Weekly settlements.' },
                  { name: 'Direct Impact Logistics', desc: 'Final-mile furniture delivery network. LLC required. Contract-based, routes assigned weekly.' },
                ].map((co, i) => (
                  <div key={i} className="p-4 rounded-2xl" style={{ background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
                    <p className="text-xs font-black text-white mb-1">{co.name}</p>
                    <p className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>{co.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          </FadeUp>

          {/* Expense reality check */}
          <FadeUp delay={160}>
            <div className="p-6 rounded-2xl" style={{ background: 'rgba(224,0,42,.05)', border: '1px solid rgba(224,0,42,.2)' }}>
              <p className="text-sm font-black text-white mb-4">Expense Reality Check — What Comes Out Before You Profit</p>
              <div className="grid sm:grid-cols-2 gap-x-8 gap-y-3">
                {[
                  { item: 'Fuel', cost: '$150 – $350 / week' },
                  { item: 'Commercial Insurance', cost: '$400 – $800 / month' },
                  { item: 'Truck Payment / Lease', cost: '$800 – $2,000 / month' },
                  { item: 'Helper / Second Man', cost: '$150 – $250 / day (if needed)' },
                  { item: 'Maintenance & Repairs', cost: '$200 – $500 / month avg' },
                  { item: 'ELD Subscription', cost: '$35 – $75 / month' },
                ].map((exp, i) => (
                  <div key={i} className="flex items-center justify-between gap-4 py-1" style={{ borderBottom: '1px solid rgba(255,255,255,.06)' }}>
                    <p className="text-xs font-semibold text-white">{exp.item}</p>
                    <p className="text-xs shrink-0" style={{ color: '#ff6680' }}>{exp.cost}</p>
                  </div>
                ))}
              </div>
              <p className="text-xs mt-4 leading-relaxed" style={{ color: 'rgba(255,255,255,.4)' }}>
                After expenses, a well-run owner-operator doing 5 days/week of local furniture and appliance delivery typically nets <strong style={{ color: 'rgba(255,255,255,.7)' }}>$55,000 – $110,000 per year</strong>. Top operators running full routes with a helper on large installs can exceed that.
              </p>
            </div>
          </FadeUp>
        </div>
      </section>

      {/* ── Startup Checklist ── */}
      <section className="py-24 px-6">
        <div className="max-w-4xl mx-auto">
          <FadeUp>
            <div className="label mb-4">Step-by-Step Startup</div>
            <h2 className="text-3xl font-black text-white mb-4" style={{ letterSpacing: '-0.04em' }}>Getting Your Authority: 12 Steps</h2>
            <p className="text-base mb-14" style={{ color: 'var(--muted)' }}>
              Follow these in order. Steps 3–5 must happen in parallel — your authority won't activate until FMCSA has both your insurance filing and your BOC-3 on file.
            </p>
          </FadeUp>

          <div className="space-y-6">
            {STARTUP_STEPS.map((s, i) => (
              <FadeUp key={s.step} delay={i * 40}>
                <div className="glass-card p-7" style={{ borderRadius: '18px' }}>
                  <div className="flex gap-5 items-start">
                    <div className="shrink-0 w-12 h-12 rounded-xl flex items-center justify-center font-black text-sm" style={{ background: 'rgba(224,0,42,.12)', border: '1px solid rgba(224,0,42,.25)', color: 'var(--red)' }}>
                      {s.step}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-3 mb-2">
                        <h3 className="font-black text-white" style={{ fontSize: '16px', letterSpacing: '-0.02em' }}>{s.title}</h3>
                        <span className="text-xs font-bold px-2.5 py-1 rounded-full" style={{ background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', color: 'var(--muted)' }}>{s.time}</span>
                      </div>
                      <p className="text-sm leading-relaxed whitespace-pre-line" style={{ color: 'var(--muted)' }}>{s.desc}</p>
                      {s.links.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-3">
                          {s.links.map(link => (
                            <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer"
                              className="text-xs font-semibold transition-colors hover:text-white"
                              style={{ color: '#ff6680', textDecoration: 'underline', textDecorationColor: 'rgba(255,102,128,.35)' }}>
                              {link.label} ↗
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </FadeUp>
            ))}
          </div>
        </div>
      </section>

      {/* ── Authority Activation Timeline ── */}
      <section className="py-20 px-6" style={{ background: 'rgba(255,255,255,.015)', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-4xl mx-auto">
          <FadeUp>
            <div className="label mb-4">How Long Does It Take?</div>
            <h2 className="text-3xl font-black text-white mb-4" style={{ letterSpacing: '-0.04em' }}>Authority Activation Timeline</h2>
            <p className="text-base mb-10" style={{ color: 'var(--muted)' }}>
              Most carriers see their authority go "Active" within <strong style={{ color: '#fff' }}>3 to 6 weeks</strong> from the date of application. The 21-day protest period is mandatory — there is no way to skip it. The most common reason for delays is missing insurance or BOC-3 filings.
            </p>
          </FadeUp>
          <div className="relative">
            {/* Timeline line */}
            <div className="absolute left-5 top-0 bottom-0 w-px hidden sm:block" style={{ background: 'rgba(224,0,42,.25)' }} />
            <div className="space-y-4">
              {AUTHORITY_TIMELINE.map((item, i) => (
                <FadeUp key={i} delay={i * 60}>
                  <div className="sm:pl-14 relative">
                    {/* Dot */}
                    <div className="hidden sm:flex absolute left-0 top-5 w-10 h-10 rounded-full items-center justify-center text-xs font-black shrink-0" style={{ background: 'rgba(224,0,42,.15)', border: '2px solid rgba(224,0,42,.4)', color: 'var(--red)' }}>
                      {i + 1}
                    </div>
                    <div className="glass-card p-5" style={{ borderRadius: '14px' }}>
                      <div className="flex flex-wrap items-center gap-3 mb-2">
                        <span className="text-xs font-bold px-2.5 py-1 rounded-full" style={{ background: 'rgba(224,0,42,.12)', border: '1px solid rgba(224,0,42,.3)', color: 'var(--red)' }}>{item.day}</span>
                        <p className="text-sm font-black text-white">{item.event}</p>
                      </div>
                      <p className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>{item.note}</p>
                    </div>
                  </div>
                </FadeUp>
              ))}
            </div>
          </div>
          <FadeUp delay={400}>
            <div className="mt-8 p-5 rounded-2xl" style={{ background: 'rgba(224,0,42,.06)', border: '1px solid rgba(224,0,42,.2)' }}>
              <p className="text-sm font-bold text-white mb-1">Pro Tip: Check Your Status</p>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>
                Monitor your application at{' '}
                <a href="https://safer.fmcsa.dot.gov" target="_blank" rel="noopener noreferrer" style={{ color: '#ff6680' }}>safer.fmcsa.dot.gov</a>
                {' '}using your USDOT number. Status will show as <strong style={{ color: '#fff' }}>"Pending"</strong> until all three conditions are met: BOC-3 on file, insurance on file, and protest period complete. If it's been over 30 days and still Pending, call FMCSA at 1-800-832-5660.
              </p>
            </div>
          </FadeUp>
        </div>
      </section>

      {/* ── Insurance Summary ── */}
      <section className="py-20 px-6" style={{ background: 'rgba(255,255,255,.015)', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-4xl mx-auto">
          <FadeUp>
            <div className="label mb-4">Insurance Requirements</div>
            <h2 className="text-3xl font-black text-white mb-10" style={{ letterSpacing: '-0.04em' }}>Coverage Minimums at a Glance</h2>
          </FadeUp>
          <div className="grid sm:grid-cols-2 gap-4">
            {[
              { type: 'Interstate — Non-Hazardous (10,001+ lbs)', amount: '$750,000 CSL', note: 'Most freight carriers fall here' },
              { type: 'Interstate — Oil / Hopper Vehicles', amount: '$1,000,000 CSL', note: 'Specific commodity requirement' },
              { type: 'Interstate — Hazardous Materials', amount: '$5,000,000 CSL', note: 'Explosives, radioactive, etc.' },
              { type: 'Texas Intrastate Only', amount: '$500,000 CSL', note: 'TxDMV requirement; filed with TxDMV' },
              { type: 'Household Goods — Intrastate Under 26K lbs', amount: '$300,000 CSL', note: 'Lower minimum for smaller trucks' },
              { type: 'Cargo Insurance', amount: 'Varies by shipper', note: 'Often $100K–$250K; required by many brokers' },
            ].map((row, i) => (
              <FadeUp key={row.type} delay={i * 50}>
                <div className="glass-card p-6" style={{ borderRadius: '16px' }}>
                  <p className="text-xs font-bold mb-2" style={{ color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{row.type}</p>
                  <p className="text-2xl font-black text-white mb-1" style={{ letterSpacing: '-0.03em', color: 'var(--red)' }}>{row.amount}</p>
                  <p className="text-xs" style={{ color: 'rgba(255,255,255,.35)' }}>{row.note}</p>
                </div>
              </FadeUp>
            ))}
          </div>
          <FadeUp delay={300}>
            <p className="mt-8 text-sm" style={{ color: 'rgba(255,255,255,.4)' }}>
              CSL = Combined Single Limit. Your insurer files Form MCS-90 directly with FMCSA. Coverage must be active before your operating authority goes "Active."
            </p>
          </FadeUp>
        </div>
      </section>

      {/* ── Compliance Calendar ── */}
      <section className="py-24 px-6">
        <div className="max-w-4xl mx-auto">
          <FadeUp>
            <div className="label mb-4">Ongoing Compliance</div>
            <h2 className="text-3xl font-black text-white mb-4" style={{ letterSpacing: '-0.04em' }}>Your Compliance Calendar</h2>
            <p className="text-base mb-14" style={{ color: 'var(--muted)' }}>
              Getting your authority is just the beginning. Staying legal requires consistent attention. Miss a deadline and you risk fines, out-of-service orders, or authority revocation.
            </p>
          </FadeUp>

          {/* Monthly */}
          <FadeUp>
            <div className="mb-10">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center font-black text-xs" style={{ background: 'rgba(224,0,42,.12)', border: '1px solid rgba(224,0,42,.25)', color: 'var(--red)' }}>MO</div>
                <h3 className="text-xl font-black text-white" style={{ letterSpacing: '-0.03em' }}>Monthly Checkpoints</h3>
              </div>
              <div className="space-y-3">
                {MONTHLY.map((item, i) => (
                  <div key={i} className="flex items-start gap-3 p-4 rounded-2xl" style={{ background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
                    <span className="mt-0.5 shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-black" style={{ background: 'rgba(224,0,42,.15)', color: 'var(--red)' }}>✓</span>
                    <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>{item}</p>
                  </div>
                ))}
              </div>
            </div>
          </FadeUp>

          {/* Quarterly */}
          <FadeUp delay={80}>
            <div className="mb-10">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center font-black text-xs" style={{ background: 'rgba(224,0,42,.12)', border: '1px solid rgba(224,0,42,.25)', color: 'var(--red)' }}>QT</div>
                <h3 className="text-xl font-black text-white" style={{ letterSpacing: '-0.03em' }}>Quarterly Checkpoints</h3>
              </div>
              <div className="space-y-3">
                {QUARTERLY.map((item, i) => (
                  <div key={i} className="flex items-start gap-3 p-4 rounded-2xl" style={{ background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
                    <span className="mt-0.5 shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-black" style={{ background: 'rgba(224,0,42,.15)', color: 'var(--red)' }}>✓</span>
                    <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>{item}</p>
                  </div>
                ))}
              </div>
            </div>
          </FadeUp>

          {/* Annual */}
          <FadeUp delay={160}>
            <div>
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center font-black text-xs" style={{ background: 'rgba(224,0,42,.12)', border: '1px solid rgba(224,0,42,.25)', color: 'var(--red)' }}>YR</div>
                <h3 className="text-xl font-black text-white" style={{ letterSpacing: '-0.03em' }}>Annual Checkpoints</h3>
              </div>
              <div className="space-y-3">
                {ANNUAL.map((item, i) => (
                  <div key={i} className="flex items-start gap-3 p-4 rounded-2xl" style={{ background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
                    <span className="mt-0.5 shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-black" style={{ background: 'rgba(224,0,42,.15)', color: 'var(--red)' }}>✓</span>
                    <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>{item}</p>
                  </div>
                ))}
              </div>
            </div>
          </FadeUp>
        </div>
      </section>

      {/* ── Key Agencies ── */}
      <section className="py-20 px-6" style={{ background: 'rgba(255,255,255,.015)', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-4xl mx-auto">
          <FadeUp>
            <div className="label mb-4">Official Resources</div>
            <h2 className="text-3xl font-black text-white mb-10" style={{ letterSpacing: '-0.04em' }}>Key Agencies &amp; Links</h2>
          </FadeUp>
          <div className="grid sm:grid-cols-2 gap-4">
            {[
              { name: 'FMCSA Registration', desc: 'USDOT number, operating authority, Motus platform', url: 'https://www.fmcsa.dot.gov/registration' },
              { name: 'TxDMV Motor Carriers', desc: 'Texas intrastate registration, TxDMV number, IRP plates', url: 'https://www.txdmv.gov/motor-carriers/how-to-be-a-motor-carrier' },
              { name: 'UCR Registration', desc: 'Annual unified carrier registration for interstate carriers', url: 'https://www.ucr.gov' },
              { name: 'Texas IFTA (Comptroller)', desc: 'Quarterly fuel tax filing for interstate carriers', url: 'https://comptroller.texas.gov/taxes/motor-fuel/ifta/' },
              { name: 'FMCSA Safety Scores (SMS)', desc: 'Monitor your CSA safety scores and roadside data', url: 'https://ai.fmcsa.dot.gov/SMS' },
              { name: 'FMCSA ELD Information', desc: 'Registered ELD devices and hours of service rules', url: 'https://www.fmcsa.dot.gov/hours-service/elds/eld-checklist-carriers' },
              { name: 'TX Secretary of State', desc: 'Form your LLC or corporation in Texas', url: 'https://www.sos.state.tx.us' },
              { name: 'IRS EIN Application', desc: 'Free federal employer identification number', url: 'https://www.irs.gov/businesses/small-businesses-self-employed/apply-for-an-employer-identification-number-ein-online' },
            ].map((agency, i) => (
              <FadeUp key={agency.name} delay={i * 40}>
                <a href={agency.url} target="_blank" rel="noopener noreferrer"
                  className="glass-card p-5 block transition-all hover:border-red-500 group"
                  style={{ borderRadius: '14px', textDecoration: 'none' }}>
                  <p className="text-sm font-black text-white mb-1 group-hover:text-red-400 transition-colors">{agency.name} ↗</p>
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>{agency.desc}</p>
                </a>
              </FadeUp>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="py-24 px-6">
        <div className="max-w-4xl mx-auto">
          <FadeUp>
            <div className="glass-card p-10 text-center" style={{ borderRadius: '24px', background: 'linear-gradient(135deg, rgba(224,0,42,.08), rgba(255,255,255,.02))' }}>
              <div className="label mb-5 mx-auto" style={{ width: 'fit-content' }}>5+ Years in DFW Freight</div>
              <h2 className="text-3xl font-black text-white mb-4" style={{ letterSpacing: '-0.04em', lineHeight: 1.1 }}>
                Already Running? We Can<br />
                <span style={{ color: 'var(--red)' }}>Move Your Freight.</span>
              </h2>
              <p className="text-base mb-8 max-w-lg mx-auto leading-relaxed" style={{ color: 'var(--muted)' }}>
                J Kiss LLC has operated in the DFW freight market for over 5 years (since September 2020). We partner with warehouses, retailers, and logistics companies that need a reliable carrier they can count on.
              </p>
              <div className="flex flex-wrap justify-center gap-4">
                <Link href="/#contact" className="btn">Request a Quote →</Link>
                <Link href="/" className="btn-ghost">Back to Home</Link>
              </div>
            </div>
          </FadeUp>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="py-10 px-6" style={{ borderTop: '1px solid var(--line)' }}>
        <div className="max-w-4xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-sm font-black text-white" style={{ letterSpacing: '-0.02em' }}>
            J Kiss <span style={{ color: 'var(--red)' }}>LLC</span>
          </p>
          <p className="text-xs text-center" style={{ color: 'rgba(255,255,255,.25)' }}>
            © {new Date().getFullYear()} J Kiss LLC · US DOT 3484556 · MC 01155352
          </p>
          <Link href="/" className="text-xs transition-colors hover:text-white" style={{ color: 'rgba(255,255,255,.35)', textDecoration: 'none' }}>← Back to Home</Link>
        </div>
      </footer>
    </main>
  )
}
