'use client'

import { COMPANY, CREDENTIALS_SLASH, ADDRESS_ONE_LINE } from '../lib/company'
import type { PayStatement } from '../lib/pay-statements'

// Shared, print-ready pay-statement document. Rendered as a white "paper" card
// (even in the dark app) so it reads like a document and prints cleanly — the
// browser's Print dialog is the "Download PDF" path (no PDF dependency). Used by
// both the admin and crew-portal statement views.

const money = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const day = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

export default function PayStatementDoc({ s }: { s: PayStatement }) {
  return (
    <div className="pay-doc" style={{
      background: '#fff', color: '#111', borderRadius: 14, padding: '30px 32px',
      maxWidth: 720, margin: '0 auto', fontFamily: '-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
      boxShadow: '0 1px 3px rgba(0,0,0,.2)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, borderBottom: '2px solid #111', paddingBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>{COMPANY.legalName}</h1>
          <p style={{ fontSize: 12, color: '#555', margin: '4px 0 0', lineHeight: 1.5 }}>
            {ADDRESS_ONE_LINE}<br />{COMPANY.phoneDisplay} · {COMPANY.email}<br />{CREDENTIALS_SLASH}
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <p style={{ fontSize: 13, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: '#888', margin: 0 }}>Pay Statement</p>
          <p style={{ fontSize: 16, fontWeight: 700, margin: '4px 0 0' }}>{s.statementNumber}</p>
          {s.status === 'void' && <p style={{ fontSize: 12, fontWeight: 800, color: '#c00', margin: '4px 0 0' }}>VOID</p>}
        </div>
      </div>

      {/* Bill-to / period */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, margin: '18px 0 20px' }}>
        <div>
          <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: '#999', margin: 0 }}>Contractor</p>
          <p style={{ fontSize: 15, fontWeight: 600, margin: '3px 0 0' }}>{s.staffName}</p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: '#999', margin: 0 }}>Pay period</p>
          <p style={{ fontSize: 14, margin: '3px 0 0' }}>{day(s.periodStart)} – {day(s.periodEnd)}</p>
          <p style={{ fontSize: 12, color: '#777', margin: '2px 0 0' }}>Issued {day(new Date(s.issuedAt).toISOString().slice(0, 10))}</p>
        </div>
      </div>

      {/* Line items */}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em' }}>
            <th style={{ padding: '0 0 8px', fontWeight: 700 }}>Date</th>
            <th style={{ padding: '0 0 8px', fontWeight: 700 }}>Route</th>
            <th style={{ padding: '0 0 8px', fontWeight: 700, textAlign: 'right' }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {s.lines.map((l, i) => (
            <tr key={`${l.routeNumber}-${i}`}>
              <td style={{ padding: '8px 0', borderTop: '1px solid #eee', color: '#333' }}>{day(l.routeDate)}</td>
              <td style={{ padding: '8px 0', borderTop: '1px solid #eee', color: '#333' }}>{l.businessName} · {l.routeNumber}</td>
              <td style={{ padding: '8px 0', borderTop: '1px solid #eee', color: '#333', textAlign: 'right' }} className="tabular-nums">{money(l.amountCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Totals */}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5, marginTop: 4, borderTop: '2px solid #111' }}>
        <tbody>
          <tr>
            <td style={{ padding: '10px 0 4px', color: '#333' }}>Gross ({s.routeCount} route{s.routeCount === 1 ? '' : 's'})</td>
            <td style={{ padding: '10px 0 4px', color: '#333', textAlign: 'right' }} className="tabular-nums">{money(s.grossCents)}</td>
          </tr>
          {s.deductions.map((d, i) => (
            <tr key={i}>
              <td style={{ padding: '4px 0', color: '#a00' }}>{d.label}</td>
              <td style={{ padding: '4px 0', color: '#a00', textAlign: 'right' }} className="tabular-nums">-{money(Math.abs(d.amountCents))}</td>
            </tr>
          ))}
          <tr>
            <td style={{ padding: '10px 0', fontWeight: 800, fontSize: 16, borderTop: '1px solid #eee' }}>Net pay</td>
            <td style={{ padding: '10px 0', fontWeight: 800, fontSize: 16, borderTop: '1px solid #eee', textAlign: 'right' }} className="tabular-nums">{money(s.netCents)}</td>
          </tr>
        </tbody>
      </table>

      <p style={{ fontSize: 11, color: '#999', marginTop: 22, lineHeight: 1.5 }}>
        Independent contractor pay statement. This reflects earnings from completed routes and any claim-recovery deductions for the period. Not a tax document. Questions? Use the Pay Correction request in your crew portal.
      </p>

      <style>{`@media print {
        body { background: #fff !important; }
        .jkos, .no-print { }
        .no-print { display: none !important; }
        .pay-doc { box-shadow: none !important; border-radius: 0 !important; max-width: 100% !important; padding: 0 !important; }
        nav, [data-dock], [data-fab] { display: none !important; }
      }`}</style>
    </div>
  )
}
