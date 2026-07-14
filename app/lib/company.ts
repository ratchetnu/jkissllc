// ── Company identity — the single source of truth ────────────────────────────
//
// Every hardcoded "J Kiss LLC", DOT/MC number, phone, email, domain, address, and
// brand-colour literal that used to be sprinkled across ~30 files now lives here.
// The point is a future clone (supercharged, oandc, …) becomes a one-file edit
// instead of a find-and-replace safari.
//
// RULES:
//  • Plain string constants only. No server-only imports, no functions with side
//    effects — this is imported from BOTH server components and 'use client'
//    components, so it must be safe in the browser bundle.
//  • Values are copied BYTE-FOR-BYTE from the literals they replace. This module
//    was introduced as a zero-behaviour-change refactor; the rendered output of
//    every page is identical before and after. Don't "clean up" a value here
//    without owning the behaviour change that follows.
//
// NOT here (deliberately): per-tenant credentials, Stripe/Twilio/Resend keys, the
// auth model. Those are later steps in docs/opspilot-multi-tenant-roadmap.md. This
// file is step 2 only: static identity.

export const COMPANY = {
  // ── Names ──
  // The site uses three forms on purpose; a clone needs all three.
  legalName: 'J Kiss LLC',        // title case — prose, emails, footer, legal
  legalNameUpper: 'J KISS LLC',   // upper — SMS bodies, the contractor disclaimer
  shortName: 'J Kiss',            // no suffix — casual references
  shortNameUpper: 'J KISS',       // upper, no suffix — terse SMS/alert prefixes ("J KISS: …")

  // The two-tone wordmark renders as `{nameLead} <accent>{nameAccent}</accent>`,
  // so the two halves live apart. Markup (and its colour) stays at each call site;
  // only the words come from here. `nameLeadUpper` is for the receipt/confirmation
  // print templates, which set the lead in all-caps.
  nameLead: 'J Kiss',
  nameLeadUpper: 'J KISS',
  nameAccent: 'LLC',

  tagline: 'Box-Truck Delivery, Junk Removal & Cleanouts · Dallas–Fort Worth',

  // ── Federal motor-carrier identifiers ──
  usdot: '3484556',
  mc: '01155352',

  // ── Phone ──
  phoneDisplay: '(817) 909-4312',    // human-readable, regular hyphen
  phoneE164: '+18179094312',         // tel: links / Twilio
  phonePlain: '817-909-4312',        // Apple Cash instruction

  // ── Email ──
  email: 'info@jkissllc.com',            // primary / reply-to
  ownerEmail: 'timmothy@jkissllc.com',   // ops recipient (env OWNER_EMAIL wins)
  emailFrom: 'J Kiss LLC <info@jkissllc.com>',   // Resend "from" header

  // ── Web ──
  domain: 'jkissllc.com',
  // Canonical origin (with www) — metadata, JSON-LD, sitemap, email links.
  siteUrl: 'https://www.jkissllc.com',
  // Apex, NO www. Preserves a pre-existing inconsistency: route-notify.ts's SMS
  // link default is the apex form. Unifying it to `siteUrl` would change the link
  // customers receive, so the two are kept distinct on purpose. Worth reconciling
  // someday — but that's a behaviour change, not this refactor.
  siteUrlApex: 'https://jkissllc.com',

  // Google review destination (env GOOGLE_REVIEW_URL wins).
  reviewUrl: 'https://g.page/r/jkissllc/review',

  // ── Physical address ──
  address: {
    line1: '2901 East Mayfield Road #2103',
    city: 'Grand Prairie',
    state: 'TX',
    zip: '75052',
  },

  // ── Payment handles ──
  zelle: 'jkissbiz@gmail.com',
  // Apple Cash uses the plain-hyphen phone; kept as its own field so a clone can
  // point payments somewhere other than the business line if it wants.
  appleCash: '817-909-4312',

  // ── Brand colours ──
  // These MIRROR the CSS custom properties in globals.css (--red, --red-glow, …).
  // They exist because a handful of .ts/.tsx files hardcode the hex instead of
  // reading the CSS var (canvas drawing, email HTML, inline SVG fills where a CSS
  // var can't reach). Keep this in sync with :root in globals.css.
  brand: {
    red: '#E0002A',
    red600: '#c60025',
    redGlow: '#ff6680',
  },
} as const

// ── Platform identity — the operating-system brand (OpsPilot → Operion) ──────
// Distinct from COMPANY above: COMPANY is the customer-facing TENANT (J Kiss LLC);
// PLATFORM is the software product that powers it and future tenants, shown on
// platform surfaces (the /opspilot marketing page, "Powered by" bands, admin
// chrome, platform emails). This is the single source of truth for the platform
// name/tagline — flip it here and every platform surface follows.
//
// Backward compatibility: internal identifiers, folders (app/opspilot/,
// components/opspilot/, lib/opspilot.ts), routes (/opspilot, /api/opspilot/…),
// component names (OpsPilotMark, …), and code comments intentionally keep the
// legacy `opspilot` slug — renaming them is not user-facing and would break links
// + imports for no benefit.
export const PLATFORM = {
  name: 'Operion',
  nameUpper: 'OPERION',
  tagline: 'AI Operating System for Business',
} as const

// ── Convenience composites ───────────────────────────────────────────────────
// The credential line appears with two different separators across the codebase;
// expose both so no call site has to hand-concatenate (and drift).
export const CREDENTIALS_DOT = `US DOT ${COMPANY.usdot} · MC ${COMPANY.mc}`   // footer, receipts (·)
export const CREDENTIALS_SLASH = `US DOT ${COMPANY.usdot} / MC ${COMPANY.mc}` // email footers (/)

/** "2901 East Mayfield Road #2103, Grand Prairie, TX 75052" */
export const ADDRESS_ONE_LINE =
  `${COMPANY.address.line1}, ${COMPANY.address.city}, ${COMPANY.address.state} ${COMPANY.address.zip}`
