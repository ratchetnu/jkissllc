'use client'

import { use, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Printer } from 'lucide-react'
import PayStatementDoc from '../../../../components/PayStatementDoc'
import { paymentMethodLabel, type CrewPayStatement, type StatementYtd } from '../../../../lib/pay-statements'

function StatementView({ id }: { id: string }) {
  const [statement, setStatement] = useState<CrewPayStatement | null>(null)
  const [ytd, setYtd] = useState<StatementYtd | undefined>()
  const [businessAddress, setBusinessAddress] = useState<string | undefined>()
  const [contractorAddress, setContractorAddress] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch(`/api/portal/pay-statements/${id}`, { credentials: 'same-origin' })
      .then(async r => ({ r, d: await r.json() }))
      .then(({ r, d }) => {
        if (!r.ok || !d.ok) throw new Error(r.status === 404 ? 'Statement not found.' : d.error ?? 'Statement temporarily unavailable.')
        setStatement(d.statement); setYtd(d.ytd); setBusinessAddress(d.businessAddress); setContractorAddress(d.contractorAddress)
      })
      .catch(error => setError(error instanceof Error ? error.message : 'Statement temporarily unavailable.'))
      .finally(() => setLoading(false))
  }, [id])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="no-print" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <Link href="/portal/pay" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 13, textDecoration: 'none' }}><ArrowLeft size={14} /> My Pay</Link>
        {statement && <button onClick={() => window.print()} className="btn os-tap" style={{ borderRadius: 12, height: 42, gap: 7 }}><Printer size={16} /> Print / Save PDF</button>}
      </div>
      {loading && <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading…</p>}
      {!loading && !statement && <div className="os-card" style={{ padding: 18 }}><p role="alert" style={{ color: 'var(--muted)', fontSize: 14 }}>{error || 'Statement not found.'}</p></div>}
      {statement && <PayStatementDoc s={statement} businessAddress={businessAddress} meta={{
        paymentDate: statement.paymentDate,
        paymentMethodLabel: paymentMethodLabel(statement.paymentMethod),
        contractorAddress,
        ytd,
      }} />}
    </div>
  )
}

export default function PortalStatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return <StatementView id={id} />
}
