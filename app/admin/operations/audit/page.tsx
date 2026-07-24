'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ScrollText, X } from 'lucide-react'
import OperationsShell from '../OperationsShell'

// Read-only audit-log viewer. Server gates on audit:view and scopes to the caller's
// tenant. Legacy records (no outcome/tenantId) are labeled, never guessed.

type Outcome = 'success' | 'denied' | 'failure'
type AuditEntry = {
  id: string; at: number; tenantId?: string
  actor: string; actorRole: string; action: string
  entity: string; entityId?: string; outcome?: Outcome; correlationId?: string
  summary: string; meta?: Record<string, unknown>
}
type SafeUser = { id: string; name?: string; email?: string }

const fmtWhen = (ms: number) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const field: React.CSSProperties = { padding: '9px 12px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 10, color: 'var(--text)', fontSize: 14, outline: 'none' }
const th: React.CSSProperties = { textAlign: 'left', padding: '10px 12px', fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap' }
const td: React.CSSProperties = { padding: '11px 12px', fontSize: 13.5, color: 'var(--text)', borderTop: '1px solid var(--line)', whiteSpace: 'nowrap' }

const OUTCOMES: Outcome[] = ['success', 'denied', 'failure']
const outcomeStyle = (o: Outcome | undefined) => {
  const v = o ?? 'success'
  const map = { success: ['#34d399', 'rgba(52,211,153,.13)'], denied: ['#f59e0b', 'rgba(245,158,11,.13)'], failure: ['#f87171', 'rgba(248,113,113,.13)'] } as const
  const [fg, bg] = map[v]
  return { color: fg, background: bg, padding: '3px 9px', borderRadius: 999, fontSize: 11.5, fontWeight: 700 }
}

function Log() {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [users, setUsers] = useState<SafeUser[]>([])
  const [loading, setLoading] = useState(true)
  const [state, setState] = useState<'ok' | 'denied' | 'error'>('ok')
  const [detail, setDetail] = useState<AuditEntry | null>(null)

  const [actor, setActor] = useState(''); const [action, setAction] = useState(''); const [entity, setEntity] = useState('')
  const [outcome, setOutcome] = useState(''); const [start, setStart] = useState(''); const [end, setEnd] = useState(''); const [q, setQ] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const p = new URLSearchParams()
    if (actor) p.set('actor', actor); if (action) p.set('action', action); if (entity) p.set('entity', entity)
    if (outcome) p.set('outcome', outcome); if (start) p.set('start', start); if (end) p.set('end', end); if (q) p.set('q', q)
    try {
      const res = await fetch(`/api/admin/audit?${p.toString()}`, { credentials: 'same-origin' })
      if (res.status === 401 || res.status === 403) { setState('denied'); return }
      if (!res.ok) { setState('error'); return }
      const j = await res.json(); setState('ok'); setEntries(j.entries || [])
    } catch { setState('error') } finally { setLoading(false) }
  }, [actor, action, entity, outcome, start, end, q])
  useEffect(() => { load() }, [load])
  useEffect(() => { fetch('/api/admin/users', { credentials: 'same-origin' }).then(r => r.json()).then(j => setUsers(j.users || [])).catch(() => {}) }, [])

  const userName = useCallback((id: string) => users.find(u => u.id === id)?.name || (id === 'owner' ? 'Owner' : id), [users])
  const actionOpts = useMemo(() => [...new Set(entries.map(e => e.action))].sort(), [entries])
  const entityOpts = useMemo(() => [...new Set(entries.map(e => e.entity))].sort(), [entries])

  return (
    <div style={{ maxWidth: 1120, margin: '0 auto', padding: '18px 16px 40px' }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', margin: 0, display: 'flex', alignItems: 'center', gap: 9 }}><ScrollText size={20} /> Audit Log</h1>
        <p style={{ color: 'var(--muted)', fontSize: 13.5, margin: '6px 0 0' }}>Attributed record of administrative and communication actions. Read-only, scoped to this business.</p>
      </header>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end', marginBottom: 16 }}>
        <label style={{ display: 'grid', gap: 4, fontSize: 11.5, color: 'var(--muted)', fontWeight: 700 }}>Actor
          <select value={actor} onChange={e => setActor(e.target.value)} style={{ ...field, minWidth: 150 }}>
            <option value="">Anyone</option><option value="owner">Owner</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name || u.email || u.id}</option>)}
          </select></label>
        <label style={{ display: 'grid', gap: 4, fontSize: 11.5, color: 'var(--muted)', fontWeight: 700 }}>Action
          <select value={action} onChange={e => setAction(e.target.value)} style={{ ...field, minWidth: 150 }}>
            <option value="">All actions</option>{actionOpts.map(a => <option key={a} value={a}>{a}</option>)}</select></label>
        <label style={{ display: 'grid', gap: 4, fontSize: 11.5, color: 'var(--muted)', fontWeight: 700 }}>Target
          <select value={entity} onChange={e => setEntity(e.target.value)} style={{ ...field, minWidth: 120 }}>
            <option value="">All targets</option>{entityOpts.map(a => <option key={a} value={a}>{a}</option>)}</select></label>
        <label style={{ display: 'grid', gap: 4, fontSize: 11.5, color: 'var(--muted)', fontWeight: 700 }}>Outcome
          <select value={outcome} onChange={e => setOutcome(e.target.value)} style={{ ...field, minWidth: 110 }}>
            <option value="">Any</option>{OUTCOMES.map(o => <option key={o} value={o}>{o}</option>)}</select></label>
        <label style={{ display: 'grid', gap: 4, fontSize: 11.5, color: 'var(--muted)', fontWeight: 700 }}>From<input type="date" value={start} onChange={e => setStart(e.target.value)} style={field} /></label>
        <label style={{ display: 'grid', gap: 4, fontSize: 11.5, color: 'var(--muted)', fontWeight: 700 }}>To<input type="date" value={end} onChange={e => setEnd(e.target.value)} style={field} /></label>
        <label style={{ display: 'grid', gap: 4, fontSize: 11.5, color: 'var(--muted)', fontWeight: 700 }}>Search<input value={q} onChange={e => setQ(e.target.value)} placeholder="id / text" style={{ ...field, minWidth: 130 }} /></label>
        {(actor || action || entity || outcome || start || end || q) && <button type="button" onClick={() => { setActor(''); setAction(''); setEntity(''); setOutcome(''); setStart(''); setEnd(''); setQ('') }} style={{ ...field, cursor: 'pointer', fontWeight: 700, color: 'var(--muted)' }}>Clear</button>}
      </div>

      {loading && <div style={{ color: 'var(--muted)', padding: '40px 0', textAlign: 'center' }}>Loading audit log…</div>}
      {!loading && state === 'denied' && <div style={{ padding: 24, border: '1px solid var(--line)', borderRadius: 14, color: 'var(--muted)' }}>You don’t have access to the audit log (requires <code>audit:view</code>).</div>}
      {!loading && state === 'error' && <div style={{ padding: 24, border: '1px solid var(--line)', borderRadius: 14, color: 'var(--muted)' }}>Couldn’t load the audit log. <button type="button" onClick={load} style={{ ...field, cursor: 'pointer', marginLeft: 8 }}>Retry</button></div>}

      {!loading && state === 'ok' && (
        entries.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 14 }}>No audit events match this filter.</div>
        ) : (
          <>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>{entries.length} event{entries.length === 1 ? '' : 's'} (most recent first, bounded)</div>
            <div style={{ border: '1px solid var(--line)', borderRadius: 14, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
                <thead><tr><th style={th}>When</th><th style={th}>Actor</th><th style={th}>Action</th><th style={th}>Target</th><th style={th}>Outcome</th><th style={th}>Summary</th></tr></thead>
                <tbody>
                  {entries.map(e => (
                    <tr key={e.id} onClick={() => setDetail(e)} style={{ cursor: 'pointer' }}>
                      <td style={{ ...td, color: 'var(--muted)' }}>{fmtWhen(e.at)}</td>
                      <td style={td}>{userName(e.actor)}<span style={{ color: 'var(--muted)', fontSize: 11.5 }}> · {e.actorRole}</span></td>
                      <td style={{ ...td, fontWeight: 700 }}>{e.action}</td>
                      <td style={{ ...td, color: 'var(--muted)' }}>{e.entity}{e.entityId ? ` · ${e.entityId.slice(0, 10)}` : ''}</td>
                      <td style={td}><span style={outcomeStyle(e.outcome)}>{e.outcome ?? 'success'}</span></td>
                      <td style={{ ...td, whiteSpace: 'normal', maxWidth: 320 }}>{e.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )
      )}

      {detail && (
        <div onClick={() => setDetail(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}>
          <div onClick={ev => ev.stopPropagation()} style={{ width: 'min(440px, 100%)', height: '100%', background: 'var(--bg, #0b0b0c)', borderLeft: '1px solid var(--line)', overflowY: 'auto', padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)' }}>Event detail</div>
              <button type="button" aria-label="Close" onClick={() => setDetail(null)} style={{ ...field, cursor: 'pointer', padding: 8 }}><X size={16} /></button>
            </div>
            {([
              ['When', fmtWhen(detail.at)], ['Actor', `${userName(detail.actor)} (${detail.actorRole})`], ['Action', detail.action],
              ['Target type', detail.entity], ['Target id', detail.entityId || '—'], ['Outcome', detail.outcome ?? 'success'],
              ['Tenant', detail.tenantId || '— (legacy)'], ['Correlation', detail.correlationId || '—'],
            ] as [string, string][]).map(([k, v]) => (
              <div key={k} style={{ display: 'flex', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                <div style={{ width: 110, flexShrink: 0, fontSize: 12, color: 'var(--muted)', fontWeight: 700 }}>{k}</div>
                <div style={{ fontSize: 13.5, color: 'var(--text)', wordBreak: 'break-word' }}>{v}</div>
              </div>
            ))}
            <div style={{ marginTop: 14, fontSize: 12, color: 'var(--muted)', fontWeight: 700 }}>Summary</div>
            <div style={{ fontSize: 13.5, color: 'var(--text)', marginTop: 4 }}>{detail.summary}</div>
            {detail.meta && Object.keys(detail.meta).length > 0 && (
              <>
                <div style={{ marginTop: 14, fontSize: 12, color: 'var(--muted)', fontWeight: 700 }}>Metadata</div>
                <pre style={{ fontSize: 12, color: 'var(--text)', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 10, padding: 12, marginTop: 4, overflowX: 'auto' }}>{JSON.stringify(detail.meta, null, 2)}</pre>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function AuditPage() {
  return <OperationsShell><Log /></OperationsShell>
}
