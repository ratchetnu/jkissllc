'use client'

import { useState } from 'react'

// Structural — accepts the page's Route[] (extra fields are fine).
type WRoute = {
  token: string; status: string; businessName: string
  reportTime: string; routeDate: string; assignedStaffName?: string
}

const STATUS_DOT: Record<string, string> = {
  draft: '#94a3b8', assigned: '#93c5fd', text_sent: '#fcd34d', confirmed: '#86efac',
  declined: '#fca5a5', no_response: '#fcd34d', no_show: '#fca5a5', completed: '#86efac', cancelled: '#64748b',
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
function mondayOf(d: Date): Date { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); x.setHours(0, 0, 0, 0); return x }
function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x }

const navBtn: React.CSSProperties = { padding: '5px 11px', fontSize: 13, fontWeight: 700, borderRadius: 8, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: '#e5e7eb', cursor: 'pointer' }
const ell: React.CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }

export default function WeekView({ routes }: { routes: WRoute[] }) {
  const [weekStart, setWeekStart] = useState<Date>(() => mondayOf(new Date()))
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  const todayStr = ymd(new Date())
  const label = `${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${addDays(weekStart, 6).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`

  return (
    <div>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <button onClick={() => setWeekStart(w => addDays(w, -7))} style={navBtn} aria-label="Previous week">‹</button>
          <button onClick={() => setWeekStart(mondayOf(new Date()))} style={navBtn}>Today</button>
          <button onClick={() => setWeekStart(w => addDays(w, 7))} style={navBtn} aria-label="Next week">›</button>
        </div>
        <span className="text-sm font-semibold" style={{ color: 'var(--muted)' }}>{label}</span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(140px, 1fr))', gap: 8, minWidth: 900 }}>
          {days.map(d => {
            const ds = ymd(d)
            const isToday = ds === todayStr
            const dayRoutes = routes.filter(r => r.routeDate === ds).sort((a, b) => a.reportTime.localeCompare(b.reportTime))
            return (
              <div key={ds} style={{ border: `1px solid ${isToday ? 'rgba(224,35,58,.4)' : 'var(--line)'}`, borderRadius: 12, padding: 8, background: isToday ? 'rgba(224,35,58,.06)' : 'rgba(255,255,255,.02)', minHeight: 120 }}>
                <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: isToday ? '#fca5a5' : 'var(--muted)', marginBottom: 6 }}>
                  {d.toLocaleDateString('en-US', { weekday: 'short' })} {d.getDate()}
                </div>
                <div className="flex flex-col gap-1.5">
                  {dayRoutes.length === 0
                    ? <span style={{ fontSize: 11, color: '#64748b' }}>—</span>
                    : dayRoutes.map(r => (
                      <div key={r.token} style={{ padding: '6px 8px', borderRadius: 8, background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <span style={{ width: 7, height: 7, borderRadius: 99, background: STATUS_DOT[r.status] || '#94a3b8', flexShrink: 0 }} />
                          <span style={{ fontSize: 11.5, fontWeight: 700, color: '#e5e7eb', ...ell }}>{r.reportTime}</span>
                        </div>
                        <div style={{ fontSize: 12, color: '#e5e7eb', marginTop: 2, ...ell }}>{r.businessName}</div>
                        <div style={{ fontSize: 10.5, color: 'var(--muted)', ...ell }}>{r.assignedStaffName || 'Unassigned'}</div>
                      </div>
                    ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
