import type { Metadata } from 'next'
import { COMPANY } from '../lib/company';

export const metadata: Metadata = {
  title: `How to Start a Motor Carrier Business in Texas | ${COMPANY.legalName}`,
  description: 'Complete guide to starting a motor carrier business in Texas — USDOT registration, operating authority, insurance requirements, IFTA, IRP, ELD rules, drug testing, and a monthly/quarterly/annual compliance calendar.',
  keywords: 'start motor carrier Texas, Texas trucking authority, USDOT registration Texas, FMCSA operating authority, Texas IFTA registration, IRP apportioned plates Texas, motor carrier compliance checklist, Texas freight business, box truck motor carrier requirements, non CDL box truck DOT, box truck under 26000 lbs requirements, how long does operating authority take',
  alternates: { canonical: `${COMPANY.siteUrl}/start-your-carrier` },
  openGraph: {
    title: 'How to Start a Motor Carrier Business in Texas',
    description: 'Step-by-step guide: USDOT, operating authority, insurance, IFTA, IRP, ELD, drug testing, and a full compliance calendar.',
    url: `${COMPANY.siteUrl}/start-your-carrier`,
    images: [{ url: '/og-image.jpg', width: 1200, height: 630, alt: `${COMPANY.legalName} — Start Your Motor Carrier` }],
  },
  twitter: {
    card: 'summary_large_image',
    images: ['/og-image.jpg'],
  },
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
