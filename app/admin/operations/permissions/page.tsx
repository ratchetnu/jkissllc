'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Shield, Check, Search } from 'lucide-react'
import OperationsShell from '../OperationsShell'

// Read-only view of the STATIC RBAC matrix. Grants come straight from the runtime
// authorization source (computed via can() server-side), so this can never drift from
// what the guards enforce. There is intentionally NO edit path — the matrix is code.

type Role = { id: string; label: string }
type Perm = { id: string; grantedBy: string[] }
type Domain = { domain: string; permissions: Perm[] }
type Matrix = { roles: Role[]; domains: Domain[]; readOnly: boolean }

const th: React.CSSProperties = { textAlign: 'left', padding: '10px 12px', fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap' }
const field: React.CSSProperties = { padding: '9px 12px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 10, color: 'var(--text)', fontSize: 14, outline: 'none' }

function Matrix() {
  const [data, setData] = useState<Matrix | null>(null)
  const [loading, setLoading] = useState(true)
  const [state, setState] = useState<'ok' | 'denied' | 'error'>('ok')
  const [q, setQ] = useState('')
  const [domain, setDomain] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/permissions', { credentials: 'same-origin' })
      if (res.status === 401 || res.status === 403) { setState('denied'); return }
      if (!res.ok) { setState('error'); return }
      setState('ok'); setData(await res.json())
    } catch { setState('error') } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const domains = useMemo(() => {
    if (!data) return []
    const s = q.trim().toLowerCase()
    return data.domains
      .filter(d => !domain || d.domain === domain)
      .map(d => ({ ...d, permissions: d.permissions.filter(p => !s || p.id.toLowerCase().includes(s)) }))
      .filter(d => d.permissions.length > 0)
  }, [data, q, domain])

  const totalShown = domains.reduce((n, d) => n + d.permissions.length, 0)

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '18px 16px 40px' }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', margin: 0, display: 'flex', alignItems: 'center', gap: 9 }}><Shield size={20} /> Permissions</h1>
        <p style={{ color: 'var(--muted)', fontSize: 13.5, margin: '6px 0 0' }}>The role → permission matrix the server enforces. Read-only — permissions are defined in code, not configurable here.</p>
      </header>

      {!loading && state === 'ok' && data && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16, alignItems: 'flex-end' }}>
          <label style={{ display: 'grid', gap: 4, fontSize: 11.5, color: 'var(--muted)', fontWeight: 700, flex: '1 1 220px' }}>Search
            <span style={{ position: 'relative', display: 'block' }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: 11, color: 'var(--muted)' }} />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="permission id" style={{ ...field, paddingLeft: 30, width: '100%' }} />
            </span></label>
          <label style={{ display: 'grid', gap: 4, fontSize: 11.5, color: 'var(--muted)', fontWeight: 700 }}>Domain
            <select value={domain} onChange={e => setDomain(e.target.value)} style={{ ...field, minWidth: 180 }}>
              <option value="">All domains</option>{data.domains.map(d => <option key={d.domain} value={d.domain}>{d.domain}</option>)}</select></label>
        </div>
      )}

      {loading && <div style={{ color: 'var(--muted)', padding: '40px 0', textAlign: 'center' }}>Loading matrix…</div>}
      {!loading && state === 'denied' && <div style={{ padding: 24, border: '1px solid var(--line)', borderRadius: 14, color: 'var(--muted)' }}>You don’t have access to the permission matrix (requires <code>permissions:view</code>).</div>}
      {!loading && state === 'error' && <div style={{ padding: 24, border: '1px solid var(--line)', borderRadius: 14, color: 'var(--muted)' }}>Couldn’t load the matrix. <button type="button" onClick={load} style={{ ...field, cursor: 'pointer', marginLeft: 8 }}>Retry</button></div>}

      {!loading && state === 'ok' && data && (
        totalShown === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 14 }}>No permissions match.</div>
        ) : (
          <div style={{ border: '1px solid var(--line)', borderRadius: 14, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
              <thead><tr>
                <th style={th}>Permission</th>
                {data.roles.map(r => <th key={r.id} style={{ ...th, textAlign: 'center' }}>{r.label}</th>)}
              </tr></thead>
              <tbody>
                {domains.map(d => (
                  <Fragment key={d.domain}>
                    <tr><td colSpan={data.roles.length + 1} style={{ padding: '10px 12px', fontSize: 11.5, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', background: 'color-mix(in srgb, var(--card) 90%, transparent)', borderTop: '1px solid var(--line)' }}>{d.domain}</td></tr>
                    {d.permissions.map(p => (
                      <tr key={p.id}>
                        <td style={{ padding: '10px 12px', fontSize: 13, color: 'var(--text)', borderTop: '1px solid var(--line)', fontFamily: 'ui-monospace, monospace' }}>{p.id}</td>
                        {data.roles.map(r => (
                          <td key={r.id} style={{ padding: '10px 12px', textAlign: 'center', borderTop: '1px solid var(--line)' }}>
                            {p.grantedBy.includes(r.id)
                              ? <Check size={15} style={{ color: '#34d399' }} aria-label="granted" />
                              : <span style={{ color: 'var(--line)' }} aria-label="not granted">–</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  )
}

export default function PermissionsPage() {
  return <OperationsShell><Matrix /></OperationsShell>
}
