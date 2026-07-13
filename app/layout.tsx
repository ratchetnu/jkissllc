import type { Metadata, Viewport } from 'next'
import { Analytics } from '@vercel/analytics/react'
import { BotIdClient } from 'botid/client'
import { Inter, Space_Grotesk, JetBrains_Mono } from 'next/font/google'
import PageTracker from './components/PageTracker'
import { COMPANY } from './lib/company'
import './globals.css'

// Public form endpoints guarded by Vercel BotID's invisible challenge.
const PROTECTED_ROUTES = [
  { path: '/api/contact', method: 'POST' },
  { path: '/api/quote', method: 'POST' },
  { path: '/api/coi', method: 'POST' },
  { path: '/api/ai/photo-estimate', method: 'POST' },
  { path: '/api/book', method: 'POST' },
  { path: '/api/upload', method: 'POST' },
  { path: '/api/opspilot/waitlist', method: 'POST' },
]

const inter = Inter({ subsets: ['latin'], variable: '--font-body', display: 'swap' })
const display = Space_Grotesk({ subsets: ['latin'], variable: '--font-display', display: 'swap', weight: ['500', '600', '700'] })
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' })

const SITE_URL = COMPANY.siteUrl

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: `${COMPANY.legalName} — Delivery, Junk Removal & Cleanouts | Dallas–Fort Worth`,
  description: `${COMPANY.legalName} is DFW's box-truck delivery, junk removal, and eviction & property cleanout specialist — furniture, appliances, building materials, white-glove last-mile, debris hauling, and full-property clear-outs. 16–26 ft straight trucks. Trusted by Lowe's, Rooms To Go, Living Spaces, RH, Nebraska Furniture Mart, and XPO Logistics. US DOT ${COMPANY.usdot}.`,
  keywords: 'box truck delivery DFW, white-glove last-mile Dallas, furniture delivery Dallas, appliance delivery DFW, junk removal Dallas, junk removal DFW, eviction cleanout Dallas, property cleanout DFW, foreclosure cleanout Texas, debris removal Dallas, estate cleanout DFW, box truck contractor Texas, room of choice delivery Dallas, straight truck delivery DFW, retail replenishment Dallas, Lowes delivery contractor, Rooms To Go delivery',
  authors: [{ name: COMPANY.legalName }],
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true },
  },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    title: `${COMPANY.legalName} — Delivery, Junk Removal & Cleanouts | DFW`,
    description: 'Box-truck delivery, junk removal, and eviction & property cleanouts across Dallas–Fort Worth. Furniture, appliances, building materials, white-glove last-mile, debris hauling, and full-property clear-outs. Trusted by Lowe\'s, Rooms To Go, Living Spaces, RH, Nebraska Furniture Mart, and XPO Logistics.',
    siteName: COMPANY.legalName,
    images: [{ url: '/og-image.jpg', width: 1200, height: 630, alt: `${COMPANY.legalName} — Box-Truck Delivery` }],
  },
  twitter: {
    card: 'summary_large_image',
    title: `${COMPANY.legalName} — Delivery, Junk Removal & Cleanouts | DFW`,
    description: 'Delivery, junk removal, and eviction & property cleanouts across Dallas–Fort Worth.',
    images: ['/og-image.jpg'],
  },
  alternates: {
    canonical: SITE_URL,
  },
}

// viewport-fit=cover is what makes env(safe-area-inset-*) resolve to real, non-zero
// values on notched / rounded devices. Without it the whole app's safe-area handling
// (fixed docks, floating buttons, sheet padding) silently collapses to 0.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0b0b0c',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-scroll-behavior="smooth" className={`${inter.variable} ${display.variable} ${mono.variable}`}>
      <head>
        <BotIdClient protect={PROTECTED_ROUTES} />
      </head>
      <body>
        {/* LocalBusiness structured data for Google */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'MovingCompany',
              name: COMPANY.legalName,
              description: 'Box-truck delivery, junk removal, and eviction & property cleanout company serving the Dallas–Fort Worth metroplex. White-glove last-mile, furniture, appliances, building materials, debris hauling, and full-property clear-outs.',
              url: SITE_URL,
              email: COMPANY.email,
              identifier: [
                { '@type': 'PropertyValue', propertyID: 'USDOT', value: COMPANY.usdot },
                { '@type': 'PropertyValue', propertyID: 'MC', value: COMPANY.mc },
              ],
              areaServed: [
                { '@type': 'AdministrativeArea', name: 'Dallas–Fort Worth Metroplex' },
                { '@type': 'City', name: 'Dallas' },
                { '@type': 'City', name: 'Fort Worth' },
                { '@type': 'City', name: 'Arlington' },
                { '@type': 'City', name: 'Plano' },
                { '@type': 'City', name: 'Frisco' },
                { '@type': 'City', name: 'McKinney' },
                { '@type': 'City', name: 'Irving' },
                { '@type': 'City', name: 'Garland' },
                { '@type': 'City', name: 'Denton' },
                { '@type': 'City', name: 'Mesquite' },
              ],
              address: {
                '@type': 'PostalAddress',
                addressRegion: 'TX',
                addressCountry: 'US',
              },
              knowsAbout: [
                'Box Truck Delivery',
                'White-Glove Last-Mile Delivery',
                'Furniture Delivery',
                'Appliance Delivery',
                'Building Materials Delivery',
                'Retail Replenishment',
                'Room-of-Choice Placement',
                'Junk Removal',
                'Debris Hauling',
                'Eviction Cleanout',
                'Property Cleanout',
                'Foreclosure Cleanout',
                'Estate Cleanout',
              ],
            }),
          }}
        />
        {children}
        <Analytics />
        <PageTracker />
      </body>
    </html>
  )
}
