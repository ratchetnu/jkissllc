// Operion FAQ content — plain data, imported by BOTH the server page (for FAQPage
// JSON-LD) and the client accordion (OperionFAQ.tsx). It lives here, outside any
// 'use client' module, so the server component gets the real array to .map() over
// rather than a client-reference proxy.
//
// RULE: answers must reflect verified product status. This is marketing copy that
// must not overclaim — see the capability audit before editing. Two specific lines
// that are easy to get wrong and must stay as written:
//   • Pay is 1099 contractor payout statements. Operion does NOT withhold taxes,
//     run W-2 payroll, or file any form — the roster carries an `employee` pay kind
//     and tracks their time, but the pay engine issues payout statements.
//   • Photo-based instant quoting is ONE intake path, not what Operion is.

export const OPERION_FAQ: { q: string; a: string }[] = [
  {
    q: 'What is Operion?',
    a: 'Operion is the operating system for a crew-based operation. It runs dispatch and recurring routes, the crew and employee roster, time and attendance, equipment and fleet maintenance, customer communication, invoicing, payouts, claims, and owner analytics — in one system. It was built and is run by J KISS LLC to dispatch a real box-truck delivery, freight, and junk-removal operation every day.',
  },
  {
    q: 'Who is Operion built for?',
    a: 'Owner-operators, small trucking and delivery fleets, and any crew-based service business that sends people and vehicles to addresses — contract delivery, freight, moving, property turnovers, field services, junk removal, and estate cleanouts — and has outgrown spreadsheets, group texts, and disconnected apps.',
  },
  {
    q: 'Is Operion just junk-removal or quoting software?',
    a: 'No. Photo-assisted instant quoting is one intake path — the one on-demand hauling and cleanout work uses. Most of the platform is the operational spine underneath it: routes and recurring contracts, crew records, clock-in and timesheets, equipment and maintenance, invoicing, payouts, claims, and reporting. Contract work never touches the quoting flow at all; its routes generate themselves from the contract.',
  },
  {
    q: 'Does Operion handle employees, or only contractors?',
    a: 'The roster carries drivers, helpers, contractors, and employees, and time and attendance works the same for all of them — clock in and out from the field, timesheets by person and period, availability, and time-off approvals. Pay is where the distinction matters: Operion issues 1099 contractor payout statements with year-to-date earnings and tracks year-end readiness (who crosses the reporting threshold, whose W-9 is on file). It is not a tax-withholding W-2 payroll service and does not file forms for you.',
  },
  {
    q: 'Can Operion be configured for my business?',
    a: 'Yes. The same core modules — dispatch, crew, time, equipment, pay, messaging — are configured around how your operation runs, including your own pricing rules, pay rates, contract terms, and recurring routes.',
  },
  {
    q: 'Does Operion replace my current scheduling tools?',
    a: 'It’s designed to. Routes, crew confirmations, hours, messaging, invoicing, and pay live in one place, so you’re not stitching together a booking form, a group text, a spreadsheet, and a notebook. Contract routes and one-off customer jobs land on a single schedule.',
  },
  {
    q: 'How does time tracking work?',
    a: 'Crew clock in and out from their phone on the job they’re assigned to, and the clock-in is checked against that job’s own stored coordinates. Timesheets roll up by person and period for management. A correction is appended, never overwritten — the original punch and the corrected one both stay on the record, with who changed it and why. GPS is operational evidence, not a pay input.',
  },
  {
    q: 'Can customers request service online?',
    a: 'Yes. Customers can book online with job details and photos, see an estimate, and hold their date with a deposit — before your team ever makes a call. Anything the pricing engine reads with low confidence is routed to a person instead of quoted.',
  },
  {
    q: 'Can crew see their schedules, hours, and pay?',
    a: 'Yes. Crew get a private, role-limited portal for their assigned routes, clock in and out, availability, time-off requests, documents, messages, and their own pay statements and year-to-date earnings. They only ever see their own information, and access is enforced on the server rather than hidden in the interface.',
  },
  {
    q: 'Does Operion use AI?',
    a: 'Yes, but in a deliberately limited role. AI helps analyze uploaded job photos to gauge the load, and a plain-English command bar helps you navigate and ask questions about your own data. AI is always advisory — a deterministic engine calculates estimates from your rules, and AI never touches dispatch, time, or pay.',
  },
  {
    q: 'Is Operion available now?',
    a: 'It runs two Dallas–Fort Worth businesses in production today. It’s opening up to more operators through a demo-and-onboarding process rather than instant self-service signup, so each business is set up correctly.',
  },
  {
    q: 'How are updates delivered?',
    a: 'Operion is a managed platform — improvements ship centrally and are validated before they reach you, so you get better software over time without disrupting how you work.',
  },
  {
    q: 'How do I request access?',
    a: 'Use the “Request a Demo” form on this page. Tell us about your operation and a real person from J KISS will follow up to show you the platform.',
  },
]
