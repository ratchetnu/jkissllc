'use client'

import { useCallback, useEffect, useState } from 'react'
import { BarChart3, MessageSquare, Filter } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { Stat } from '../ui'

// Consolidated analytics surface: communications (reminder ledger) + the quote funnel
// (previously write-only). Read-only. Server gates each feed (comms:analytics /
// reports:view) and scopes to the caller's tenant. No message bodies, phones, emails,
// or tokens are ever returned — only counts, rates, staff names, reminder titles.

type CommsTotals = { sent: number; opened: number; acked: number; completed: number; failed: number; escalations: number; lateResponses: number; readRate: number; ackRate: number; completionRate: number; avgResponseMs: number }
type Crew = { staffId: string; name: string; sent: number; acked: number; completed: number; ackRate: number; avgResponseMs: number }
type Miss = { reminderId: string; title: string; sent: number; acked: number; missRate: number }
type Comms = { windowDays: number; totals: CommsTotals; crewCompliance: Crew[]; mostReliable: Crew[]; mostMissed: Miss[]; activeReminders: number }
type Funnel = { windowDays: number; totals: Record<string, number>; byDay: Array<{ day: string; counts: Record<string, number> }> }

type Load<T> = { state: 'loading' | 'ok' | 'denied' | 'error'; data: T | null }

const th: React.CSSProperties = { textAlign: 'left', padding: '9px 12px', fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap' }
const td: React.CSSProperties = { padding: '10px 12px', fontSize: 13, color: 'var(--text)', borderTop: '1px solid var(--line)', whiteSpace: 'nowrap' }
const field: React.CSSProperties = { padding: '8px 11px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 10, color: 'var(--text)', fontSize: 14, outline: 'none' }
const card: React.CSSProperties = { border: '1px solid var(--line)', borderRadius: 14, padding: 16, marginBottom: 20 }
const humanize = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

function useFeed<T>(url: string, days: number): Load<T> {
  const [load, setLoad] = useState<Load<T>>({ state: 'loading', data: null })
  const run = useCallback(async () => {
    setLoad({ state: 'loading', data: null })
    try {
      const res = await fetch(`${url}?days=${days}`, { credentials: 'same-origin' })
      if (res.status === 401 || res.status === 403) { setLoad({ state: 'denied', data: null }); return }
      if (!res.ok) { setLoad({ state: 'error', data: null }); return }
      setLoad({ state: 'ok', data: await res.json() })
    } catch { setLoad({ state: 'error', data: null }) }
  }, [url, days])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- mount/refetch load; result state is set post-await
  useEffect(() => { run() }, [run])
  return load
}

function Section({ title, icon, load, empty, children }: { title: string; icon: React.ReactNode; load: Load<unknown>; empty: boolean; children: React.ReactNode }) {
  return (
    <section style={card}>
      <h2 style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: 8 }}>{icon} {title}</h2>
      {load.state === 'loading' && <div style={{ color: 'var(--muted)', padding: '20px 0' }}>Loading…</div>}
      {load.state === 'denied' && <div style={{ color: 'var(--muted)' }}>You don’t have access to this feed.</div>}
      {load.state === 'error' && <div style={{ color: 'var(--muted)' }}>Couldn’t load this section.</div>}
      {load.state === 'ok' && (empty ? <div style={{ color: 'var(--muted)', padding: '16px 0' }}>No data in this window yet.</div> : children)}
    </section>
  )
}

function Board() {
  const [days, setDays] = useState(30)
  const comms = useFeed<Comms>('/api/admin/comms/analytics', days)
  const funnel = useFeed<Funnel>('/api/admin/analytics/funnel', days)

  const c = comms.data
  const f = funnel.data
  const funnelRows = f ? Object.entries(f.totals).sort((a, b) => b[1] - a[1]) : []
  const funnelMax = funnelRows.length ? funnelRows[0][1] : 0

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '18px 16px 40px' }}>
      <header style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 18 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', margin: 0, display: 'flex', alignItems: 'center', gap: 9 }}><BarChart3 size={20} /> Analytics</h1>
          <p style={{ color: 'var(--muted)', fontSize: 13.5, margin: '6px 0 0' }}>Communications compliance and the customer quote funnel. Read-only.</p>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--muted)', fontWeight: 700 }}>
          <Filter size={14} /> Window
          <select value={days} onChange={e => setDays(Number(e.target.value))} style={field}>
            <option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option>
          </select>
        </label>
      </header>

      <Section title="Communications" icon={<MessageSquare size={17} />} load={comms} empty={!!c && c.totals.sent === 0}>
        {c && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 14 }}>
              <Stat label="Sent" value={String(c.totals.sent)} />
              <Stat label="Delivered" value={String(c.totals.sent - c.totals.failed)} sub={`${c.totals.failed} failed`} tone={c.totals.failed ? '#f59e0b' : undefined} />
              <Stat label="Read rate" value={`${c.totals.readRate}%`} />
              <Stat label="Ack rate" value={`${c.totals.ackRate}%`} />
              <Stat label="Completion" value={`${c.totals.completionRate}%`} />
              <Stat label="Escalations" value={String(c.totals.escalations)} tone={c.totals.escalations ? '#f59e0b' : undefined} />
            </div>
            {c.mostReliable.length > 0 && (
              <div style={{ border: '1px solid var(--line)', borderRadius: 12, overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 460 }}>
                  <thead><tr><th style={th}>Crew</th><th style={th}>Sent</th><th style={th}>Acked</th><th style={th}>Ack rate</th><th style={th}>Avg response</th></tr></thead>
                  <tbody>
                    {c.mostReliable.map(r => (
                      <tr key={r.staffId}>
                        <td style={{ ...td, fontWeight: 700 }}>{r.name}</td>
                        <td style={td}>{r.sent}</td><td style={td}>{r.acked}</td>
                        <td style={td}>{r.ackRate}%</td>
                        <td style={{ ...td, color: 'var(--muted)' }}>{r.avgResponseMs ? `${Math.round(r.avgResponseMs / 60000)}m` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {c.mostMissed.length > 0 && (
              <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--muted)' }}>
                Most-missed: {c.mostMissed.map(m => `${m.title} (${m.missRate}%)`).join(' · ')}
              </div>
            )}
          </>
        )}
      </Section>

      <Section title="Quote funnel" icon={<BarChart3 size={17} />} load={funnel} empty={funnelRows.length === 0}>
        <div style={{ display: 'grid', gap: 7 }}>
          {funnelRows.map(([ev, n]) => (
            <div key={ev} style={{ display: 'grid', gridTemplateColumns: '190px 1fr 48px', alignItems: 'center', gap: 10 }}>
              <div style={{ fontSize: 12.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{humanize(ev)}</div>
              <div style={{ height: 8, borderRadius: 999, background: 'rgba(255,255,255,.06)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${funnelMax ? Math.round((n / funnelMax) * 100) : 0}%`, background: 'var(--red)', borderRadius: 999 }} />
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', textAlign: 'right' }}>{n}</div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  )
}

export default function AnalyticsPage() {
  return <OperationsShell><Board /></OperationsShell>
}
