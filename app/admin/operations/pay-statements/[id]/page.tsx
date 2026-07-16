'use client'

import { use, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Printer } from 'lucide-react'
import OperationsShell from '../../OperationsShell'
import PayStatementDoc from '../../../../components/PayStatementDoc'
import type { PayStatement } from '../../../../lib/pay-statements'

function StatementView({ id }: { id: string }) {
  const [statement, setStatement] = useState<PayStatement | null>(null)
  const [loading, setLoading] = useState(true)
  const [variant, setVariant] = useState<'standard' | 'verification'>('standard')

  useEffect(() => {
    fetch(`/api/admin/pay-statements/${id}`, { credentials: 'same-origin' })
      .then(r => r.json())
      .then(d => setStatement(d.statement ?? null))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [id])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="no-print" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <Link href="/admin/operations/pay-statements" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 13, textDecoration: 'none' }}><ArrowLeft size={14} /> Pay Statements</Link>
        {statement && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {(['standard', 'verification'] as const).map(v => (
              <button key={v} onClick={() => setVariant(v)} aria-pressed={variant === v} className="os-tap"
                style={{ padding: '7px 12px', borderRadius: 999, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: '1px solid var(--line)', color: variant === v ? '#fff' : 'var(--text)', background: variant === v ? 'var(--red)' : 'transparent' }}>
                {v === 'standard' ? 'Standard' : 'Verification copy'}
              </button>
            ))}
            <button onClick={() => window.print()} className="btn os-tap" style={{ borderRadius: 12, height: 42, gap: 7 }}><Printer size={16} /> Print / Save PDF</button>
          </div>
        )}
      </div>
      {loading && <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading…</p>}
      {!loading && !statement && <div className="os-card" style={{ padding: 18 }}><p style={{ color: 'var(--muted)', fontSize: 14 }}>Statement not found.</p></div>}
      {statement && <PayStatementDoc s={statement} variant={variant} />}
    </div>
  )
}

export default function AdminStatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return <OperationsShell><StatementView id={id} /></OperationsShell>
}
