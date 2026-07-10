'use client'

import { use, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Printer } from 'lucide-react'
import PortalShell from '../../../PortalShell'
import PayStatementDoc from '../../../../components/PayStatementDoc'
import type { PayStatement } from '../../../../lib/pay-statements'

function StatementView({ id }: { id: string }) {
  const [statement, setStatement] = useState<PayStatement | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`/api/portal/pay-statements/${id}`, { credentials: 'same-origin' })
      .then(r => r.json())
      .then(d => setStatement(d.statement ?? null))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [id])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="no-print" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <Link href="/portal/pay" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 13, textDecoration: 'none' }}><ArrowLeft size={14} /> My Pay</Link>
        {statement && <button onClick={() => window.print()} className="btn os-tap" style={{ borderRadius: 12, height: 42, gap: 7 }}><Printer size={16} /> Print / Save PDF</button>}
      </div>
      {loading && <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading…</p>}
      {!loading && !statement && <div className="os-card" style={{ padding: 18 }}><p style={{ color: 'var(--muted)', fontSize: 14 }}>Statement not found.</p></div>}
      {statement && <PayStatementDoc s={statement} />}
    </div>
  )
}

export default function PortalStatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return <PortalShell><StatementView id={id} /></PortalShell>
}
