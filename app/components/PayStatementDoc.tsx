'use client'

import { QRCodeSVG } from 'qrcode.react'
import { COMPANY, CREDENTIALS_SLASH, ADDRESS_ONE_LINE } from '../lib/company'
import type { PayStatement } from '../lib/pay-statements'
import { groupEarnings, summaryRows, DEFAULT_CLASSIFICATION, type PayStatementMeta } from '../lib/pay-statement-view'

// ── Premium Contractor Pay Statement ─────────────────────────────────────────
// A restrained, executive document (Apple-doc feel, not payroll software). Rendered on a
// white "paper" canvas even in the dark app so it reads + prints like a real document; the
// browser Print dialog is the "Download PDF" path (no PDF dependency). It REUSES the existing
// PayStatement snapshot verbatim — no payroll recompute. Optional `meta` fields render only
// when supplied. Used by the admin + crew-portal statement views.

const money = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const day = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}
const ACCENT = '#0A84FF'   // subtle single brand accent (calm, executive)
const INK = '#1c1c1e', SUBTLE = '#6e6e73', HAIR = '#e6e6e9', PAPER = '#fff'

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase', color: SUBTLE, margin: 0 }}>{label}</p>
      <p style={{ fontSize: 13, color: INK, margin: '3px 0 0', fontWeight: 500 }}>{value}</p>
    </div>
  )
}

export default function PayStatementDoc({ s, meta = {}, variant = 'standard', verifyUrl }: { s: PayStatement; meta?: PayStatementMeta; variant?: 'standard' | 'verification'; verifyUrl?: string }) {
  const groups = groupEarnings(s.lines)
  const rows = summaryRows(s, meta)
  const classification = meta.classification ?? DEFAULT_CLASSIFICATION
  const version = meta.version ?? 1
  const statusLabel = s.status === 'void' ? 'Void' : 'Issued'
  const num = (c: number, neg?: boolean) => <span className="tabular-nums" style={{ fontVariantNumeric: 'tabular-nums' }}>{neg ? '–' : ''}{money(Math.abs(c))}</span>
  const isVerify = variant === 'verification'
  const verifyLink = verifyUrl ?? `${COMPANY.siteUrl}/verify/${encodeURIComponent(s.id)}`   // opaque ps_ id, not enumerable

  return (
    <div className="pay-doc" style={{
      background: PAPER, color: INK, borderRadius: 16, padding: '40px 44px', maxWidth: 760, margin: '0 auto',
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      boxShadow: '0 1px 4px rgba(0,0,0,.14)', lineHeight: 1.5, WebkitFontSmoothing: 'antialiased',
    }}>
      {/* ── Header ── */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 28, flexWrap: 'wrap' }}>
        <div>
          <p style={{ fontSize: 21, fontWeight: 700, letterSpacing: '-.01em', margin: 0 }}>{COMPANY.legalName}</p>
          <p style={{ fontSize: 11.5, color: SUBTLE, margin: '6px 0 0', lineHeight: 1.6 }}>
            {ADDRESS_ONE_LINE}<br />
            {COMPANY.phoneDisplay} · {COMPANY.email} · {COMPANY.domain}<br />
            {CREDENTIALS_SLASH}
          </p>
        </div>
        <div style={{ minWidth: 210, border: `1px solid ${HAIR}`, borderRadius: 12, padding: '14px 16px' }}>
          <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.09em', textTransform: 'uppercase', color: ACCENT, margin: 0 }}>Contractor Pay Statement{isVerify ? ' · Verification Copy' : ''}</p>
          <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
            <Meta label="Statement" value={<span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{s.statementNumber}</span>} />
            <Meta label="Pay period" value={`${day(s.periodStart)} – ${day(s.periodEnd)}`} />
            <Meta label="Payment date" value={meta.paymentDate ? day(meta.paymentDate) : '—'} />
            <div style={{ display: 'flex', gap: 20 }}>
              <Meta label="Status" value={<span style={{ color: s.status === 'void' ? '#c00' : ACCENT, fontWeight: 600 }}>{statusLabel}</span>} />
              <Meta label="Version" value={`v${version}`} />
            </div>
          </div>
        </div>
      </header>

      <div style={{ height: 1, background: INK, margin: '22px 0 26px' }} />

      {/* ── Contractor profile ── */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 18 }}>
        <Meta label="Contractor" value={<span style={{ fontSize: 15, fontWeight: 600 }}>{s.staffName}</span>} />
        {meta.contractorId && <Meta label="Contractor ID" value={meta.contractorId} />}
        {meta.role && <Meta label="Role" value={meta.role} />}
        <Meta label="Classification" value={classification} />
        {(meta.businessName || COMPANY.legalName) && <Meta label="Business" value={meta.businessName ?? COMPANY.legalName} />}
        {meta.paymentMethodLabel && <Meta label="Payment method" value={meta.paymentMethodLabel} />}
      </section>

      {/* ── Verification panel (verification copy only) — income verification + QR ── */}
      {isVerify && (
        <section aria-label="Verification" style={{ marginTop: 24, border: `1px solid ${HAIR}`, borderRadius: 14, padding: 18, display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap', background: '#fbfbfd' }}>
          <div style={{ background: '#fff', padding: 8, borderRadius: 10, border: `1px solid ${HAIR}`, lineHeight: 0 }}>
            <QRCodeSVG value={verifyLink} size={96} level="M" bgColor="#ffffff" fgColor={INK} aria-label="Scan to verify this statement" />
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: ACCENT, margin: 0 }}>Income Verification Copy</p>
            <p style={{ fontSize: 12.5, color: INK, margin: '6px 0 0', lineHeight: 1.55 }}>
              This is a verification copy of a genuine contractor pay statement issued by {COMPANY.legalName}. A lender, landlord, or verifier may confirm its authenticity by scanning the code or visiting the link below.
            </p>
            <p style={{ fontSize: 11.5, margin: '8px 0 0', color: SUBTLE, wordBreak: 'break-all' }}>
              <span style={{ fontWeight: 600, color: INK }}>Verify:</span> {verifyLink}
            </p>
          </div>
        </section>
      )}

      {/* ── Pay summary — Net Payment dominant ── */}
      <section aria-label="Pay summary" style={{ marginTop: 28, border: `1px solid ${HAIR}`, borderRadius: 14, overflow: 'hidden' }}>
        {rows.filter(r => !r.emphasis).map(r => (
          <div key={r.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '12px 20px', borderBottom: `1px solid ${HAIR}` }}>
            <span style={{ fontSize: 13.5, color: r.negative ? '#b3261e' : INK }}>{r.label}</span>
            <span style={{ fontSize: 14.5, fontWeight: 500, color: r.negative ? '#b3261e' : INK }}>{num(r.cents, r.negative)}</span>
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '18px 20px', background: '#fafafb' }}>
          <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '.02em', textTransform: 'uppercase', color: SUBTLE }}>Net payment</span>
          <span style={{ fontSize: 32, fontWeight: 700, letterSpacing: '-.02em', color: INK }}>{money(s.netCents)}</span>
        </div>
      </section>

      {/* ── Earnings (grouped by business) ── */}
      <section style={{ marginTop: 32 }} aria-label="Earnings detail">
        <h2 style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: SUBTLE, margin: '0 0 4px' }}>Earnings</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ color: SUBTLE, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em' }}>
              <th style={{ textAlign: 'left', fontWeight: 600, padding: '8px 0' }}>Date</th>
              <th style={{ textAlign: 'left', fontWeight: 600, padding: '8px 0' }}>Work item</th>
              <th style={{ textAlign: 'left', fontWeight: 600, padding: '8px 0' }}>Reference</th>
              <th style={{ textAlign: 'right', fontWeight: 600, padding: '8px 0' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {groups.flatMap(g => [
              <tr key={`h-${g.businessName}`} className="pay-group">
                <td colSpan={4} style={{ padding: '14px 0 4px', fontSize: 11.5, fontWeight: 600, color: ACCENT }}>{g.businessName}</td>
              </tr>,
              ...g.lines.map((l, i) => (
                <tr key={`${g.businessName}-${l.routeNumber}-${i}`}>
                  <td style={{ padding: '9px 0', borderTop: `1px solid ${HAIR}`, color: INK, whiteSpace: 'nowrap' }}>{day(l.routeDate)}</td>
                  <td style={{ padding: '9px 0', borderTop: `1px solid ${HAIR}`, color: INK }}>Route</td>
                  <td style={{ padding: '9px 0', borderTop: `1px solid ${HAIR}`, color: SUBTLE, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}>{l.routeNumber}</td>
                  <td style={{ padding: '9px 0', borderTop: `1px solid ${HAIR}`, color: INK, textAlign: 'right' }} className="tabular-nums">{money(l.amountCents)}</td>
                </tr>
              )),
              <tr key={`sub-${g.businessName}`}>
                <td colSpan={3} style={{ padding: '9px 0 4px', borderTop: `1px solid ${HAIR}`, color: SUBTLE, fontSize: 12 }}>{g.lines.length} route{g.lines.length === 1 ? '' : 's'}</td>
                <td style={{ padding: '9px 0 4px', borderTop: `1px solid ${HAIR}`, color: INK, textAlign: 'right', fontWeight: 600 }} className="tabular-nums">{money(g.subtotalCents)}</td>
              </tr>,
            ])}
          </tbody>
        </table>
      </section>

      {/* ── Deductions & offsets ── */}
      {s.deductions.length > 0 && (
        <section style={{ marginTop: 28 }} aria-label="Deductions and offsets">
          <h2 style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: SUBTLE, margin: '0 0 4px' }}>Deductions & offsets</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <tbody>
              {s.deductions.map((d, i) => (
                <tr key={i}>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${HAIR}`, color: INK }}>{d.label}</td>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${HAIR}`, color: '#b3261e', textAlign: 'right' }} className="tabular-nums">–{money(Math.abs(d.amountCents))}</td>
                </tr>
              ))}
              <tr>
                <td style={{ padding: '10px 0 0', color: SUBTLE, fontSize: 12 }}>Total deductions</td>
                <td style={{ padding: '10px 0 0', color: '#b3261e', textAlign: 'right', fontWeight: 600 }} className="tabular-nums">–{money(s.deductionCents)}</td>
              </tr>
            </tbody>
          </table>
        </section>
      )}

      {/* ── Year to date (only when the caller supplies it) ── */}
      {meta.ytd && Object.values(meta.ytd).some(v => v != null) && (
        <section style={{ marginTop: 28 }} aria-label="Year to date">
          <h2 style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: SUBTLE, margin: '0 0 8px' }}>Year to date</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 14 }}>
            {meta.ytd.grossCents != null && <Meta label="Gross" value={money(meta.ytd.grossCents)} />}
            {meta.ytd.deductionCents != null && <Meta label="Deductions" value={money(meta.ytd.deductionCents)} />}
            {meta.ytd.netCents != null && <Meta label="Net" value={money(meta.ytd.netCents)} />}
            {meta.ytd.paymentsCents != null && <Meta label="Payments" value={money(meta.ytd.paymentsCents)} />}
          </div>
        </section>
      )}

      {/* ── Footer ── */}
      <footer style={{ marginTop: 34, paddingTop: 16, borderTop: `1px solid ${HAIR}` }}>
        <p style={{ fontSize: 10.5, color: SUBTLE, margin: 0, lineHeight: 1.6 }}>
          This statement summarizes contractor compensation recorded by {COMPANY.legalName} for the period shown. It is not a tax return or a substitute for Form 1099. Questions? Use the Pay Correction request in your crew portal or contact <span style={{ color: INK }}>{COMPANY.email}</span>.
        </p>
        <p style={{ fontSize: 10, color: SUBTLE, margin: '10px 0 0', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <span>Generated by Operion</span>
          <span>·</span>
          <span>Statement {s.statementNumber}</span>
          <span>·</span>
          <span>Version {version}</span>
          <span>·</span>
          <span>{new Date(s.issuedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</span>
        </p>
      </footer>

      <style>{`
        .pay-doc { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
        .pay-doc table { page-break-inside: auto; }
        .pay-doc tr { page-break-inside: avoid; }
        .pay-doc thead { display: table-header-group; }  /* repeat column headers on new pages */
        .pay-doc tr.pay-group { page-break-after: avoid; } /* keep a group header with its first row */
        .pay-doc section, .pay-doc footer, .pay-doc header { break-inside: avoid; }
        @media print {
          @page { size: Letter; margin: 0.6in; }
          html, body { background: #fff !important; }
          .no-print { display: none !important; }
          nav, [data-dock], [data-fab], [data-dock="mobile-more"], [data-dock="mobile-more-overlay"] { display: none !important; }
          .pay-doc { box-shadow: none !important; border-radius: 0 !important; max-width: 100% !important; padding: 0 !important; }
        }
        @media (max-width: 560px) { .pay-doc { padding: 22px 18px !important; } }
      `}</style>
    </div>
  )
}
