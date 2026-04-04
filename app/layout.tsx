import type { Metadata } from 'next'
import { Analytics } from '@vercel/analytics/react'
import './globals.css'

const SITE_URL = 'https://www.jkissllc.com'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'J Kiss LLC — Freight & Last-Mile Delivery | Dallas–Fort Worth',
  description: 'J Kiss LLC is a licensed freight and last-mile delivery company serving the Dallas–Fort Worth metroplex. Trusted by Lowe\'s, Rooms To Go, Living Spaces, RH, Nebraska Furniture Mart, and XPO Logistics. US DOT 3484556.',
  keywords: 'freight delivery DFW, last-mile delivery Dallas, freight contractor Texas, logistics Dallas Fort Worth, furniture delivery Dallas, appliance delivery DFW, XPO contractor, Lowes delivery contractor',
  authors: [{ name: 'J Kiss LLC' }],
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true },
  },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    title: 'J Kiss LLC — Freight & Last-Mile Delivery | DFW',
    description: 'Licensed freight and last-mile delivery across Dallas–Fort Worth. Trusted by Lowe\'s, Rooms To Go, Living Spaces, RH, Nebraska Furniture Mart, and XPO Logistics.',
    siteName: 'J Kiss LLC',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'J Kiss LLC — Freight & Last-Mile Delivery | DFW',
    description: 'Licensed freight and last-mile delivery across Dallas–Fort Worth.',
  },
  alternates: {
    canonical: SITE_URL,
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* LocalBusiness structured data for Google */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'LocalBusiness',
              name: 'J Kiss LLC',
              description: 'Licensed freight and last-mile delivery company serving the Dallas–Fort Worth metroplex.',
              url: SITE_URL,
              email: 'info@jkissllc.com',
              areaServed: {
                '@type': 'AdministrativeArea',
                name: 'Dallas–Fort Worth Metroplex',
              },
              address: {
                '@type': 'PostalAddress',
                addressRegion: 'TX',
                addressCountry: 'US',
              },
              knowsAbout: [
                'Freight Delivery',
                'Last-Mile Delivery',
                'Logistics',
                'Furniture Delivery',
                'Appliance Delivery',
              ],
            }),
          }}
        />
        {children}
        <Analytics />
      </body>
    </html>
  )
}
