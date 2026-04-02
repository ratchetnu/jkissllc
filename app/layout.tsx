import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'J Kiss LLC — Freight & Last-Mile Delivery | DFW',
  description: 'J Kiss LLC is a licensed freight and last-mile delivery company serving the Dallas–Fort Worth metroplex. Trusted by Lowe\'s, Rooms To Go, Living Spaces, RH, Nebraska Furniture Mart, and XPO Logistics.',
  keywords: 'freight delivery DFW, last-mile delivery Dallas, freight contractor Texas, logistics Dallas Fort Worth',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
