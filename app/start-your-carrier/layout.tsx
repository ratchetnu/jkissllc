import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'How to Start a Motor Carrier Business in Texas | J Kiss LLC',
  description: 'Complete guide to starting a motor carrier business in Texas — USDOT registration, operating authority, insurance requirements, IFTA, IRP, ELD rules, drug testing, and a monthly/quarterly/annual compliance calendar.',
  keywords: 'start motor carrier Texas, Texas trucking authority, USDOT registration Texas, FMCSA operating authority, Texas IFTA registration, IRP apportioned plates Texas, motor carrier compliance checklist, Texas freight business, box truck motor carrier requirements, non CDL box truck DOT, box truck under 26000 lbs requirements, how long does operating authority take',
  alternates: { canonical: 'https://www.jkissllc.com/start-your-carrier' },
  openGraph: {
    title: 'How to Start a Motor Carrier Business in Texas',
    description: 'Step-by-step guide: USDOT, operating authority, insurance, IFTA, IRP, ELD, drug testing, and a full compliance calendar.',
    url: 'https://www.jkissllc.com/start-your-carrier',
  },
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
