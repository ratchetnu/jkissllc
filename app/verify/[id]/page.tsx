'use client'

import { use, useEffect, useState } from 'react'
import type { PublicStatement } from '../../lib/pay-statement-view'

// Public authenticity confirmation for a contractor pay statement (the QR target). Shows only
// non-sensitive facts a verifier can cross-check against the document — never amounts.

const day = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) }

function Verify({ id }: { id: string }) {
  const [state, setState] = useState<{ verified: boolean; statement?: PublicStatement; reason?: string } | null>(null)
  useEffect(() => {
    fetch(`/api/verify/${id}`).then(r => r.json()).then(setState).catch(() => setState({ verified: false, reason: 'Unable to verify right now.' }))
  }, [id])

  const s = state?.statement
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#f5f5f7', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', color: '#1c1c1e' }}>
      <div style={{ width: '100%', maxWidth: 460, background: '#fff', borderRadius: 18, padding: '34px 32px', boxShadow: '0 1px 4px rgba(0,0,0,.1)' }}>
        {!state && <p style={{ color: '#6e6e73', fontSize: 14 }}>Verifying…</p>}
        {state && state.verified && s && (
          <>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: '#1e874b', fontWeight: 700, fontSize: 13, background: 'rgba(30,135,75,.1)', padding: '5px 12px', borderRadius: 999 }}>
              <span aria-hidden style={{ fontSize: 15 }}>✓</span> Verified — genuine statement
            </div>
            <p style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-.01em', margin: '18px 0 2px' }}>{s.business}</p>
            <p style={{ fontSize: 13, color: '#6e6e73', margin: 0 }}>Contractor Pay Statement</p>
            <div style={{ marginTop: 22, borderTop: '1px solid #e6e6e9' }}>
              {[['Statement', s.statementNumber], ['Contractor', s.contractorInitials], ['Pay period', `${day(s.periodStart)} – ${day(s.periodEnd)}`], ['Issued', new Date(s.issuedAt).toLocaleDateString('en-US', { dateStyle: 'medium' })], ['Status', s.status === 'issued' ? 'Issued' : 'Void']].map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '11px 0', borderBottom: '1px solid #f0f0f2', fontSize: 13.5 }}>
                  <span style={{ color: '#6e6e73' }}>{k}</span><span style={{ fontWeight: 600 }}>{v}</span>
                </div>
              ))}
            </div>
            <p style={{ fontSize: 11.5, color: '#6e6e73', marginTop: 18, lineHeight: 1.55 }}>
              This confirms the referenced statement is a genuine record issued by {s.business}. Amounts and details appear on the statement document itself. This page is not a tax form or a substitute for Form 1099.
            </p>
          </>
        )}
        {state && !state.verified && (
          <>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: '#b3261e', fontWeight: 700, fontSize: 13, background: 'rgba(179,38,30,.1)', padding: '5px 12px', borderRadius: 999 }}>
              <span aria-hidden>✕</span> Not verified
            </div>
            <p style={{ fontSize: 14, color: '#1c1c1e', marginTop: 18 }}>{state.reason ?? 'This statement could not be verified. If you received this from a contractor, ask for a current copy.'}</p>
          </>
        )}
      </div>
    </div>
  )
}

export default function VerifyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return <Verify id={id} />
}
