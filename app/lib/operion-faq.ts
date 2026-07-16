// Operion FAQ content — plain data, imported by BOTH the server page (for FAQPage
// JSON-LD) and the client accordion (OperionFAQ.tsx). It lives here, outside any
// 'use client' module, so the server component gets the real array to .map() over
// rather than a client-reference proxy.
//
// RULE: answers must reflect verified product status. This is marketing copy that
// must not overclaim — see the capability audit before editing.

export const OPERION_FAQ: { q: string; a: string }[] = [
  {
    q: 'What is Operion?',
    a: 'Operion is an operations platform for service businesses — it connects bookings, crews, routes, customer communication, contractor pay, equipment, and analytics in one system. It was built and is run by J KISS LLC to manage a real freight, delivery, and junk-removal operation every day.',
  },
  {
    q: 'Who is Operion built for?',
    a: 'Contractors, owner-operators, small fleets, and crew-based service businesses — junk removal, moving, delivery, estate cleanouts, property turnovers, and field services — that have outgrown spreadsheets, group texts, and disconnected apps.',
  },
  {
    q: 'Can Operion be configured for my business?',
    a: 'Yes. The same core modules — intake, dispatch, crew, pay, messaging — are configured around how your operation runs, including your own pricing rules, pay rates, and recurring routes.',
  },
  {
    q: 'Does Operion replace my current scheduling tools?',
    a: 'It’s designed to. Bookings, route assignment, crew confirmations, messaging, invoicing, and pay live in one place, so you’re not stitching together a booking form, a group text, a spreadsheet, and a notebook.',
  },
  {
    q: 'Can customers request service online?',
    a: 'Yes. Customers can book online with job details and photos, see an instant estimate, and hold their date with a deposit — before your team ever makes a call.',
  },
  {
    q: 'Can contractors see their schedules and pay?',
    a: 'Yes. Crew and contractors get a private, role-limited portal for their assigned routes, availability, time-off requests, messages, and their own pay statements and year-to-date earnings. They only ever see their own information.',
  },
  {
    q: 'Does Operion use AI?',
    a: 'Yes, but in a deliberately limited role. AI helps analyze uploaded job photos to gauge the load, and a plain-English command palette helps run the system. AI is always advisory — a deterministic pricing engine calculates estimates and the owner reviews and approves. AI never sets your final prices on its own.',
  },
  {
    q: 'Is Operion available now?',
    a: 'It runs two Dallas–Fort Worth service businesses in production today. It’s opening up to more operators through a demo-and-onboarding process rather than instant self-service signup, so each business is set up correctly.',
  },
  {
    q: 'How are updates delivered?',
    a: 'Operion is a managed platform — improvements ship centrally and features can be configured per business, so you get better software over time without disrupting how you work.',
  },
  {
    q: 'How do I request access?',
    a: 'Use the “Request a Demo” form on this page. Tell us about your operation and a real person from J KISS will follow up to show you the platform.',
  },
]
