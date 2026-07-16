'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Printer } from 'lucide-react'
import OperationsShell from '../../OperationsShell'
import PayStatementDoc from '../../../../components/PayStatementDoc'
import type { PayStatement } from '../../../../lib/pay-statements'
import type { PayStatementMeta } from '../../../../lib/pay-statement-view'

// ── SAMPLE preview — fixture data only, NO real pay records ───────────────────
// Lets the owner eyeball the premium Contractor Pay Statement design (screen + Print/PDF)
// across scenarios without touching payroll. Everything here is obviously-fake fixture data;
// nothing is read from or written to the pay engine. The "SAMPLE" banner is no-print so the
// PDF stays a clean design proof.

const ISSUED = 1_760_000_000_000   // fixed timestamp → deterministic sample

function stmt(p: Partial<PayStatement>): PayStatement {
  const lines = p.lines ?? []
  const gross = p.grossCents ?? lines.reduce((n, l) => n + l.amountCents, 0)
  const deductions = p.deductions ?? []
  const ded = p.deductionCents ?? deductions.reduce((n, d) => n + Math.abs(d.amountCents), 0)
  return {
    id: 'SAMPLE', statementNumber: 'JK-PS-1042', staffId: 'sample', staffName: 'Jordan Rivera',
    periodStart: '2026-07-06', periodEnd: '2026-07-12', grossCents: gross, deductionCents: ded, netCents: gross - ded,
    routeCount: lines.length, lines, deductions, status: 'issued', issuedBy: 'owner', issuedAt: ISSUED, updatedAt: ISSUED, ...p,
  }
}

type Scenario = { key: string; label: string; s: PayStatement; meta?: PayStatementMeta }

const SCENARIOS: Scenario[] = [
  {
    key: 'standard', label: 'Standard',
    s: stmt({ lines: [
      { routeNumber: 'R-4821', routeDate: '2026-07-06', businessName: 'Riverside Logistics', amountCents: 14000 },
      { routeNumber: 'R-4830', routeDate: '2026-07-08', businessName: 'Riverside Logistics', amountCents: 14000 },
      { routeNumber: 'R-4844', routeDate: '2026-07-10', businessName: 'Riverside Logistics', amountCents: 16500 },
    ] }),
    meta: { contractorId: 'C-1042', role: 'Driver', paymentMethodLabel: 'Zelle', paymentDate: '2026-07-15' },
  },
  {
    key: 'deductions', label: 'Multi-business + deductions',
    s: stmt({
      lines: [
        { routeNumber: 'R-4821', routeDate: '2026-07-06', businessName: 'Riverside Logistics', amountCents: 14000 },
        { routeNumber: 'R-4830', routeDate: '2026-07-07', businessName: 'Riverside Logistics', amountCents: 14000 },
        { routeNumber: 'M-2210', routeDate: '2026-07-09', businessName: 'Cedar Grove Moving', amountCents: 21000 },
        { routeNumber: 'M-2231', routeDate: '2026-07-11', businessName: 'Cedar Grove Moving', amountCents: 18500 },
      ],
      deductions: [
        { label: 'Damage claim CLM-3391 (crew share)', amountCents: 7500 },
        { label: 'Equipment charge — dolly replacement', amountCents: 4200 },
      ],
    }),
    meta: { contractorId: 'C-1042', role: 'Driver / Lead', paymentMethodLabel: 'Direct deposit', paymentDate: '2026-07-15' },
  },
  {
    key: 'full', label: 'Bonuses + reimbursements + YTD',
    // Net = gross 30500 + bonus 5000 + reimb 3200 + adj −1500 − deductions 5000 = 32200 (consistent).
    s: stmt({
      lines: [
        { routeNumber: 'R-4821', routeDate: '2026-07-06', businessName: 'Riverside Logistics', amountCents: 14000 },
        { routeNumber: 'R-4830', routeDate: '2026-07-08', businessName: 'Riverside Logistics', amountCents: 16500 },
      ],
      deductions: [{ label: 'Advance repayment (2 of 4)', amountCents: 5000 }],
      netCents: 32200,
    }),
    meta: {
      contractorId: 'C-1042', role: 'Driver', paymentMethodLabel: 'Zelle', paymentDate: '2026-07-15',
      bonusCents: 5000, reimbursementCents: 3200, adjustmentCents: -1500,
      ytd: { grossCents: 862500, deductionCents: 41000, netCents: 821500, paymentsCents: 806500 },
    },
  },
  {
    key: 'volume', label: 'High volume + large numbers',
    s: stmt({
      statementNumber: 'JK-PS-1043',
      lines: Array.from({ length: 14 }, (_, i) => ({
        routeNumber: `R-5${String(100 + i)}`, routeDate: `2026-07-${String(1 + (i % 12)).padStart(2, '0')}`,
        businessName: i % 2 === 0 ? 'Riverside Logistics & Freight Distribution' : 'Cedar Grove Moving',
        amountCents: 12000 + (i % 5) * 3500,
      })),
      deductions: [{ label: 'Uniform + fuel card reconciliation for the pay period', amountCents: 9800 }],
    }),
    meta: { contractorId: 'C-1042', role: 'Senior Driver', paymentMethodLabel: 'Direct deposit', paymentDate: '2026-07-15', version: 2 },
  },
  {
    key: 'minimal', label: 'Single route · no deductions',
    s: stmt({ statementNumber: 'JK-PS-1044', lines: [{ routeNumber: 'R-4821', routeDate: '2026-07-06', businessName: 'Riverside Logistics', amountCents: 15000 }] }),
    meta: { contractorId: 'C-1051', role: 'Helper', paymentMethodLabel: 'Zelle', paymentDate: '2026-07-15' },
  },
]

function Sample() {
  const [active, setActive] = useState('standard')
  const scenario = SCENARIOS.find(s => s.key === active) ?? SCENARIOS[0]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="no-print" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <Link href="/admin/operations/pay-statements" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 13, textDecoration: 'none' }}><ArrowLeft size={14} /> Pay Statements</Link>
        <button onClick={() => window.print()} className="btn os-tap" style={{ borderRadius: 12, height: 42, gap: 7 }}><Printer size={16} /> Print / Save PDF</button>
      </div>

      <div className="no-print os-card" style={{ padding: 14, border: '1px solid rgba(251,191,36,.4)', background: 'rgba(251,191,36,.06)' }}>
        <p style={{ fontSize: 13, fontWeight: 700, color: '#fbbf24', margin: 0 }}>Sample preview — fixture data, not a real pay statement.</p>
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 0' }}>Design proof only. No pay records are read or written. The banner is hidden in Print/PDF so the document stays clean.</p>
      </div>

      <div className="no-print" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} role="tablist" aria-label="Sample scenarios">
        {SCENARIOS.map(sc => (
          <button key={sc.key} role="tab" aria-selected={sc.key === active} onClick={() => setActive(sc.key)} className="os-tap"
            style={{ padding: '8px 13px', borderRadius: 999, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: '1px solid var(--line)', color: sc.key === active ? '#fff' : 'var(--text)', background: sc.key === active ? 'var(--red)' : 'transparent' }}>
            {sc.label}
          </button>
        ))}
      </div>

      <PayStatementDoc s={scenario.s} meta={scenario.meta} />
    </div>
  )
}

export default function SamplePayStatementPage() {
  return <OperationsShell><Sample /></OperationsShell>
}
