'use client'

// Communications console (Phase 7). A calm, read-only workspace over the comms
// event model: channel health, the event catalog with live template preview, a
// hard-test send button, recent + failed message history, usage estimate, and the
// (disabled) automation rules. It is NOT another operations dashboard and does NOT
// replace the existing inbox — it is the control surface for the event/template
// layer. Nothing here sends a real message; loading the page sends nothing at all.

import { useCallback, useEffect, useMemo, useState } from 'react'
import OperationsShell from '../OperationsShell'
import { Mail, MessageSquare } from 'lucide-react'
import { osLabel } from '../ui'

type Health = {
  sendMode: 'live' | 'test' | 'off'
  vercelEnv: string
  channels: { sms: { configured: boolean; provider: string }; email: { configured: boolean; provider: string } }
  events: { event: string; label: string; audience: string; channels: string[]; reminder: boolean; existing: string | null }[]
  automation: { id: string; label: string; description: string; event: string; anchor: string; offsetHours: number; channels: string[]; enabled: boolean; mode: string; overlapsExisting: string | null }[]
}
type HistoryRow = {
  id: string; createdAt: number; direction: string; channel: string; provider: string
  recipient?: string; subject?: string; body: string; status: string
  event?: string; simulated: boolean; initiatedBy?: string; bookingNumber?: string
}
type Usage = { window: number; smsCount: number; emailCount: number; smsSegments: number; failed: number; simulated: number; estimatedUsd: number }
type Preview = { event: string; sms?: string; email?: { subject: string; html: string }; missing: string[]; channels: string[] }

const card: React.CSSProperties = { padding: 18, marginBottom: 14 }
const muted: React.CSSProperties = { color: 'var(--muted)', fontSize: 13 }

function Dot({ ok }: { ok: boolean }) {
  return <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 9, marginRight: 7, background: ok ? '#86efac' : '#fca5a5' }} />
}

// ── Message history presentation ─────────────────────────────────────────────
// Flat rows with hairline separators instead of a stack of bordered cards, grouped
// by day. The old row crammed recipient · event · simulated · booking · sender ·
// timestamp into one dot-chain; here the two things you scan for (who, when) stay on
// the line and the rest become quiet chips that appear only when set.

const dayKey = (ts: number) => new Date(ts).toLocaleDateString('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })

function dayHeading(ts: number): string {
  const now = Date.now()
  if (dayKey(ts) === dayKey(now)) return 'Today'
  if (dayKey(ts) === dayKey(now - 86_400_000)) return 'Yesterday'
  return new Date(ts).toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric' })
}

const clockTime = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })

const STATUS_TONE: Record<string, string> = {
  failed: '#fca5a5', undelivered: '#fca5a5',
  delivered: '#86efac', sent: '#86efac',
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', border: '1px solid var(--line)', borderRadius: 6, padding: '1px 6px', whiteSpace: 'nowrap' }}>{children}</span>
}

function MessageRow({ m, first }: { m: HistoryRow; first: boolean }) {
  const tone = STATUS_TONE[m.status] || 'var(--muted)'
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '11px 2px', borderTop: first ? 'none' : '1px solid var(--line)' }}>
      <span aria-hidden style={{ color: 'var(--muted)', flexShrink: 0, marginTop: 1 }}>
        {m.channel === 'email' ? <Mail size={15} /> : <MessageSquare size={15} />}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, lineHeight: 1.45, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.subject || m.body}</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
          <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{m.recipient || 'No recipient'} · {clockTime(m.createdAt)}</span>
          {m.simulated && <Chip>simulated</Chip>}
          {m.bookingNumber && <Chip>{m.bookingNumber}</Chip>}
          {m.event && <Chip>{m.event}</Chip>}
          {m.initiatedBy && <Chip>by {m.initiatedBy}</Chip>}
        </div>
      </div>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0, fontSize: 11.5, fontWeight: 700, color: tone }}>
        <span aria-hidden style={{ width: 6, height: 6, borderRadius: 6, background: tone }} />
        {m.status}
      </span>
    </div>
  )
}

function ModeBadge({ mode }: { mode: string }) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    off: { bg: 'rgba(148,163,184,.15)', fg: '#cbd5e1', label: 'Suppressed (off)' },
    test: { bg: 'rgba(252,211,77,.15)', fg: '#fcd34d', label: 'Test / simulated' },
    live: { bg: 'rgba(134,239,172,.15)', fg: '#86efac', label: 'Live' },
  }
  const s = map[mode] || map.off
  return <span style={{ background: s.bg, color: s.fg, padding: '3px 10px', borderRadius: 8, fontSize: 12, fontWeight: 800 }}>{s.label}</span>
}

export default function Communications() {
  const [health, setHealth] = useState<Health | null>(null)
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [usage, setUsage] = useState<Usage | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [onlyFailed, setOnlyFailed] = useState(false)
  const [channelFilter, setChannelFilter] = useState('')
  const [selected, setSelected] = useState<string>('BOOKING_CONFIRMED')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [testMsg, setTestMsg] = useState('')

  const loadHealth = useCallback(async () => {
    const r = await fetch('/api/admin/communications/health', { credentials: 'same-origin' })
    if (!r.ok) throw new Error('health')
    setHealth(await r.json())
  }, [])

  const loadHistory = useCallback(async () => {
    const p = new URLSearchParams({ onlyComms: '1', limit: '100' })
    if (onlyFailed) p.set('onlyFailed', '1')
    if (channelFilter) p.set('channel', channelFilter)
    const r = await fetch(`/api/admin/communications/history?${p}`, { credentials: 'same-origin' })
    if (!r.ok) throw new Error('history')
    const d = await r.json()
    setRows(d.rows || [])
    setUsage(d.usage || null)
  }, [onlyFailed, channelFilter])

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true); setErr('')
      try { await Promise.all([loadHealth(), loadHistory()]) }
      catch { if (alive) setErr('Could not load communications data.') }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [loadHealth, loadHistory])

  // Group the history by calendar day (Central, matching every other ops surface) so
  // the list reads as "Today / Yesterday / Fri, Aug 1" instead of one flat run.
  // The API already returns newest-first; grouping preserves that order.
  const groupedRows = useMemo(() => {
    const groups: { key: string; heading: string; items: HistoryRow[] }[] = []
    for (const m of rows) {
      const key = dayKey(m.createdAt)
      const last = groups[groups.length - 1]
      if (last && last.key === key) last.items.push(m)
      else groups.push({ key, heading: dayHeading(m.createdAt), items: [m] })
    }
    return groups
  }, [rows])

  const doPreview = useCallback(async (event: string) => {
    setPreviewing(true); setPreview(null); setTestMsg('')
    try {
      const r = await fetch('/api/admin/communications/preview', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event }),
      })
      if (r.ok) setPreview(await r.json())
    } finally { setPreviewing(false) }
  }, [])

  useEffect(() => { doPreview(selected) }, [selected, doPreview])

  const runTest = useCallback(async () => {
    setTestMsg('Running…')
    const r = await fetch('/api/admin/communications/dispatch', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: selected }),
    })
    if (!r.ok) { setTestMsg('Test failed.'); return }
    const d = await r.json()
    const outs = (d.result?.outcomes || []).map((o: { channel: string; status: string }) => `${o.channel}:${o.status}`).join(', ')
    setTestMsg(`Simulated (${d.result?.mode}). Channels → ${outs || 'none'}. No real message was sent.`)
    loadHistory().catch(() => {})
  }, [selected, loadHistory])

  // Memoised so its identity is stable; as a bare `|| []` it produced a new array every
  // render, which defeated the useMemo below that depends on it.
  const events = useMemo(() => health?.events || [], [health])
  const selectedDef = useMemo(() => events.find(e => e.event === selected), [events, selected])

  return (
    <OperationsShell>
      <div style={{ marginBottom: 14 }}>
        <h1 className="jkos-h" style={{ fontSize: 'clamp(28px,6vw,40px)' }}>Communications</h1>
        <p style={muted}>Event templates, delivery health, history, and automation — a calm control surface. Sending is suppressed unless explicitly enabled.</p>
      </div>

      {err && <div className="os-card" style={{ padding: '11px 14px', marginBottom: 14, color: '#fca5a5', fontSize: 13.5 }}>{err}</div>}

      {/* Channel health + send mode */}
      <div className="os-card os-rise" style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div style={{ ...osLabel }}>Channel health</div>
          {health && <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span style={muted}>Send mode:</span> <ModeBadge mode={health.sendMode} /> <span style={muted}>({health.vercelEnv})</span></div>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px,100%),1fr))', gap: 12, marginTop: 12 }}>
          <div><Dot ok={!!health?.channels.sms.configured} /> SMS · Twilio — <span style={muted}>{health?.channels.sms.configured ? 'configured' : 'not configured'}</span></div>
          <div><Dot ok={!!health?.channels.email.configured} /> Email · Resend — <span style={muted}>{health?.channels.email.configured ? 'configured' : 'not configured'}</span></div>
        </div>
        {health?.sendMode !== 'live' && (
          <p style={{ ...muted, marginTop: 12 }}>Messages are not delivered to real recipients in this environment. Preview and test are safe.</p>
        )}
      </div>

      {/* Usage estimate */}
      {usage && (
        <div className="os-card os-rise" style={card}>
          <div style={{ ...osLabel, marginBottom: 10 }}>Usage (recent · estimate)</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(110px,100%),1fr))', gap: 10 }}>
            <Metric label="Messages" value={String(usage.window)} />
            <Metric label="SMS" value={String(usage.smsCount)} />
            <Metric label="Email" value={String(usage.emailCount)} />
            <Metric label="Failed" value={String(usage.failed)} tone={usage.failed ? '#fca5a5' : undefined} />
            <Metric label="Simulated" value={String(usage.simulated)} />
            <Metric label="Est. SMS cost" value={`$${usage.estimatedUsd.toFixed(2)}`} />
          </div>
          <p style={{ ...muted, marginTop: 10 }}>Volume estimate only (SMS billed per 160-char segment) — not a billing source of truth.</p>
        </div>
      )}

      {/* Event catalog + preview */}
      <div className="os-card os-rise" style={card}>
        <div style={{ ...osLabel, marginBottom: 10 }}>Templates &amp; preview</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.4fr)', gap: 16 }}>
          <div style={{ maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {events.map(e => (
              <button key={e.event} onClick={() => setSelected(e.event)}
                style={{ textAlign: 'left', padding: '9px 11px', borderRadius: 10, cursor: 'pointer',
                  background: selected === e.event ? 'color-mix(in srgb, var(--card) 70%, transparent)' : 'transparent',
                  border: `1px solid ${selected === e.event ? 'var(--line)' : 'transparent'}`, color: 'var(--text)' }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{e.label}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{e.audience} · {e.channels.join(', ')}{e.reminder ? ' · reminder' : ''}</div>
              </button>
            ))}
          </div>
          <div>
            {previewing && <div style={muted}>Rendering…</div>}
            {preview && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {selectedDef?.existing && <div style={{ ...muted, fontSize: 12 }}>Production sender today: <code>{selectedDef.existing}</code></div>}
                {preview.missing.length > 0 && (
                  <div style={{ fontSize: 12.5, color: '#fcd34d' }}>Missing for full render: {preview.missing.join(', ')} (safe fallbacks applied)</div>
                )}
                {preview.sms && (
                  <div>
                    <div style={{ ...osLabel, marginBottom: 6 }}>SMS</div>
                    <div style={{ padding: '11px 13px', borderRadius: 12, background: 'color-mix(in srgb, var(--card) 80%, transparent)', border: '1px solid var(--line)', fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{preview.sms}</div>
                    <div style={{ ...muted, marginTop: 4, fontSize: 11.5 }}>{preview.sms.length} chars · {Math.max(1, Math.ceil(preview.sms.length / 160))} segment(s)</div>
                  </div>
                )}
                {preview.email && (
                  <div>
                    <div style={{ ...osLabel, marginBottom: 6 }}>Email — {preview.email.subject}</div>
                    <iframe title="email preview" sandbox="" srcDoc={preview.email.html}
                      style={{ width: '100%', height: 300, border: '1px solid var(--line)', borderRadius: 12, background: '#fff' }} />
                  </div>
                )}
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button onClick={runTest} style={{ padding: '9px 16px', borderRadius: 10, fontWeight: 700, fontSize: 13.5, cursor: 'pointer', background: 'var(--red, #E0002A)', color: '#fff', border: 'none' }}>
                    Run test (simulated)
                  </button>
                  {testMsg && <span style={{ ...muted, fontSize: 12.5 }}>{testMsg}</span>}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* History */}
      <div className="os-card os-rise" style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
          <div style={osLabel}>Recent messages</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select value={channelFilter} onChange={e => setChannelFilter(e.target.value)} style={{ ...osLabel, padding: '6px 9px', borderRadius: 8, background: 'var(--card)', border: '1px solid var(--line)', color: 'var(--text)' }}>
              <option value="">All channels</option>
              <option value="sms">SMS</option>
              <option value="email">Email</option>
            </select>
            <label style={{ ...muted, display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={onlyFailed} onChange={e => setOnlyFailed(e.target.checked)} /> Failed only
            </label>
          </div>
        </div>
        {loading ? <div style={muted}>Loading…</div> : rows.length === 0 ? (
          <div style={muted}>No messages match. (Nothing is sent by loading this page.)</div>
        ) : (
          <div>
            {groupedRows.map(group => (
              <div key={group.key} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', padding: '0 2px 4px' }}>
                  {group.heading}
                </div>
                {group.items.map((m, i) => <MessageRow key={m.id} m={m} first={i === 0} />)}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Automation rules */}
      <div className="os-card os-rise" style={card}>
        <div style={{ ...osLabel, marginBottom: 4 }}>Automation rules</div>
        <p style={{ ...muted, marginBottom: 12 }}>All rules ship disabled and in test mode. None is wired to a schedule — enabling is a deliberate, separate step.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(health?.automation || []).map(r => (
            <div key={r.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{r.label}</div>
                <div style={{ ...muted, fontSize: 12 }}>{r.description}</div>
                {r.overlapsExisting && <div style={{ ...muted, fontSize: 11.5, marginTop: 3, color: '#fcd34d' }}>Overlaps existing: {r.overlapsExisting}</div>}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                <ModeBadge mode={r.mode} />
                <span style={{ fontSize: 11.5, fontWeight: 800, color: r.enabled ? '#86efac' : 'var(--muted)' }}>{r.enabled ? 'enabled' : 'disabled'}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </OperationsShell>
  )
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div style={{ padding: '11px 13px', borderRadius: 12, border: '1px solid var(--line)', background: 'color-mix(in srgb, var(--card) 60%, transparent)' }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: tone || 'var(--text)' }}>{value}</div>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', marginTop: 2 }}>{label}</div>
    </div>
  )
}
