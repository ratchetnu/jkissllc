import { stripeConfigured } from './stripe'
import { docCryptoReady } from './doc-crypto'
import { COMPANY } from './company'
import type { PaymentMethod } from './bookings'

// Modular payment-provider registry (request Part 17). Each accepted payment method
// is a provider with a common shape, so adding ACH / Cash App / Apple Pay / Venmo /
// business invoicing later is a new entry + adapter — never a rewrite of the booking
// workflow. The booking flow asks this module "which methods are available and how do
// I present them?"; the concrete money movement lives in each provider's route
// (Stripe Checkout, the sealed-proof upload, etc.).

export type PaymentProviderKind =
  | 'redirect'        // hosted checkout the customer is sent to (Stripe)
  | 'proof_upload'    // customer pays out-of-band and uploads verifiable proof (Zelle)
  | 'manual'          // out-of-band, self-reported, no proof (cash / apple cash)

export type PaymentProvider = {
  id: PaymentMethod
  kind: PaymentProviderKind
  label: string                 // card title
  tagline: string               // one-line promise
  bullets: string[]             // UX card bullets
  emoji: string                 // lightweight icon for the card
  requiresProof: boolean        // proof_upload only — the upload is mandatory
  instantConfirm: boolean       // true = confirmed by verified webhook; false = human review
  recipient?: string            // e.g. the Zelle address
  /** Is this provider usable in the current environment (keys / crypto present)? */
  configured: () => boolean
}

// The registry. Order = display order in the checkout.
const REGISTRY: PaymentProvider[] = [
  {
    id: 'stripe', kind: 'redirect', emoji: '💳',
    label: 'Pay with Credit / Debit Card',
    tagline: 'Instant confirmation · secure checkout',
    bullets: ['Booking confirmed immediately after payment verification', 'Encrypted checkout powered by Stripe', 'Apple Pay & Google Pay supported'],
    requiresProof: false, instantConfirm: true,
    configured: stripeConfigured,
  },
  {
    id: 'zelle', kind: 'proof_upload', emoji: '🏦',
    label: 'Pay via Zelle',
    tagline: 'No processing fees',
    bullets: ['No card-processing fee', 'Upload your payment confirmation', 'Booking confirmed after our team verifies your payment'],
    requiresProof: true, instantConfirm: false,
    recipient: COMPANY.zelle,
    // Zelle proof is stored SEALED; without the crypto key we would have to store a
    // payment screenshot unprotected — so fail closed and hide the method instead.
    configured: docCryptoReady,
  },
]

export function getPaymentProvider(id: string): PaymentProvider | undefined {
  return REGISTRY.find(p => p.id === id)
}

export function listPaymentProviders(): PaymentProvider[] {
  return REGISTRY.filter(p => p.configured())
}

// UI-safe projection (no functions) for the client checkout cards.
export type PublicPaymentMethod = Omit<PaymentProvider, 'configured'>
export function publicPaymentMethods(): PublicPaymentMethod[] {
  return listPaymentProviders().map(({ configured: _c, ...rest }) => { void _c; return rest })
}

// A provider requires an uploaded, verifiable proof before the booking may be created.
export function providerRequiresProof(id: string): boolean {
  return !!getPaymentProvider(id)?.requiresProof
}
