// ── The J KISS reference tenant seed ─────────────────────────────────────────
//
// Tenant #0, seeded BYTE-FOR-BYTE from app/lib/company.ts so that binding the app
// to `t:jkiss` reproduces today's identity exactly. This is configuration, not a
// DB write — nothing persists it this sprint. When Redis tenant records are
// introduced (a later phase), this object is the seed value.

import { COMPANY, ADDRESS_ONE_LINE } from '../../company'
import { DEFAULT_TENANT_ID, type Tenant } from './types'

export const JKISS_TENANT: Tenant = {
  id: DEFAULT_TENANT_ID, // 'jkiss' — opaque, NOT derived from the display name
  slug: 'jkiss',
  domains: ['jkissllc.com', 'www.jkissllc.com', 'jkissllc.vercel.app'],
  channels: {
    smsE164: [COMPANY.phoneE164],
    inboundEmails: [COMPANY.email, COMPANY.emailFrom],
  },
  displayName: COMPANY.legalName,
  legal: {
    dotNumber: COMPANY.usdot,
    mcNumber: COMPANY.mc,
    addressOneLine: ADDRESS_ONE_LINE,
    phone: COMPANY.phoneE164,
    supportEmail: COMPANY.email,
  },
  brand: {
    primaryColor: COMPANY.brand.red,
    emailFromAddress: COMPANY.emailFrom,
  },
  industryPackId: 'jkiss-field-service', // the pack extracted in Tranche B
  status: 'active',
  // Fixed timestamp: tenant #0 predates this system. Avoids Date.now() so the seed
  // is deterministic (and this module stays import-safe in test/build contexts).
  createdAt: 0,
}
