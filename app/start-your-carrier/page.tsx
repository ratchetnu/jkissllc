'use client'

import { useState, useEffect, useRef } from 'react'
import { COMPANY, CREDENTIALS_DOT } from '../lib/company';
import Link from 'next/link'
import { Lock } from 'lucide-react'
import CapabilityGrid from '../components/opspilot/CapabilityGrid'
import EarlyAccessForm from '../components/opspilot/EarlyAccessForm'
import PoweredByBand from '../components/opspilot/PoweredByBand'
import { OpsPilotMark, OpsPilotWordmark } from '../components/opspilot/OpsPilotMark'

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

const STARTUP_COSTS = [
  { item: 'LLC / Business Formation (TX)', low: '$300', high: '$500', note: 'TX Secretary of State filing fee + registered agent (first year)' },
  { item: 'EIN (Federal Tax ID)', low: '$0', high: '$0', note: 'Free from IRS online — same day' },
  { item: 'USDOT Number', low: '$0', high: '$0', note: 'Free through FMCSA registration' },
  { item: 'Operating Authority', low: '$300', high: '$300', note: 'Non-refundable FMCSA filing fee' },
  { item: 'BOC-3 Process Agent', low: '$25', high: '$75', note: 'One-time fee through a process agent service' },
  { item: 'Commercial Insurance (1st month)', low: '$400', high: '$800', note: 'Down payment to activate policy; required before authority activates' },
  { item: 'UCR Registration', low: '$59', high: '$175', note: 'Annual fee based on fleet size (1–2 trucks)' },
  { item: 'IRP Plates (if over 26K lbs)', low: '$1,500', high: '$1,800', note: 'Only required if your box truck exceeds 26,000 lbs GVWR and runs interstate' },
  { item: 'Box Truck (Used, 16–24 ft)', low: '$12,000', high: '$35,000', note: 'Purchase price; liftgate adds $2,000–$5,000 if not included' },
  { item: 'Box Truck (26 ft, Used)', low: '$20,000', high: '$55,000', note: 'Or lease at $725–$995/month' },
  { item: 'Delivery Equipment (dolly, blankets, straps)', low: '$500', high: '$1,200', note: 'Appliance dolly, furniture blankets, ratchet straps, hand truck' },
  { item: 'ELD Device + First Month', low: '$150', high: '$300', note: 'May qualify for 150-mile short-haul exemption on local routes' },
  { item: 'Drug Testing (Pre-employment)', low: '$50', high: '$75', note: 'Required per driver before first run' },
  { item: 'DOT Physical (Medical Card)', low: '$75', high: '$150', note: 'Required for interstate CMV drivers over 10,001 lbs' },
  { item: 'Operating Reserve (3 months)', low: '$3,000', high: '$6,000', note: 'Fuel, insurance, unexpected repairs before revenue is consistent' },
]

const SEMI_STARTUP_COSTS = [
  { item: 'LLC / Business Formation (TX)', low: '$300', high: '$500', note: 'TX Secretary of State filing fee + registered agent (first year)' },
  { item: 'EIN (Federal Tax ID)', low: '$0', high: '$0', note: 'Free from IRS online — same day' },
  { item: 'USDOT Number', low: '$0', high: '$0', note: 'Free through FMCSA registration' },
  { item: 'Operating Authority', low: '$300', high: '$300', note: 'Non-refundable FMCSA filing fee' },
  { item: 'BOC-3 Process Agent', low: '$25', high: '$75', note: 'One-time fee through a process agent service' },
  { item: 'Commercial Insurance (1st month)', low: '$800', high: '$1,800', note: 'Semi insurance is significantly higher than box truck — shop multiple carriers' },
  { item: 'Cargo Insurance', low: '$150', high: '$350', note: 'Per month; most brokers require $100K minimum cargo coverage' },
  { item: 'UCR Registration', low: '$59', high: '$175', note: 'Annual fee based on fleet size' },
  { item: 'IRP Apportioned Plates', low: '$1,500', high: '$2,500', note: 'Required for all semi interstate operations — no exemption' },
  { item: 'IFTA License', low: '$0', high: '$10', note: 'Free to register with TX Comptroller; quarterly filings required thereafter' },
  { item: 'Semi-Truck / Tractor (Used)', low: '$40,000', high: '$120,000', note: 'Or finance/lease at $1,500–$3,500/month; sleeper cabs cost more' },
  { item: 'Dry Van Trailer (Used)', low: '$15,000', high: '$45,000', note: 'Or lease at $300–$600/month; required for most dry van freight' },
  { item: 'ELD Device + First Month', low: '$150', high: '$350', note: 'Full HOS compliance required — no short-haul exemption on most OTR runs' },
  { item: 'Class A CDL Testing / School', low: '$3,000', high: '$8,000', note: 'If not already licensed. Skills test fee alone is $200–$400 at a state CDL site.' },
  { item: 'Drug Testing (Pre-employment)', low: '$50', high: '$75', note: 'Required per driver before first run' },
  { item: 'DOT Physical (Medical Card)', low: '$75', high: '$150', note: 'Required for all CDL drivers' },
  { item: 'Operating Reserve (3 months)', low: '$5,000', high: '$10,000', note: 'Fuel, repairs, deadhead miles, and slow freight weeks — semi overhead is higher' },
]

const EQUIPMENT_LIST = [
  { category: 'Delivery Equipment', items: ['Appliance hand truck / dolly (2-wheel & 4-wheel)', 'Furniture dolly (4-wheel flat)', 'Stair-climbing dolly (for multi-floor deliveries)', 'Ratchet straps (6–8 minimum)', 'Furniture moving blankets / pads (12–24)', 'Stretch wrap / shrink wrap', 'Rubber bands and furniture bands', 'Cargo bars / load bars (keep items from shifting)'] },
  { category: 'Box Truck Requirements', items: ['26 ft box truck with liftgate (most logistics companies require this)', 'Liftgate rated for 2,500+ lbs', 'Interior tie-down rails or E-track', 'Rear door lock', 'Clean interior — no stains, debris, or damage'] },
  { category: 'White-Glove & Install', items: ['Drill / power screwdriver', 'Basic hand tool kit (Allen keys, screwdrivers, pliers)', 'Level', 'Boot covers / shoe covers for customer homes', 'Zip ties and cable management for appliance installs', 'Haul-away bags (some contracts include removing old items)'] },
  { category: 'Driver & Safety', items: ['High-visibility vest', 'Steel-toe or composite-toe boots', 'Work gloves', 'First aid kit', 'Fire extinguisher (DOT-required in cab)', 'Reflective triangles or flares (3 minimum)'] },
  { category: 'Admin & Compliance', items: ['ELD device mounted and operational', 'IRP cab card (if over 26K lbs and running interstate)', 'IFTA license copy in cab (if over 26K lbs)', 'Insurance certificate (keep copy in truck)', 'USDOT number displayed on both sides of truck (min. 2-inch letters)', 'Driver qualification file copy (CDL if applicable, medical card, drug test)'] },
]

const SEMI_EQUIPMENT_LIST = [
  { category: 'Tractor Requirements', items: ['Class 8 tractor in good mechanical condition', 'Valid annual DOT inspection sticker', 'All lights operational (headlights, brake lights, marker lights)', 'Functional air brake system with no leaks', 'USDOT and MC number on both cab doors (min. 2-inch lettering)', 'Fire extinguisher (5 lb minimum, DOT-required in cab)'] },
  { category: 'Trailer Equipment', items: ['Dry van trailer (53 ft standard; 48 ft accepted on some loads)', 'Load bars / cargo bars (2–4 minimum)', 'Ratchet straps and edge protectors', 'Dock plate or yard ramp access (if no dock at pickup)', 'Rear lights and brake lights all functional', 'Trailer annual inspection current'] },
  { category: 'In-Cab Essentials', items: ['ELD device mounted and connected to engine (FMCSA-registered)', 'Paper log backup (7 days minimum)', 'Permits folder: registration, insurance, IFTA license, IRP cab card, BOC-3 reference', 'Pre-trip / post-trip inspection checklist', 'Fuel receipts log (required for IFTA quarterly filing)', 'GPS / routing app (Google Maps, PC*MILER, or similar)'] },
  { category: 'Driver Safety', items: ['DOT reflective triangles (3 required)', 'Road flares or LED emergency lights', 'High-visibility safety vest', 'Work gloves', 'First aid kit', 'Jump cables or lithium jump pack'] },
  { category: 'Tools & Roadside', items: ['Tire pressure gauge and thumper', 'Basic hand tools (wrenches, pliers, zip ties)', 'Extra coolant, oil, and DEF fluid', 'Tire chains (if running northern states in winter)', 'Flashlight / headlamp'] },
  { category: 'Admin & Compliance (Required)', items: ['IFTA fuel license (required — keep copy in cab)', 'IRP apportioned cab card (required for interstate operation)', 'Drug testing consortium card / documentation', 'Current DOT medical examiner\'s certificate', 'Class A CDL in wallet', 'Insurance certificate (liability + cargo)'] },
]

const COMMON_MISTAKES = [
  { mistake: 'Operating while authority is still "Pending"', consequence: 'Federal violation — fines up to $16,000 per day. Your authority must show "Active" before you haul a single load for hire.' },
  { mistake: 'Letting your insurance lapse even one day', consequence: 'FMCSA revokes your operating authority automatically. Reinstatement requires new filings and a waiting period. Brokers will not load you.' },
  { mistake: 'Skipping UCR renewal (due Jan 1)', consequence: 'Operating without current UCR is a federal violation. TxDMV will not renew your IRP plates without it.' },
  { mistake: 'Not displaying USDOT number on truck', consequence: 'Roadside inspection violation. Number must be on both sides of the vehicle in 2-inch minimum lettering.' },
  { mistake: 'Hiring a driver before completing pre-employment drug test', consequence: 'FMCSA violation. Driver cannot operate a CMV until drug test results are cleared.' },
  { mistake: 'No Driver Qualification file before first run', consequence: 'If you\'re audited, missing DQ files are one of the most common violations that result in fines or out-of-service orders.' },
  { mistake: 'Skipping the DOT physical', consequence: 'Operating without a valid medical examiner\'s certificate is a federal violation for all CMV drivers over 10,001 lbs.' },
  { mistake: 'Assuming the short-haul ELD exemption applies automatically', consequence: 'You must qualify each day — return to home terminal within 14 hours, stay within 150 air miles. If you extend a run, you\'re out of exemption and must use an ELD.' },
  { mistake: 'Using a personal bank account for business', consequence: 'Pierces LLC protection. Complicates taxes. If audited, the IRS and FMCSA expect a clear business/personal money separation.' },
  { mistake: 'Not setting aside money for quarterly taxes', consequence: 'IRS underpayment penalties plus a large tax bill you didn\'t budget for. Set aside 25–30% of net income every week.' },
]

const SEMI_COMMON_MISTAKES = [
  { mistake: 'Operating while authority is still "Pending"', consequence: 'Federal violation — fines up to $16,000 per day. Your authority must show "Active" before you haul a single load for hire.' },
  { mistake: 'Letting your insurance lapse even one day', consequence: 'FMCSA revokes your operating authority automatically. Semi insurance lapses also void your cargo coverage — brokers and shippers will drop you immediately.' },
  { mistake: 'Missing the IFTA quarterly filing deadline', consequence: 'Late penalties plus interest. Jan 31, Apr 30, Jul 31, Oct 31 are hard deadlines. Repeated violations trigger FMCSA compliance reviews.' },
  { mistake: 'Operating interstate without IRP plates', consequence: 'Each state you enter without valid apportioned plates can issue a citation. Fines range from $100 to $1,000+ per state depending on violation severity.' },
  { mistake: 'Running without a valid Class A CDL', consequence: 'Federal violation. Out-of-service order on the spot. Your carrier authority can be suspended. Personal fines up to $5,000 per violation.' },
  { mistake: 'ELD / HOS violations', consequence: 'Hours of Service violations are among the top FMCSA enforcement actions. Roadside inspections check your ELD — violations stay on your CSA score for 3 years.' },
  { mistake: 'Skipping UCR renewal (due Jan 1)', consequence: 'Operating without current UCR is a federal violation and will block your IRP plate renewal.' },
  { mistake: 'Not displaying USDOT number on both cab doors', consequence: 'Roadside inspection violation. Must be contrasting color, minimum 2-inch letters, visible from 50 feet.' },
  { mistake: 'No Driver Qualification file before first run', consequence: 'Top audit violation. Missing DQ files — CDL, medical card, MVR, drug test — result in fines and potential out-of-service orders.' },
  { mistake: 'Not tracking fuel receipts for IFTA', consequence: 'IFTA requires you to report actual fuel purchased by state. Missing receipts mean you can\'t prove tax paid — auditors will assess the highest possible rate.' },
]

const FAQ = [
  { q: 'Can I operate while my authority is "Pending"?', a: 'No. You cannot haul for hire in interstate commerce until your status shows "Active" in the FMCSA system. Operating while Pending is a federal violation with fines up to $16,000 per day.' },
  { q: 'Do I need a CDL to drive a box truck?', a: 'Only if the box truck\'s GVWR exceeds 26,000 lbs — then a Class B CDL is required. Under 26,000 lbs GVWR, a standard driver\'s license is sufficient, but a DOT medical card is still required for interstate operations over 10,001 lbs.' },
  { q: 'Do I need IFTA for my box truck?', a: 'No — if your box truck is under 26,000 lbs GVWR. IFTA only applies to vehicles over 26,000 lbs that cross state lines. Most 16–24 ft box trucks are under this threshold. Check your door jamb GVWR sticker to confirm.' },
  { q: 'Do I need IRP plates for a box truck?', a: 'No — if your box truck is under 26,000 lbs GVWR. IRP apportioned plates are only required for commercial vehicles over 26,000 lbs running interstate. Under that weight, standard Texas plates are fine.' },
  { q: 'How long does it take to get operating authority?', a: 'Typically 3–6 weeks from the date of application. The 21-day protest period is mandatory and cannot be shortened. Your authority won\'t activate until the protest period ends AND your insurance and BOC-3 are on file with FMCSA.' },
  { q: 'What happens if my insurance lapses?', a: 'FMCSA will revoke your operating authority the same day the lapse is reported. You must reinstate insurance, refile with FMCSA, and wait for reinstatement. This can take days to weeks and will cause you to lose contracts.' },
  { q: 'Do I need a helper for furniture and appliance delivery?', a: 'Most logistics companies require a two-person team for white-glove furniture and appliance delivery. Some lighter loads can be done solo. Budget $150–$250/day for a helper if required.' },
  { q: 'What is a carrier packet and why do I need one?', a: 'A carrier packet is a set of documents brokers and logistics companies require before assigning you loads. It typically includes your W-9, Certificate of Insurance (COI) showing $1M liability, signed broker-carrier agreement, USDOT/authority confirmation, and voided check for direct deposit. Have it ready before you start pitching for work.' },
  { q: 'How do I get my USDOT number displayed on my truck?', a: 'Your USDOT number must appear on both sides of the vehicle in contrasting color, minimum 2-inch lettering. Magnetic signs are allowed. Vinyl lettering from any sign shop works. Must be visible and legible from 50 feet.' },
  { q: 'Can I run personal loads (my own goods) without authority?', a: 'Yes. Operating authority is only required when you are hauling freight for hire. Hauling only your own goods does not require operating authority, though USDOT registration may still apply if the vehicle exceeds 10,001 lbs.' },
]

const SEMI_FAQ = [
  { q: 'Do I need a Class A CDL to operate a semi?', a: 'Yes — always. A Class A CDL is required for any combination vehicle where the GCWR exceeds 26,001 lbs and the trailer GVWR exceeds 10,000 lbs. You must pass the CDL knowledge tests, skills test (pre-trip inspection, basic controls, road test), and hold a current DOT medical card.' },
  { q: 'Is IFTA required for semi operators?', a: 'Yes — no exceptions for semis. IFTA is required for all vehicles over 26,000 lbs GVWR operating in 2 or more IFTA jurisdictions. File quarterly with the Texas Comptroller. Deadlines: Jan 31, Apr 30, Jul 31, Oct 31.' },
  { q: 'Do I need IRP plates for a semi?', a: 'Yes — required for all interstate semi operations. Register through TxDMV. IRP plates cover all 48 contiguous states under a single registration. You\'ll receive a cab card listing all registered states — keep it in the truck at all times.' },
  { q: 'Can I operate while my authority is "Pending"?', a: 'No. You cannot haul for hire in interstate commerce until your status shows "Active" in the FMCSA system. Operating while Pending is a federal violation with fines up to $16,000 per day.' },
  { q: 'How long does it take to get operating authority?', a: 'Typically 3–6 weeks. The 21-day protest period is mandatory. Your authority won\'t activate until the protest period ends AND your insurance (MCS-90) and BOC-3 are both on file with FMCSA.' },
  { q: 'Does the ELD short-haul exemption apply to semi drivers?', a: 'Rarely. The 150-mile short-haul exemption requires returning to your home terminal within 14 hours and staying within 150 air miles. Most OTR semi runs exceed these limits. If you operate within those bounds consistently, you may qualify — but you must track it per day.' },
  { q: 'What insurance do I need as a semi owner-operator?', a: 'At minimum: $750,000 CSL liability (most brokers require $1M), cargo insurance (typically $100K — some shippers require more), and physical damage on your tractor and trailer. Budget $800–$1,800/month for liability alone. Shop at least 3 carriers.' },
  { q: 'What is a carrier packet for a semi owner-operator?', a: 'Same concept as box truck but also includes your cargo insurance COI, IFTA license, and IRP cab card copies. Most large brokers (DAT, CH Robinson, Coyote) have online onboarding portals where you upload these documents before your first load.' },
  { q: 'How do I find freight as a new authority?', a: 'DAT One and Truckstop.com for spot loads. Most brokers require 3–6 months active authority. In the meantime, contact regional brokers directly — Echo, Coyote, TQL — and ask for a new carrier setup. Some will work with new authorities on shorter regional lanes.' },
  { q: 'What are deadhead miles and why do they matter?', a: 'Deadhead miles are miles you drive without a load (empty). They cost fuel and time without generating revenue. Experienced semi owner-operators plan their lanes to minimize deadhead — ideally under 15% of total miles. High deadhead kills profitability fast.' },
]

const GLOSSARY = [
  { term: 'GVWR', def: 'Gross Vehicle Weight Rating. The manufacturer\'s maximum allowable operating weight for a vehicle — printed on the door jamb sticker. Does not change based on what you\'re carrying.' },
  { term: 'CSL', def: 'Combined Single Limit. A type of insurance coverage that covers bodily injury and property damage under one combined limit (e.g., $750,000 CSL).' },
  { term: 'HOS', def: 'Hours of Service. FMCSA rules that limit how many hours a driver can operate a CMV in a day and week. Enforced via ELD for most drivers.' },
  { term: 'ELD', def: 'Electronic Logging Device. A device connected to your truck\'s engine that automatically records driving time to track HOS compliance. Required for most CMV drivers.' },
  { term: 'IFTA', def: 'International Fuel Tax Agreement. A multi-state fuel tax agreement for carriers operating in 2+ states. You file one quarterly return with Texas instead of separate returns for each state.' },
  { term: 'IRP', def: 'International Registration Plan. An apportioned license plate program that lets interstate carriers register once (in their base state) and operate in all 48 contiguous states.' },
  { term: 'UCR', def: 'Unified Carrier Registration. An annual federal registration fee for interstate carriers. Fee is based on fleet size. Must be renewed by January 1 each year.' },
  { term: 'BOC-3', def: 'A filing with FMCSA that designates a legal process agent in every state where you operate. Required before operating authority can activate. Filed through a process agent service.' },
  { term: 'MCS-90', def: 'The form your insurance company files with FMCSA to prove you carry the required liability insurance. Your insurer files this directly — you don\'t file it yourself.' },
  { term: 'DQ File', def: 'Driver Qualification File. A folder of required documents for each driver: CDL, DOT medical card, MVR, drug test results, employment history, and signed consent forms.' },
  { term: 'CMV', def: 'Commercial Motor Vehicle. Any vehicle used in commerce that exceeds 10,001 lbs GVWR, carries 9+ passengers for hire, or transports hazardous materials.' },
  { term: 'MVR', def: 'Motor Vehicle Record. A driving history report from the DMV. Required for all drivers before hire and annually thereafter.' },
  { term: 'CSA', def: 'Compliance, Safety, Accountability. FMCSA\'s safety measurement system that scores carriers on inspections, violations, and crashes. Brokers and shippers check your CSA score.' },
  { term: 'SMS', def: 'Safety Measurement System. The FMCSA tool that calculates and displays your CSA scores. Check yours at safer.fmcsa.dot.gov.' },
  { term: 'COI', def: 'Certificate of Insurance. A document from your insurer proving your coverage. Brokers require a current COI before assigning loads — most require $1M liability minimum.' },
  { term: 'Per Diem', def: 'A daily allowance for meals and incidentals while away from home. DOT-regulated drivers can deduct 80% of meals using the per diem method on their taxes.' },
]

const FIRST_CONTRACT_STEPS = [
  { step: '01', title: 'Build Your Carrier Packet', desc: 'Before you pitch to anyone, have these ready: W-9, Certificate of Insurance (COI) showing $1M liability, signed carrier authority page from FMCSA, voided check for ACH payment setup, and your LLC documents. Most logistics companies have an online carrier onboarding portal.' },
  { step: '02', title: 'Apply Directly to Final-Mile Networks', desc: 'These companies actively recruit local owner-operators: J.B. Hunt Final Mile Services (jbhunt.com/final-mile), Ryder Last Mile (ryder.com), HomeDeliveryLink (homedeliverylink.com), UST Logistical Systems, and Direct Impact Logistics. Apply online — most have a "Become a Carrier" page.' },
  { step: '03', title: 'Register on Load Boards', desc: 'DAT One and Truckstop.com are the two largest. DAT subscription starts around $45/month. Truckstop starts at $42/month. Filter by equipment type (straight box truck / 26 ft) and region (DFW). Most brokers on these boards require 3–6 months of active authority before assigning loads.' },
  { step: '04', title: 'Contact Local Warehouses and 3PLs Directly', desc: 'Call or email local warehouses, distribution centers, and third-party logistics companies in DFW. Ask if they use contract carriers for last-mile delivery. This is how long-term relationships get built — direct contact beats load boards for consistent local work.' },
  { step: '05', title: 'Wait Out the 3-Month New Authority Window', desc: 'Many brokers require 90 days of active authority before assigning loads. Use this time to get your carrier packet ready, build relationships, and start with direct contracts. Some final-mile networks (like J.B. Hunt) work with new authorities.' },
  { step: '06', title: 'Negotiate Your Rate', desc: 'For furniture/appliance delivery, standard rate is $75–$95 per stop. Ask for the rate sheet before signing any carrier agreement. Understand whether the pay is per stop, per day flat, or percentage of gross. Get everything in writing before your first run.' },
]

const SEMI_FIRST_CONTRACT_STEPS = [
  { step: '01', title: 'Build Your Carrier Packet', desc: 'Before you contact any broker, have these ready: W-9, COI showing $1M liability + $100K cargo, signed carrier authority page from FMCSA, IFTA license copy, IRP cab card copy, voided check for ACH setup, and your LLC documents. Large brokers have online portals — upload everything before you call.' },
  { step: '02', title: 'Register on DAT One and Truckstop.com', desc: 'These are the two largest load boards for semi owner-operators. DAT subscription starts around $45/month. Truckstop starts at $42/month. Filter by dry van, flatbed, or reefer equipment type and your region (DFW, TX, Southeast). Most brokers require 3–6 months active authority before assigning loads.' },
  { step: '03', title: 'Contact Regional Brokers Directly', desc: 'Reach out to Echo Global Logistics, Coyote Logistics, TQL (Total Quality Logistics), and CH Robinson. Ask to be set up as a new carrier. Some will work with new authorities on shorter lanes (Texas to Oklahoma, Texas to Louisiana) while you build your record.' },
  { step: '04', title: 'Identify Your Home Lane', desc: 'Pick 2–3 consistent lanes out of DFW where you can build broker relationships and minimize deadhead. DFW to Houston, DFW to Dallas to Memphis, and DFW to Atlanta are strong dry van lanes. Consistency on a lane means better rates and preferred carrier status over time.' },
  { step: '05', title: 'Wait Out the 3-Month Authority Window', desc: 'Most brokers on DAT require 90 days of active authority. Use this time to build your carrier packet, set up your lane strategy, and get on preferred carrier lists with direct broker contacts. Landstar and some other carriers have lease-on programs that open after 6 months.' },
  { step: '06', title: 'Negotiate Per-Mile Rate — Don\'t Take the First Offer', desc: 'Dry van spot rates fluctuate with the market. Check DAT rate analytics or Truckstop rate tools before accepting a load. Current dry van averages in the $0.55–$0.70/mile range (all-in). Know your cost per mile (~$0.35–$0.50) before you negotiate so you know your floor.' },
]

type Tab = 'box-truck' | 'semi'

const BOX_TRUCK_SECTIONS = [
  { id: 'bt-requirements', label: 'Requirements' },
  { id: 'bt-earnings', label: 'Earnings' },
  { id: 'startup-costs', label: 'Startup Costs' },
  { id: 'startup-checklist', label: 'Checklist' },
  { id: 'equipment', label: 'Equipment' },
  { id: 'insurance', label: 'Insurance' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'first-contract', label: 'First Contract' },
  { id: 'faq', label: 'FAQ' },
  { id: 'glossary', label: 'Glossary' },
]

const SEMI_SECTIONS = [
  { id: 'semi-requirements', label: 'Requirements' },
  { id: 'semi-earnings', label: 'Earnings' },
  { id: 'startup-costs', label: 'Startup Costs' },
  { id: 'startup-checklist', label: 'Checklist' },
  { id: 'equipment', label: 'Equipment' },
  { id: 'insurance', label: 'Insurance' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'first-contract', label: 'First Contract' },
  { id: 'faq', label: 'FAQ' },
  { id: 'glossary', label: 'Glossary' },
]

const SEMI_KEY_REQS = [
  { icon: '📋', title: 'Class A CDL Required', desc: 'Mandatory for any combination vehicle with GCWR over 26,001 lbs where the trailer GVWR exceeds 10,000 lbs. No exceptions. Must pass CDL skills test and medical exam.' },
  { icon: '⛽', title: 'IFTA — Quarterly Filing', desc: 'International Fuel Tax Agreement. File quarterly with Texas Comptroller. Deadlines: Jan 31, Apr 30, Jul 31, Oct 31. Late filing triggers penalties plus interest.' },
  { icon: '🪪', title: 'IRP Apportioned Plates', desc: 'Required for all interstate semi operations. Register through TxDMV. Single registration covers all 48 contiguous states. Cost: $1,500–$2,500 depending on GVWR and states operated.' },
  { icon: '📱', title: 'Full ELD & HOS Compliance', desc: '11-hour driving limit, 14-hour on-duty window, 70-hour/8-day rule. Most OTR semi runs do not qualify for the 150-mile short-haul ELD exemption.' },
  { icon: '🏥', title: 'DOT Medical Card', desc: 'Required for all CDL drivers. Renewed every 24 months minimum (or more frequently per examiner). Issued by an FMCSA-certified medical examiner.' },
  { icon: '💰', title: '$750K–$1M Liability Insurance', desc: 'Federal minimum is $750K CSL for non-hazardous freight. Most brokers and shippers require $1M on your COI. Budget $800–$1,800/month for commercial truck insurance.' },
  { icon: '📦', title: 'Cargo Insurance', desc: 'Most brokers require $100K cargo insurance in addition to liability. Some require more depending on freight type. Add $150–$350/month to your insurance budget.' },
  { icon: '🚦', title: 'Drug & Alcohol Testing — Full Program', desc: 'Full FMCSA drug and alcohol testing consortium required. Pre-employment, random (50% drug / 10% alcohol annually), post-accident, reasonable suspicion, return-to-duty.' },
]

const SEMI_EARNINGS_TABLE = [
  { period: 'Per Mile (OTR Dry Van)', low: '$0.45 – $0.55', avg: '$0.58 – $0.68', high: '$0.75 – $0.90+' },
  { period: 'Per Day (Solo OTR)', low: '$250 – $375', avg: '$450 – $600', high: '$700 – $1,100' },
  { period: 'Per Week (5 days)', low: '$1,500 – $2,200', avg: '$2,800 – $3,500', high: '$4,500 – $6,500' },
  { period: 'Per Year (Gross)', low: '$70,000 – $95,000', avg: '$130,000 – $175,000', high: '$200,000 – $280,000+' },
]

const SEMI_BROKERS = [
  { name: 'DAT One', desc: 'Largest load board. Dry van, reefer, flatbed, step-deck. Subscription ~$45/month. Most brokers require 6–12 months active authority.' },
  { name: 'Truckstop.com', desc: 'Major load board with rate analytics. ~$42/month. Filter by equipment type and lane. Good for finding consistent lanes early.' },
  { name: 'J.B. Hunt 360°', desc: 'Digital freight matching platform. Direct contracts available for contracted lanes. Preferred for owner-operators with good safety scores.' },
  { name: 'Echo Global Logistics', desc: 'Mid-sized broker with consistent dry van freight across TX, OK, AR, and surrounding states. Active DFW lanes.' },
  { name: 'Coyote Logistics', desc: 'Large national broker. Dry van and reefer. Pays within 30 days or QuickPay with 2% fee. Good lane density in the Southeast and Midwest.' },
  { name: 'Landstar (LEAM)', desc: 'Owner-operator focused. Lease-on program requires 6 months authority minimum. High pay, higher standards — good long-term play.' },
]

// ── Page ─────────────────────────────────────────────────────────────────────

function scrollTo(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  const offset = 145 // main nav (73px) + tab bar (~72px)
  const top = el.getBoundingClientRect().top + window.scrollY - offset
  window.scrollTo({ top, behavior: 'smooth' })
}

export default function StartYourCarrierPage() {
  const [activeTab, setActiveTab] = useState<Tab>('box-truck')

  function switchTab(tab: Tab) {
    setActiveTab(tab)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const sections = activeTab === 'box-truck' ? BOX_TRUCK_SECTIONS : SEMI_SECTIONS

  return (
    <main style={{ background: 'var(--bg)', color: 'var(--text)' }}>

      {/* ── Nav ── */}
      <div className="fixed top-0 left-0 right-0 z-50" style={{ background: 'rgba(11,11,12,0.95)', backdropFilter: 'blur(12px)', borderBottom: '1px solid rgba(255,255,255,.08)' }}>
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="text-xl font-black tracking-tight" style={{ color: '#fff', letterSpacing: '-0.03em', textDecoration: 'none' }}>
            {COMPANY.nameLead} <span style={{ color: 'var(--red)' }}>{COMPANY.nameAccent}</span>
          </Link>
          <nav className="hidden md:flex items-center gap-8">
            {/* "/#about" pointed at an anchor that never existed — /about is now a real page. */}
            {[['Services', '/#services'], ['About', '/about'], ['Coverage', '/#coverage'], ['Contact', '/#contact']].map(([label, href]) => (
              <Link key={href} href={href} className="text-sm font-medium transition hover:text-white" style={{ color: 'var(--muted)', textDecoration: 'none' }}>{label}</Link>
            ))}
            <Link href="/start-your-carrier" className="text-sm font-bold" style={{ color: '#ff6680', textDecoration: 'none' }}>Start a Carrier</Link>
          </nav>
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

      {/* ── Tab Bar ── */}
      <div className="sticky z-40" style={{ top: '73px', background: 'rgba(11,11,12,0.97)', backdropFilter: 'blur(12px)', borderBottom: '1px solid rgba(255,255,255,.08)' }}>
        <div className="max-w-6xl mx-auto px-6">
          {/* Vehicle type tabs */}
          <div className="flex items-center gap-1 pt-3 pb-2">
            <button
              onClick={() => switchTab('box-truck')}
              className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-bold transition-all"
              style={{
                background: activeTab === 'box-truck' ? 'var(--red)' : 'rgba(255,255,255,.05)',
                color: activeTab === 'box-truck' ? '#fff' : 'var(--muted)',
                border: activeTab === 'box-truck' ? 'none' : '1px solid rgba(255,255,255,.08)',
              }}>
              📦 Box Truck
            </button>
            <button
              onClick={() => switchTab('semi')}
              className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-bold transition-all"
              style={{
                background: activeTab === 'semi' ? 'var(--red)' : 'rgba(255,255,255,.05)',
                color: activeTab === 'semi' ? '#fff' : 'var(--muted)',
                border: activeTab === 'semi' ? 'none' : '1px solid rgba(255,255,255,.08)',
              }}>
              🚚 Semi / CDL Truck
            </button>
          </div>
          {/* Section jump nav */}
          <div className="flex items-center gap-1 pb-3 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
            {sections.map(s => (
              <button
                key={s.id}
                onClick={() => scrollTo(s.id)}
                className="shrink-0 px-3 py-1 rounded-lg text-xs font-semibold transition-colors hover:text-white"
                style={{ color: 'rgba(255,255,255,.35)', background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.06)' }}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Box Truck Requirements ── */}
      {activeTab === 'box-truck' && <section id="bt-requirements" className="py-24 px-6" style={{ borderBottom: '1px solid var(--line)' }}>
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
      </section>}

      {/* ── Semi Requirements ── */}
      {activeTab === 'semi' && <section id="semi-requirements" className="py-24 px-6" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-4xl mx-auto">
          <FadeUp>
            <div className="label mb-4">Semi / CDL Truck — Know Your Requirements</div>
            <h2 className="text-3xl font-black text-white mb-4" style={{ letterSpacing: '-0.04em' }}>
              Full CDL Compliance — <span style={{ color: 'var(--red)' }}>Class A Required</span>
            </h2>
            <p className="text-base mb-10" style={{ color: 'var(--muted)' }}>
              Operating a semi or combination vehicle comes with the full weight of FMCSA compliance. There are no IFTA exemptions, no IRP exemptions, and most OTR routes don't qualify for the short-haul ELD exception. Know what you're getting into before you register.
            </p>
          </FadeUp>

          {/* Key requirements grid */}
          <div className="grid sm:grid-cols-2 gap-4 mb-10">
            {SEMI_KEY_REQS.map((req, i) => (
              <FadeUp key={i} delay={i * 40}>
                <div className="p-5 rounded-2xl h-full" style={{ background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.1)' }}>
                  <div className="flex items-start gap-3">
                    <span className="text-xl shrink-0">{req.icon}</span>
                    <div>
                      <p className="text-sm font-black text-white mb-1" style={{ letterSpacing: '-0.01em' }}>{req.title}</p>
                      <p className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>{req.desc}</p>
                    </div>
                  </div>
                </div>
              </FadeUp>
            ))}
          </div>

          {/* Semi vs Box Truck key differences callout */}
          <FadeUp delay={200}>
            <div className="p-6 rounded-2xl" style={{ background: 'rgba(224,0,42,.06)', border: '1px solid rgba(224,0,42,.2)' }}>
              <p className="text-sm font-black text-white mb-4">What Semi Adds vs. Box Truck Under 26K lbs</p>
              <div className="grid sm:grid-cols-2 gap-3">
                {[
                  { item: 'Class A CDL', note: 'Required — no exceptions' },
                  { item: 'IFTA Quarterly Filing', note: 'Box trucks under 26K lbs are exempt' },
                  { item: 'IRP Apportioned Plates', note: 'Box trucks under 26K lbs are exempt' },
                  { item: 'Full ELD (no short-haul on OTR)', note: 'Box trucks often qualify for 150-mi exemption' },
                  { item: 'Higher Insurance Cost', note: '$800–$1,800/mo vs $400–$800/mo for box truck' },
                  { item: 'Cargo Insurance', note: 'Brokers typically require $100K cargo separately' },
                ].map((d, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span style={{ color: '#ff6680', marginTop: '2px', fontSize: '10px' }}>▲</span>
                    <div>
                      <p className="text-xs font-bold text-white">{d.item}</p>
                      <p className="text-xs" style={{ color: 'var(--muted)' }}>{d.note}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </FadeUp>
        </div>
      </section>}

      {/* ── Earnings Potential ── */}
      {activeTab === 'box-truck' && <section id="bt-earnings" className="py-24 px-6" style={{ borderBottom: '1px solid var(--line)' }}>
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
      </section>}

      {/* ── Semi Earnings ── */}
      {activeTab === 'semi' && <section id="semi-earnings" className="py-24 px-6" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-4xl mx-auto">
          <FadeUp>
            <div className="label mb-4">What You Can Earn</div>
            <h2 className="text-3xl font-black text-white mb-4" style={{ letterSpacing: '-0.04em' }}>Semi / OTR Earnings — Dry Van &amp; Regional</h2>
            <p className="text-base mb-3" style={{ color: 'var(--muted)' }}>
              Semi owner-operators running OTR or regional routes have higher gross revenue potential than box trucks — but also higher overhead (fuel, truck payment, tires, maintenance). These numbers reflect dry van solo owner-operators. Team runs and specialized freight can exceed these figures significantly.
            </p>
            <p className="text-xs mb-12" style={{ color: 'rgba(255,255,255,.35)' }}>
              Gross figures before expenses. Per-mile rates reflect current dry van spot market. Owner-operator overhead runs $0.35–$0.55/mile after all costs.
            </p>
          </FadeUp>

          <FadeUp delay={40}>
            <div className="overflow-x-auto mb-8">
              <table className="w-full text-sm" style={{ borderCollapse: 'separate', borderSpacing: '0 6px' }}>
                <thead>
                  <tr>
                    <th className="text-left pb-3 text-xs font-bold uppercase tracking-widest" style={{ color: 'rgba(255,255,255,.3)', paddingLeft: '16px' }}>Timeframe</th>
                    <th className="text-left pb-3 text-xs font-bold uppercase tracking-widest" style={{ color: 'rgba(255,255,255,.3)', paddingLeft: '16px' }}>Low</th>
                    <th className="text-left pb-3 text-xs font-bold uppercase tracking-widest" style={{ color: 'rgba(255,255,255,.3)', paddingLeft: '16px' }}>Average</th>
                    <th className="text-left pb-3 text-xs font-bold uppercase tracking-widest" style={{ color: 'rgba(255,255,255,.3)', paddingLeft: '16px' }}>High</th>
                  </tr>
                </thead>
                <tbody>
                  {SEMI_EARNINGS_TABLE.map((row, i) => (
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

          <FadeUp delay={80}>
            <div className="mb-8">
              <p className="text-sm font-bold text-white mb-4">Brokers & Load Boards for Semi Owner-Operators</p>
              <div className="grid sm:grid-cols-2 gap-3">
                {SEMI_BROKERS.map((co, i) => (
                  <div key={i} className="p-4 rounded-2xl" style={{ background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
                    <p className="text-xs font-black text-white mb-1">{co.name}</p>
                    <p className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>{co.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          </FadeUp>

          <FadeUp delay={120}>
            <div className="p-6 rounded-2xl" style={{ background: 'rgba(224,0,42,.05)', border: '1px solid rgba(224,0,42,.2)' }}>
              <p className="text-sm font-black text-white mb-4">Expense Reality Check — Semi Owner-Operator</p>
              <div className="grid sm:grid-cols-2 gap-x-8 gap-y-3">
                {[
                  { item: 'Diesel Fuel', cost: '$600 – $1,200 / week' },
                  { item: 'Commercial Insurance', cost: '$800 – $1,800 / month' },
                  { item: 'Truck Payment / Lease', cost: '$1,500 – $3,500 / month' },
                  { item: 'Trailer Lease (if applicable)', cost: '$300 – $600 / month' },
                  { item: 'Maintenance & Tires', cost: '$500 – $1,500 / month avg' },
                  { item: 'ELD + Comms Subscription', cost: '$75 – $150 / month' },
                ].map((exp, i) => (
                  <div key={i} className="flex items-center justify-between gap-4 py-1" style={{ borderBottom: '1px solid rgba(255,255,255,.06)' }}>
                    <p className="text-xs font-semibold text-white">{exp.item}</p>
                    <p className="text-xs shrink-0" style={{ color: '#ff6680' }}>{exp.cost}</p>
                  </div>
                ))}
              </div>
              <p className="text-xs mt-4 leading-relaxed" style={{ color: 'rgba(255,255,255,.4)' }}>
                Net income after all expenses for a solo OTR semi owner-operator typically runs <strong style={{ color: 'rgba(255,255,255,.7)' }}>$70,000 – $140,000 per year</strong>. High-earning operators run consistent contracted lanes and minimize deadhead miles.
              </p>
            </div>
          </FadeUp>
        </div>
      </section>}

      {/* ── Startup Costs ── */}
      <section id="startup-costs" className="py-24 px-6" style={{ background: 'rgba(255,255,255,.015)', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-4xl mx-auto">
          <FadeUp>
            <div className="label mb-4">How Much Do You Need?</div>
            <h2 className="text-3xl font-black text-white mb-4" style={{ letterSpacing: '-0.04em' }}>Startup Cost Breakdown</h2>
            <p className="text-base mb-3" style={{ color: 'var(--muted)' }}>
              {activeTab === 'box-truck'
                ? <span>Total startup cost for a box truck owner-operator runs <strong style={{ color: '#fff' }}>$20,000–$65,000</strong> depending on whether you buy or lease your truck. The compliance costs alone (authority, insurance deposit, UCR) run $2,500–$3,500 before you touch a load. Trucks under 26K lbs skip IRP plates and IFTA entirely.</span>
                : <span>Total startup cost for a semi owner-operator runs <strong style={{ color: '#fff' }}>$70,000–$200,000+</strong> depending on tractor/trailer purchase vs. lease. Compliance costs (authority, insurance deposit, IRP, IFTA, UCR) run $4,000–$6,000 before your first load. A Class A CDL is required — budget for CDL school if you don't already have one.</span>}
            </p>
            <p className="text-xs mb-10" style={{ color: 'rgba(255,255,255,.35)' }}>
              Figures are estimates as of 2026. Truck prices vary widely by age, condition, and market. Insurance premiums vary by driving record and coverage level.
            </p>
          </FadeUp>
          <FadeUp delay={60}>
            <div className="overflow-x-auto mb-8">
              <table className="w-full text-xs" style={{ borderCollapse: 'separate', borderSpacing: '0 5px' }}>
                <thead>
                  <tr>
                    <th className="text-left pb-3 font-bold uppercase tracking-widest" style={{ color: 'rgba(255,255,255,.3)', paddingLeft: '14px', fontSize: '10px' }}>Item</th>
                    <th className="text-left pb-3 font-bold uppercase tracking-widest" style={{ color: 'rgba(255,255,255,.3)', paddingLeft: '14px', fontSize: '10px' }}>Low Est.</th>
                    <th className="text-left pb-3 font-bold uppercase tracking-widest" style={{ color: 'rgba(255,255,255,.3)', paddingLeft: '14px', fontSize: '10px' }}>High Est.</th>
                    <th className="text-left pb-3 font-bold uppercase tracking-widest" style={{ color: 'rgba(255,255,255,.3)', paddingLeft: '14px', fontSize: '10px' }}>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {(activeTab === 'box-truck' ? STARTUP_COSTS : SEMI_STARTUP_COSTS).map((row, i) => (
                    <tr key={i}>
                      <td className="py-3 px-4 font-bold text-white rounded-l-xl" style={{ background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)', borderRight: 'none', whiteSpace: 'nowrap' }}>{row.item}</td>
                      <td className="py-3 px-4" style={{ background: 'rgba(255,255,255,.03)', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)', color: '#4ade80', fontWeight: 700 }}>{row.low}</td>
                      <td className="py-3 px-4" style={{ background: 'rgba(255,255,255,.03)', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)', color: '#ff6680', fontWeight: 700 }}>{row.high}</td>
                      <td className="py-3 px-4 rounded-r-xl" style={{ background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)', borderLeft: 'none', color: 'var(--muted)' }}>{row.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </FadeUp>
          <FadeUp delay={120}>
            <div className="grid sm:grid-cols-3 gap-4">
              {[
                { label: 'Compliance Only (no truck)', amount: '$2,500 – $4,000', note: 'Authority, insurance deposit, BOC-3, UCR, LLC formation' },
                { label: 'With Used Box Truck (16–24 ft)', amount: '$20,000 – $45,000', note: 'Includes truck purchase, compliance, equipment, 3-month reserve' },
                { label: 'With Used 26 ft Box Truck', amount: '$35,000 – $75,000', note: 'Includes truck, IRP plates, full compliance, equipment, reserve' },
              ].map((s, i) => (
                <div key={i} className="glass-card p-5 text-center" style={{ borderRadius: '16px' }}>
                  <p className="text-xs font-bold mb-2 uppercase tracking-widest" style={{ color: 'var(--muted)' }}>{s.label}</p>
                  <p className="text-xl font-black mb-2" style={{ color: 'var(--red)', letterSpacing: '-0.03em' }}>{s.amount}</p>
                  <p className="text-xs leading-relaxed" style={{ color: 'rgba(255,255,255,.35)' }}>{s.note}</p>
                </div>
              ))}
            </div>
          </FadeUp>
        </div>
      </section>

      {/* ── Startup Checklist ── */}
      <section id="startup-checklist" className="py-24 px-6">
        <div className="max-w-4xl mx-auto">
          <FadeUp>
            <div className="label mb-4">Step-by-Step Startup</div>
            <h2 className="text-3xl font-black text-white mb-4" style={{ letterSpacing: '-0.04em' }}>Getting Your Authority: 12 Steps</h2>
            <p className="text-base mb-6" style={{ color: 'var(--muted)' }}>
              Follow these in order. Steps 3–5 must happen in parallel — your authority won't activate until FMCSA has both your insurance filing and your BOC-3 on file.
            </p>
            {activeTab === 'semi' && (
              <div className="flex items-start gap-3 p-4 rounded-xl mb-10" style={{ background: 'rgba(250,204,21,.07)', border: '1px solid rgba(250,204,21,.2)' }}>
                <span style={{ color: '#facc15', fontSize: '18px' }}>🚚</span>
                <p className="text-xs leading-relaxed" style={{ color: 'rgba(255,255,255,.6)' }}>
                  <strong style={{ color: '#facc15' }}>Semi / CDL Note:</strong> Steps 7 (IFTA) and 6 (IRP plates) are required for all semi operators — no weight exemptions. Step 9 (ELD) applies in full — the 150-mile short-haul exemption rarely applies to OTR routes. A Class A CDL is required before operating any combination vehicle.
                </p>
              </div>
            )}
            {activeTab === 'box-truck' && (
              <div className="flex items-start gap-3 p-4 rounded-xl mb-10" style={{ background: 'rgba(74,222,128,.07)', border: '1px solid rgba(74,222,128,.2)' }}>
                <span style={{ fontSize: '18px' }}>📦</span>
                <p className="text-xs leading-relaxed" style={{ color: 'rgba(255,255,255,.6)' }}>
                  <strong style={{ color: '#4ade80' }}>Box Truck Note:</strong> If your truck is under 26,000 lbs GVWR, skip Steps 6 (IRP plates) and 7 (IFTA) — they do not apply. Step 9 (ELD) may qualify for the 150-mile short-haul exemption if you run local DFW routes. No CDL required under 26K lbs.
                </p>
              </div>
            )}
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

      {/* ── Equipment Checklist ── */}
      <section id="equipment" className="py-24 px-6">
        <div className="max-w-4xl mx-auto">
          <FadeUp>
            <div className="label mb-4">What You Need in the Truck</div>
            <h2 className="text-3xl font-black text-white mb-4" style={{ letterSpacing: '-0.04em' }}>
              {activeTab === 'box-truck' ? 'Box Truck Equipment Checklist' : 'Semi / OTR Equipment Checklist'}
            </h2>
            <p className="text-base mb-12" style={{ color: 'var(--muted)' }}>
              {activeTab === 'box-truck'
                ? 'Most logistics companies will inspect your truck and equipment before assigning routes. Missing items can get you pulled from a contract on your first day. Have everything on this list before you take your first load.'
                : 'Roadside inspectors and brokers can spot an unprepared operator fast. Have every compliance document in the truck, all safety equipment in place, and your ELD connected and calibrated before your first run.'}
            </p>
          </FadeUp>
          <div className="grid sm:grid-cols-2 gap-6">
            {(activeTab === 'box-truck' ? EQUIPMENT_LIST : SEMI_EQUIPMENT_LIST).map((cat, i) => (
              <FadeUp key={cat.category} delay={i * 60}>
                <div className="glass-card p-6 h-full" style={{ borderRadius: '18px' }}>
                  <p className="text-xs font-black uppercase tracking-widest mb-4" style={{ color: 'var(--red)', letterSpacing: '0.1em' }}>{cat.category}</p>
                  <ul className="space-y-2">
                    {cat.items.map((item, j) => (
                      <li key={j} className="flex items-start gap-2 text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
                        <span className="mt-0.5 shrink-0" style={{ color: 'var(--red)' }}>✓</span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              </FadeUp>
            ))}
          </div>
        </div>
      </section>

      {/* ── Insurance Summary ── */}
      <section id="insurance" className="py-20 px-6" style={{ background: 'rgba(255,255,255,.015)', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
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

      {/* ── First Contract ── */}
      <section id="first-contract" className="py-24 px-6">
        <div className="max-w-4xl mx-auto">
          <FadeUp>
            <div className="label mb-4">Finding Work</div>
            <h2 className="text-3xl font-black text-white mb-4" style={{ letterSpacing: '-0.04em' }}>
              {activeTab === 'box-truck' ? 'How to Get Your First Contract' : 'How to Land Your First Load'}
            </h2>
            <p className="text-base mb-12" style={{ color: 'var(--muted)' }}>
              {activeTab === 'box-truck'
                ? 'Getting your authority is step one. Getting paid is step two. Here\'s how to land your first contract — and what you need ready before you make contact with any logistics company.'
                : 'Authority is just your license to operate. Revenue comes from brokers, load boards, and direct relationships. Here\'s how to get your first load — and what every semi owner-operator needs ready before picking up the phone.'}
            </p>
          </FadeUp>
          <div className="space-y-5">
            {(activeTab === 'box-truck' ? FIRST_CONTRACT_STEPS : SEMI_FIRST_CONTRACT_STEPS).map((s, i) => (
              <FadeUp key={s.step} delay={i * 50}>
                <div className="glass-card p-6" style={{ borderRadius: '16px' }}>
                  <div className="flex gap-4 items-start">
                    <div className="shrink-0 w-10 h-10 rounded-xl flex items-center justify-center font-black text-xs" style={{ background: 'rgba(224,0,42,.12)', border: '1px solid rgba(224,0,42,.25)', color: 'var(--red)' }}>{s.step}</div>
                    <div>
                      <p className="text-sm font-black text-white mb-2" style={{ letterSpacing: '-0.01em' }}>{s.title}</p>
                      <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>{s.desc}</p>
                    </div>
                  </div>
                </div>
              </FadeUp>
            ))}
          </div>
        </div>
      </section>

      {/* ── Taxes ── */}
      <section className="py-24 px-6" style={{ background: 'rgba(255,255,255,.015)', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-4xl mx-auto">
          <FadeUp>
            <div className="label mb-4">Tax Planning</div>
            <h2 className="text-3xl font-black text-white mb-4" style={{ letterSpacing: '-0.04em' }}>Taxes for Owner-Operators</h2>
            <p className="text-base mb-10" style={{ color: 'var(--muted)' }}>
              As an owner-operator, you are self-employed. Nobody withholds taxes for you. Most new carriers get blindsided by their first tax bill. Here's what you need to know before you earn your first dollar.
            </p>
          </FadeUp>
          <div className="grid sm:grid-cols-2 gap-6 mb-8">
            {[
              { title: 'Self-Employment Tax', value: '15.3%', detail: '12.4% Social Security + 2.9% Medicare on all net self-employment income. You pay both the employer and employee share. You can deduct half of SE tax on your return.' },
              { title: 'Federal Income Tax', value: '10–22%', detail: 'Depends on your taxable income after deductions. Most owner-operators with $60K–$100K net income fall in the 22% bracket.' },
              { title: 'Quarterly Estimated Tax', value: '4× per year', detail: 'Due: April 15, June 15, Sep 15, Jan 15. If you expect to owe $1,000+ in taxes, you must pay quarterly or face IRS underpayment penalties.' },
              { title: 'Set Aside Weekly', value: '25–30%', detail: 'Set aside 25–30% of your net income every single week into a separate savings account. Pay yourself from the rest. Never mix this money with operating funds.' },
            ].map((card, i) => (
              <FadeUp key={card.title} delay={i * 60}>
                <div className="glass-card p-6" style={{ borderRadius: '16px' }}>
                  <p className="text-xs font-bold uppercase tracking-widest mb-2" style={{ color: 'var(--muted)' }}>{card.title}</p>
                  <p className="text-3xl font-black mb-3" style={{ color: 'var(--red)', letterSpacing: '-0.04em' }}>{card.value}</p>
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>{card.detail}</p>
                </div>
              </FadeUp>
            ))}
          </div>
          <FadeUp delay={240}>
            <div className="glass-card p-6" style={{ borderRadius: '18px' }}>
              <p className="text-sm font-black text-white mb-4">Key Tax Deductions for Owner-Operators (2026)</p>
              <div className="grid sm:grid-cols-2 gap-x-8 gap-y-2">
                {[
                  'Fuel (actual cost or 72.5¢/mile standard rate)',
                  'Commercial insurance premiums',
                  'Truck loan interest or lease payments',
                  'Truck depreciation (100% bonus depreciation available through 2029)',
                  'Maintenance and repairs',
                  'ELD subscription and device',
                  'Drug testing program fees',
                  'DOT physicals',
                  'Licensing and permit fees (UCR, IRP, IFTA)',
                  'Cell phone (business use %)',
                  'Load board subscriptions (DAT, Truckstop)',
                  'Meals per diem — 80% deductible when away from home',
                  'Accountant / bookkeeper fees',
                  'Home office (if you manage dispatch from home)',
                ].map((item, i) => (
                  <div key={i} className="flex items-center gap-2 py-1.5" style={{ borderBottom: '1px solid rgba(255,255,255,.05)' }}>
                    <span className="shrink-0 text-xs" style={{ color: 'var(--red)' }}>✓</span>
                    <p className="text-xs" style={{ color: 'var(--muted)' }}>{item}</p>
                  </div>
                ))}
              </div>
              <p className="text-xs mt-5 leading-relaxed" style={{ color: 'rgba(255,255,255,.35)' }}>
                Keep every receipt and log every business mile. Use accounting software (QuickBooks Self-Employed, Wave) from day one. A trucking-specialized accountant or tax service (ATBS, Owner Operator Services) is worth the cost — they typically save more than they charge.
              </p>
            </div>
          </FadeUp>
        </div>
      </section>

      {/* ── Compliance Calendar ── */}
      <section id="calendar" className="py-24 px-6">
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

      {/* ── Common Mistakes ── */}
      <section className="py-20 px-6" style={{ borderTop: '1px solid var(--line)' }}>
        <div className="max-w-4xl mx-auto">
          <FadeUp>
            <div className="label mb-4">Avoid These Pitfalls</div>
            <h2 className="text-3xl font-black text-white mb-4" style={{ letterSpacing: '-0.04em' }}>
              {activeTab === 'box-truck' ? '10 Common Mistakes New Box Truck Carriers Make' : '10 Common Mistakes New Semi Operators Make'}
            </h2>
            <p className="text-base mb-10 leading-relaxed" style={{ color: 'var(--muted)' }}>
              These mistakes cost new carriers money, violations, and sometimes their operating authority. Read each one before you haul your first load.
            </p>
          </FadeUp>
          <div className="space-y-4">
            {(activeTab === 'box-truck' ? COMMON_MISTAKES : SEMI_COMMON_MISTAKES).map((item, i) => (
              <FadeUp key={i} delay={i * 40}>
                <div className="rounded-2xl p-5" style={{ background: 'rgba(224,0,42,.06)', border: '1px solid rgba(224,0,42,.2)' }}>
                  <p className="text-sm font-black text-white mb-2">⚠ {item.mistake}</p>
                  <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>{item.consequence}</p>
                </div>
              </FadeUp>
            ))}
          </div>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section id="faq" className="py-20 px-6" style={{ background: 'rgba(255,255,255,.015)', borderTop: '1px solid var(--line)' }}>
        <div className="max-w-4xl mx-auto">
          <FadeUp>
            <div className="label mb-4">Frequently Asked Questions</div>
            <h2 className="text-3xl font-black text-white mb-10" style={{ letterSpacing: '-0.04em' }}>Questions New Carriers Ask</h2>
          </FadeUp>
          <div className="space-y-4">
            {(activeTab === 'box-truck' ? FAQ : SEMI_FAQ).map((item, i) => (
              <FadeUp key={i} delay={i * 40}>
                <div className="glass-card p-6 rounded-2xl">
                  <p className="text-sm font-black text-white mb-3">Q: {item.q}</p>
                  <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>{item.a}</p>
                </div>
              </FadeUp>
            ))}
          </div>
        </div>
      </section>

      {/* ── Glossary ── */}
      <section id="glossary" className="py-20 px-6" style={{ borderTop: '1px solid var(--line)' }}>
        <div className="max-w-4xl mx-auto">
          <FadeUp>
            <div className="label mb-4">Industry Terms</div>
            <h2 className="text-3xl font-black text-white mb-4" style={{ letterSpacing: '-0.04em' }}>Glossary</h2>
            <p className="text-base mb-10 leading-relaxed" style={{ color: 'var(--muted)' }}>
              Every acronym and term you'll encounter when starting and running a motor carrier business.
            </p>
          </FadeUp>
          <div className="grid sm:grid-cols-2 gap-4">
            {GLOSSARY.map((item, i) => (
              <FadeUp key={i} delay={i * 30}>
                <div className="glass-card p-5 rounded-2xl h-full">
                  <p className="text-sm font-black mb-2" style={{ color: 'var(--red)' }}>{item.term}</p>
                  <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>{item.def}</p>
                </div>
              </FadeUp>
            ))}
          </div>
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

      {/* ── OpsPilot — the platform behind the carrier network ──────────────────
          Placed after the guide's substance and immediately before the "haul with
          us" CTA: by this point the reader is an aspiring or active carrier, and
          the most persuasive thing we can show them is the machinery. ────────── */}
      <section id="opspilot" className="py-24 px-6" style={{ position: 'relative', overflow: 'hidden', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
        <div className="ops-grid" aria-hidden style={{ position: 'absolute', inset: 0 }} />
        <div className="max-w-6xl mx-auto" style={{ position: 'relative' }}>
          <FadeUp>
            <span style={{ color: 'var(--ops-steel)', display: 'inline-flex' }}>
              <OpsPilotMark size={40} title="OpsPilot" />
            </span>
            <h2 className="text-3xl font-black text-white mt-6 mb-4" style={{ letterSpacing: '-0.04em' }}>
              The Technology Behind Every Route
            </h2>
            <p className="text-base max-w-3xl leading-relaxed" style={{ color: 'var(--muted)' }}>
              When you haul with J Kiss, you&apos;re not just joining another carrier network. Every assignment
              is managed through <OpsPilotWordmark tm style={{ color: '#fff' }} /> — our proprietary operations
              platform designed to simplify scheduling, confirmations, communication, claims, and contractor
              management.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <span className="ops-badge">Built In-House</span>
              <span className="ops-badge">Running in Production</span>
            </div>
          </FadeUp>

          <div className="mt-12">
            <CapabilityGrid tone="dark" />
          </div>

          {/* ── Coming soon: early interest ── */}
          <FadeUp delay={120}>
            <div
              className="glass-card mt-14"
              style={{ padding: 'clamp(26px, 4vw, 44px)', borderRadius: 22, background: 'linear-gradient(135deg, rgba(204,212,224,.05), rgba(255,255,255,.015))' }}
            >
              <span className="ops-badge">
                <Lock size={12} strokeWidth={2} /> Coming Soon
              </span>
              <h3 className="text-2xl font-black text-white mt-5 mb-3" style={{ letterSpacing: '-0.03em' }}>
                Operion is coming to other operators.
              </h3>
              <p className="text-sm leading-relaxed max-w-2xl mb-7" style={{ color: 'var(--muted)' }}>
                We&apos;re opening Operion up to other owner-operators and service businesses. If you want
                first access when we do, join the early interest list.
              </p>
              <EarlyAccessForm source="/start-your-carrier" tone="dark" />
            </div>
          </FadeUp>
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
                {COMPANY.legalName} has operated in the DFW freight market for over 5 years (since September 2020). We partner with warehouses, retailers, and logistics companies that need a reliable carrier they can count on.
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
            {COMPANY.nameLead} <span style={{ color: 'var(--red)' }}>{COMPANY.nameAccent}</span>
          </p>
          <p className="text-xs text-center" style={{ color: 'rgba(255,255,255,.25)' }}>
            © {new Date().getFullYear()} {COMPANY.legalName} · {CREDENTIALS_DOT}
          </p>
          <Link href="/" className="text-xs transition-colors hover:text-white" style={{ color: 'rgba(255,255,255,.35)', textDecoration: 'none' }}>← Back to Home</Link>
        </div>
        {/* This page has its own slim close, so the platform gets the compact mark. */}
        <div className="max-w-4xl mx-auto mt-7 pt-6 flex justify-center" style={{ borderTop: '1px solid var(--line)' }}>
          <PoweredByBand variant="compact" />
        </div>
      </footer>
    </main>
  )
}
