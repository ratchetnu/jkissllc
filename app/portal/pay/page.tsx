'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { FileText, MessageSquareWarning, Check } from 'lucide-react'
import PortalShell from '../PortalShell'
import { money, fmtDay } from '../ui'

type CompLine = { routeNumber: string; businessName: string; date: string; payCents: number }
type Summary = {
  lifetimeEarningsCents: number; ytdEarningsCents: number; periodEarningsCents: number
  completedRoutes: number; upcomingRoutes: number; businesses: string[]; recent: CompLine[]
}
type Statement = { id: string; statementNumber: string; periodStart: string; periodEnd: string; netCents: number; routeCount: number; issuedAt: number }
type Correction = { id: string; message: string; status: 'pending' | 'approved' | 'denied'; statementNumber?: string; createdAt: number; decisionNote?: string }

function Tile({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div className="os-card" style={{ padding: '16px 18px', flex: 1, minWidth: big ? 200 : 140 }}>
      <p style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>{label}</p>
      <p className="jkos-h" style={{ fontSize: big ? 30 : 22, marginTop: 6 }}>{value}</p>
    </div>
  )
}

function MyPay() {
  const [visible, setVisible] = useState<boolean | null>(null)
  const [s, setS] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [statements, setStatements] = useState<Statement[]>([])
  const [corrections, setCorrections] = useState<Correction[]>([])

  // Correction request form
  const [showCorrection, setShowCorrection] = useState(false)
  const [corrMsg, setCorrMsg] = useState('')
  const [corrBusy, setCorrBusy] = useState(false)
  const [corrDone, setCorrDone] = useState(false)
  const [corrErr, setCorrErr] = useState('')

  const loadExtras = useCallback(async () => {
    const [st, co] = await Promise.all([
      fetch('/api/portal/pay-statements', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({})),
      fetch('/api/portal/pay-correction', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({})),
    ])
    setStatements(st.statements ?? [])
    setCorrections(co.corrections ?? [])
  }, [])

  useEffect(() => {
    fetch('/api/portal/pay', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(d => { setVisible(!!d.visible); setS(d.summary ?? null) })
      .catch(() => setVisible(false))
      .finally(() => setLoading(false))
    loadExtras()
  }, [loadExtras])

  async function submitCorrection(e: React.FormEvent) {
    e.preventDefault()
    setCorrErr('')
    if (!corrMsg.trim()) { setCorrErr('Please describe what looks wrong.'); return }
    setCorrBusy(true)
    try {
      const res = await fetch('/api/portal/pay-correction', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ message: corrMsg }),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) { setCorrErr(d.error ?? 'Could not submit.'); return }
      setCorrMsg(''); setShowCorrection(false); setCorrDone(true); setTimeout(() => setCorrDone(false), 2500)
      await loadExtras()
    } catch { setCorrErr('Connection error — try again.') } finally { setCorrBusy(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h1 className="jkos-h" style={{ fontSize: 24 }}>My Pay</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 3 }}>Earnings from your completed routes.</p>
      </div>

      {loading && <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading…</p>}

      {!loading && !visible && (
        <div className="os-card" style={{ padding: 20 }}>
          <p style={{ color: 'var(--muted)', fontSize: 14 }}>Pay details are managed by your administrator and aren&apos;t shown here. Reach out to your manager with any pay questions.</p>
        </div>
      )}

      {!loading && visible && s && (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Tile label="This week" value={money(s.periodEarningsCents)} big />
            <Tile label="Year to date" value={money(s.ytdEarningsCents)} />
            <Tile label="Lifetime" value={money(s.lifetimeEarningsCents)} />
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Tile label="Completed routes" value={String(s.completedRoutes)} />
            <Tile label="Upcoming" value={String(s.upcomingRoutes)} />
          </div>

          <div className="os-card os-rise" style={{ padding: 20 }}>
            <h2 className="jkos-h" style={{ fontSize: 17, marginBottom: 4 }}>Recent earnings</h2>
            <p style={{ color: 'var(--muted)', fontSize: 12.5, marginBottom: 12 }}>What you earned on completed work. This reflects earnings, not payments made.</p>
            {s.recent.length ? (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {s.recent.map((l, i) => (
                  <div key={`${l.routeNumber}-${i}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 0', borderTop: i ? '1px solid var(--line)' : 'none' }}>
                    <div>
                      <p style={{ fontWeight: 600, fontSize: 14 }}>{l.businessName}</p>
                      <p style={{ color: 'var(--muted)', fontSize: 12.5 }}>{fmtDay(l.date)} · {l.routeNumber}</p>
                    </div>
                    <span style={{ fontWeight: 700, fontSize: 15 }}>{money(l.payCents)}</span>
                  </div>
                ))}
              </div>
            ) : <p style={{ color: 'var(--muted)', fontSize: 14 }}>No completed routes yet.</p>}
          </div>

          {s.businesses.length > 0 && (
            <div className="os-card" style={{ padding: 18 }}>
              <p style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }}>Clients you&apos;ve worked</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                {s.businesses.map(b => <span key={b} style={{ fontSize: 12.5, padding: '5px 11px', borderRadius: 999, background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)' }}>{b}</span>)}
              </div>
            </div>
          )}
        </>
      )}

      {/* Pay statements — available regardless of whether dollar figures are shown */}
      {!loading && (
        <div className="os-card os-rise" style={{ padding: 20 }}>
          <h2 className="jkos-h" style={{ fontSize: 17, marginBottom: 4 }}>Pay statements</h2>
          <p style={{ color: 'var(--muted)', fontSize: 12.5, marginBottom: statements.length ? 12 : 0 }}>Statements your admin has issued. Open one to print or save a PDF.</p>
          {statements.map(st => (
            <Link key={st.id} href={`/portal/pay/statement/${st.id}`} className="os-tap" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0', borderTop: '1px solid var(--line)', textDecoration: 'none', color: 'inherit' }}>
              <FileText size={17} style={{ color: 'var(--muted)', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontWeight: 600, fontSize: 14 }}>{st.statementNumber}</p>
                <p style={{ color: 'var(--muted)', fontSize: 12.5 }}>{fmtDay(st.periodStart)} – {fmtDay(st.periodEnd)} · {st.routeCount} route{st.routeCount === 1 ? '' : 's'}</p>
              </div>
              <span style={{ fontWeight: 700, fontSize: 15 }}>{money(st.netCents)}</span>
            </Link>
          ))}
          {statements.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 8 }}>No statements yet.</p>}
        </div>
      )}

      {/* Pay correction request */}
      {!loading && (
        <div className="os-card" style={{ padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <div>
              <h2 className="jkos-h" style={{ fontSize: 16 }}>Something look wrong?</h2>
              <p style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 2 }}>Request a pay correction — your manager will review it.</p>
            </div>
            {!showCorrection && <button onClick={() => setShowCorrection(true)} className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 14px', borderRadius: 11, background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', color: 'var(--text)', fontWeight: 700, fontSize: 13, cursor: 'pointer', flexShrink: 0 }}>{corrDone ? <><Check size={15} /> Sent</> : <><MessageSquareWarning size={15} /> Request</>}</button>}
          </div>
          {showCorrection && (
            <form onSubmit={submitCorrection} style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <textarea value={corrMsg} onChange={e => setCorrMsg(e.target.value)} rows={3} placeholder="Describe what looks wrong (route, date, amount)…" style={{ width: '100%', padding: '11px 13px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 11, color: 'var(--text)', fontSize: 14, outline: 'none', resize: 'vertical' }} />
              {corrErr && <p style={{ color: '#f87171', fontSize: 13.5 }}>{corrErr}</p>}
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="submit" disabled={corrBusy} className="btn os-tap" style={{ borderRadius: 11, height: 42, padding: '0 18px', justifyContent: 'center' }}>{corrBusy ? 'Sending…' : 'Send request'}</button>
                <button type="button" onClick={() => { setShowCorrection(false); setCorrErr('') }} className="os-tap" style={{ padding: '0 16px', borderRadius: 11, background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', color: 'var(--muted)', fontWeight: 700, fontSize: 13.5, cursor: 'pointer' }}>Cancel</button>
              </div>
            </form>
          )}
          {corrections.length > 0 && (
            <div style={{ marginTop: 14 }}>
              {corrections.map(c => (
                <div key={c.id} style={{ padding: '10px 0', borderTop: '1px solid var(--line)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 800, padding: '2px 8px', borderRadius: 999,
                      color: c.status === 'pending' ? '#fcd34d' : c.status === 'approved' ? '#86efac' : '#fca5a5',
                      background: c.status === 'pending' ? 'rgba(252,211,77,.14)' : c.status === 'approved' ? 'rgba(134,239,172,.14)' : 'rgba(248,113,113,.14)' }}>{c.status}</span>
                    <span style={{ color: 'var(--muted)', fontSize: 12 }}>{fmtDay(new Date(c.createdAt).toISOString().slice(0, 10))}</span>
                  </div>
                  <p style={{ fontSize: 13.5, marginTop: 5 }}>{c.message}</p>
                  {c.decisionNote && <p style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 3, fontStyle: 'italic' }}>Manager: {c.decisionNote}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function MyPayPage() {
  return <PortalShell><MyPay /></PortalShell>
}
