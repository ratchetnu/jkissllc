'use client'

import { useCallback, useEffect, useState } from 'react'
import { TrendingUp, Award, AlertOctagon } from 'lucide-react'
import { Stat } from '../ui'
import { api } from './commsShared'

type Analytics = {
  windowDays: number
  totals: { sent: number; opened: number; acked: number; completed: number; failed: number; escalations: number; lateResponses: number; readRate: number; ackRate: number; completionRate: number; avgResponseMs: number }
  crewCompliance: { staffId: string; name: string; sent: number; acked: number; completed: number; ackRate: number; avgResponseMs: number }[]
  mostReliable: { name: string; ackRate: number; sent: number }[]
  mostMissed: { title: string; missRate: number; sent: number }[]
  activeReminders: number
}

const fmtDur = (ms: number): string => {
  if (!ms) return '—'
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// Communication analytics (request Part 15). Read/ack/completion rates, response
// time, compliance, most-missed reminders, and the most-reliable crew.
export default function CommsAnalytics() {
  const [d, setD] = useState<Analytics | null>(null)
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try { setD(await api<Analytics>(`/api/admin/comms/analytics?days=${days}`)) } catch { /* ignore */ } finally { setLoading(false) }
  }, [days])
  useEffect(() => { load() }, [load])

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {[7, 30, 90].map(n => <button key={n} className="cc-seg" data-active={days === n} onClick={() => setDays(n)}>{n}d</button>)}
      </div>

      {loading || !d ? (
        <div className="cc-stat-grid">{[0, 1, 2, 3].map(i => <div key={i} className="os-card" style={{ height: 78 }}><div className="skeleton" style={{ width: '60%', height: 14, margin: 15, borderRadius: 7 }} /></div>)}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="cc-stat-grid">
            <Stat label="Messages Sent" value={String(d.totals.sent)} sub={`last ${d.windowDays} days`} />
            <Stat label="Read Rate" value={`${d.totals.readRate}%`} tone="#93c5fd" />
            <Stat label="Ack Rate" value={`${d.totals.ackRate}%`} tone="#86efac" />
            <Stat label="Completion" value={`${d.totals.completionRate}%`} tone="#86efac" />
            <Stat label="Avg Response" value={fmtDur(d.totals.avgResponseMs)} />
            <Stat label="Late Responses" value={String(d.totals.lateResponses)} tone={d.totals.lateResponses ? '#fcd34d' : undefined} />
            <Stat label="Escalations" value={String(d.totals.escalations)} tone={d.totals.escalations ? '#fca5a5' : undefined} />
            <Stat label="Active Reminders" value={String(d.activeReminders)} />
          </div>

          <div className="cc-split">
            <Panel icon={<Award size={16} />} title="Most reliable crew">
              {d.mostReliable.length === 0 ? <Empty /> : d.mostReliable.map((c, i) => (
                <Bar key={i} name={c.name} pct={c.ackRate} sub={`${c.ackRate}% · ${c.sent} sent`} color="#86efac" />
              ))}
            </Panel>
            <Panel icon={<AlertOctagon size={16} />} title="Most missed reminders">
              {d.mostMissed.length === 0 ? <Empty /> : d.mostMissed.map((r, i) => (
                <Bar key={i} name={r.title} pct={r.missRate} sub={`${r.missRate}% missed · ${r.sent} sent`} color="#fca5a5" />
              ))}
            </Panel>
          </div>

          <Panel icon={<TrendingUp size={16} />} title="Crew compliance">
            {d.crewCompliance.length === 0 ? <Empty /> : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
                  <thead><tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                    <th style={{ padding: '6px 8px' }}>Crew</th><th style={th}>Sent</th><th style={th}>Ack</th><th style={th}>Done</th><th style={th}>Rate</th><th style={th}>Avg resp</th>
                  </tr></thead>
                  <tbody>
                    {d.crewCompliance.map(c => (
                      <tr key={c.staffId} style={{ borderTop: '1px solid var(--line)' }}>
                        <td style={{ padding: '8px', fontWeight: 700 }}>{c.name}</td>
                        <td style={td}>{c.sent}</td><td style={td}>{c.acked}</td><td style={td}>{c.completed}</td>
                        <td style={{ ...td, color: c.ackRate >= 85 ? '#86efac' : c.ackRate >= 60 ? '#fcd34d' : '#fca5a5', fontWeight: 800 }}>{c.ackRate}%</td>
                        <td style={td}>{fmtDur(c.avgResponseMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      )}
    </div>
  )
}

const th: React.CSSProperties = { padding: '6px 8px', textAlign: 'right' }
const td: React.CSSProperties = { padding: '8px', textAlign: 'right' }
function Panel({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return <div className="os-card os-rise" style={{ padding: 16 }}><div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, color: 'var(--muted)' }}>{icon}<span style={{ fontSize: 13, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase' }}>{title}</span></div>{children}</div>
}
function Empty() { return <p style={{ fontSize: 13, color: 'var(--muted)' }}>Not enough data yet.</p> }
function Bar({ name, pct, sub, color }: { name: string; pct: number; sub: string; color: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5, marginBottom: 5 }}><span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span><span style={{ color: 'var(--muted)', fontSize: 12, flexShrink: 0, marginLeft: 8 }}>{sub}</span></div>
      <div style={{ height: 7, borderRadius: 99, background: 'rgba(255,255,255,.07)', overflow: 'hidden' }}><div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: color, borderRadius: 99 }} /></div>
    </div>
  )
}
