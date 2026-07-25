'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { KeyRound, Check, Search, ChevronRight, Lock } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import {
  VIEW_MODES, filterDomains, countPermissions, resultCountLabel,
  permissionLabel, roleSummaries, roleScopeLabel,
  type MatrixData, type ViewMode, type Domain,
} from './permissions-view'

// Read-only view of the STATIC RBAC matrix. Grants come straight from the runtime
// authorization source (computed via can() server-side), so this can never drift from
// what the guards enforce. There is intentionally NO edit path — the matrix is code.
//
// Presentation is progressive: the default view answers "what can someone do?" one
// area at a time, and the full role×permission grid stays one tap away for the rare
// moment you actually want to read a grid.

// ── Quiet, shared surface tokens ─────────────────────────────────────────────
const CARD: React.CSSProperties = { background: 'color-mix(in srgb, var(--card) 92%, transparent)', border: '1px solid var(--line)', borderRadius: 14 }
const FIELD: React.CSSProperties = { padding: '9px 12px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 10, color: 'var(--text)', fontSize: 13.5, outline: 'none' }
const LABEL: React.CSSProperties = { display: 'grid', gap: 5, fontSize: 11, color: 'var(--muted)', fontWeight: 600, letterSpacing: '.02em' }
const GRANT = '#34d399'

function RoleChip({ label }: { label: string }) {
  return (
    <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text)', background: 'color-mix(in srgb, var(--line) 45%, transparent)', borderRadius: 999, padding: '3px 9px', whiteSpace: 'nowrap' }}>
      {label}
    </span>
  )
}

function Segmented({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div role="tablist" aria-label="Permission view" style={{ display: 'inline-flex', gap: 2, padding: 3, background: 'color-mix(in srgb, var(--line) 30%, transparent)', borderRadius: 11 }}>
      {VIEW_MODES.map(m => {
        const active = m.id === value
        return (
          <button
            key={m.id} type="button" role="tab" aria-selected={active} onClick={() => onChange(m.id)}
            style={{
              appearance: 'none', border: 'none', cursor: 'pointer', borderRadius: 9,
              padding: '6px 13px', fontSize: 13, fontWeight: active ? 600 : 500,
              color: active ? 'var(--text)' : 'var(--muted)',
              background: active ? 'var(--card)' : 'transparent',
              boxShadow: active ? '0 1px 2px rgba(0,0,0,.28)' : 'none',
              transition: 'background .15s ease, color .15s ease',
            }}
          >{m.label}</button>
        )
      })}
    </div>
  )
}

function DomainSection({ d, roleLabels, open, onToggle }: {
  d: Domain; roleLabels: Record<string, string>; open: boolean; onToggle: () => void
}) {
  const n = d.permissions.length
  return (
    <section style={{ ...CARD, overflow: 'hidden' }}>
      <button
        type="button" onClick={onToggle} aria-expanded={open}
        style={{ appearance: 'none', background: 'transparent', border: 'none', cursor: 'pointer', width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', textAlign: 'left', color: 'var(--text)' }}
      >
        <ChevronRight size={15} aria-hidden style={{ color: 'var(--muted)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .18s ease', flexShrink: 0 }} />
        <span style={{ fontSize: 14.5, fontWeight: 600, flex: 1 }}>{d.domain}</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{n}</span>
      </button>

      {open && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {d.permissions.map(p => (
            <li key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '12px 16px 12px 41px', borderTop: '1px solid color-mix(in srgb, var(--line) 65%, transparent)' }}>
              <span style={{ flex: '1 1 220px', minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13.5, color: 'var(--text)', fontWeight: 500 }}>{permissionLabel(p.id)}</span>
                <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', fontFamily: 'ui-monospace, monospace', marginTop: 2 }}>{p.id}</span>
              </span>
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {p.grantedBy.length === 0
                  ? <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>No one</span>
                  : p.grantedBy.map(r => <RoleChip key={r} label={roleLabels[r] ?? r} />)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function PermissionsView() {
  const [data, setData] = useState<MatrixData | null>(null)
  const [loading, setLoading] = useState(true)
  const [state, setState] = useState<'ok' | 'denied' | 'error'>('ok')
  const [mode, setMode] = useState<ViewMode>('permission')
  const [q, setQ] = useState('')
  const [domain, setDomain] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [activeRole, setActiveRole] = useState('')
  const [openDomains, setOpenDomains] = useState<Record<string, boolean>>({})

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

  // Default the role views to the first role once the projection arrives.
  useEffect(() => { if (data && !activeRole) setActiveRole(data.roles[0]?.id ?? '') }, [data, activeRole])

  const roleLabels = useMemo(() => Object.fromEntries((data?.roles ?? []).map(r => [r.id, r.label])), [data])
  const summaries = useMemo(() => (data ? roleSummaries(data) : []), [data])

  const searching = q.trim().length > 0 || !!domain || !!roleFilter

  const shown = useMemo(() => {
    if (!data) return []
    return filterDomains(data.domains, { q, domain, role: mode === 'role' ? activeRole : roleFilter })
  }, [data, q, domain, roleFilter, mode, activeRole])

  const total = countPermissions(shown)
  // While a filter is active every match is revealed — a hidden match reads as "no result".
  const isOpen = (name: string) => searching || !!openDomains[name]
  const toggle = (name: string) => setOpenDomains(s => ({ ...s, [name]: !s[name] }))

  return (
    <div style={{ maxWidth: 940, margin: '0 auto', padding: '20px 16px 56px' }}>
      {/* ── Header ── */}
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-.015em', color: 'var(--text)', margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
          <KeyRound size={20} aria-hidden /> Permissions
        </h1>
        <p style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.5, margin: '7px 0 0', maxWidth: 620 }}>
          What each role can do. Defined in code and enforced on every request.
        </p>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 11, fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', background: 'color-mix(in srgb, var(--line) 40%, transparent)', borderRadius: 999, padding: '4px 10px' }}>
          <Lock size={11} aria-hidden /> Read-only
        </span>
      </header>

      {loading && <div style={{ color: 'var(--muted)', padding: '56px 0', textAlign: 'center', fontSize: 13.5 }}>Loading permissions…</div>}

      {!loading && state === 'denied' && (
        <div style={{ ...CARD, padding: 28, color: 'var(--muted)', fontSize: 13.5 }}>
          You don’t have access to permissions (requires <code>permissions:view</code>).
        </div>
      )}

      {!loading && state === 'error' && (
        <div style={{ ...CARD, padding: 28, color: 'var(--muted)', fontSize: 13.5 }}>
          Couldn’t load permissions.
          <button type="button" onClick={load} style={{ ...FIELD, cursor: 'pointer', marginLeft: 10 }}>Retry</button>
        </div>
      )}

      {!loading && state === 'ok' && data && (
        <>
          {/* ── Role summary cards ── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 20 }}>
            {summaries.map(s => {
              const selected = mode === 'role' && s.id === activeRole
              return (
                <button
                  key={s.id} type="button"
                  onClick={() => { setMode('role'); setActiveRole(s.id) }}
                  aria-pressed={selected}
                  style={{
                    ...CARD, textAlign: 'left', cursor: 'pointer', padding: '14px 16px',
                    borderColor: selected ? 'color-mix(in srgb, var(--text) 32%, var(--line))' : 'var(--line)',
                    transition: 'border-color .15s ease',
                  }}
                >
                  <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>{s.label}</span>
                  <span style={{ display: 'block', fontSize: 22, fontWeight: 700, color: 'var(--text)', letterSpacing: '-.02em', marginTop: 6 }}>{s.granted}</span>
                  <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{roleScopeLabel(s)}</span>
                </button>
              )
            })}
          </div>

          {/* ── View switch + filters ── */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', marginBottom: 8 }}>
            <Segmented value={mode} onChange={setMode} />
            <label style={{ ...LABEL, flex: '1 1 200px' }}>Search
              <span style={{ position: 'relative', display: 'block' }}>
                <Search size={14} aria-hidden style={{ position: 'absolute', left: 11, top: 11, color: 'var(--muted)' }} />
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="Find a permission" style={{ ...FIELD, paddingLeft: 32, width: '100%' }} />
              </span>
            </label>
            <label style={{ ...LABEL }}>Area
              <select value={domain} onChange={e => setDomain(e.target.value)} style={{ ...FIELD, minWidth: 165 }}>
                <option value="">All areas</option>
                {data.domains.map(d => <option key={d.domain} value={d.domain}>{d.domain}</option>)}
              </select>
            </label>
            {mode === 'permission' && (
              <label style={{ ...LABEL }}>Role
                <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)} style={{ ...FIELD, minWidth: 140 }}>
                  <option value="">All roles</option>
                  {data.roles.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
              </label>
            )}
          </div>

          <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 14px' }}>
            {mode === 'role' && activeRole
              ? `${roleLabels[activeRole] ?? activeRole} · ${resultCountLabel(total)}`
              : resultCountLabel(total)}
          </p>

          {total === 0 ? (
            <div style={{ ...CARD, borderStyle: 'dashed', padding: 48, textAlign: 'center', color: 'var(--muted)', fontSize: 13.5 }}>
              No permissions match.
            </div>
          ) : mode === 'matrix' ? (
            <MatrixTable data={data} shown={shown} />
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {shown.map(d => (
                <DomainSection key={d.domain} d={d} roleLabels={roleLabels} open={isOpen(d.domain)} onToggle={() => toggle(d.domain)} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Matrix view ──────────────────────────────────────────────────────────────
// The grid, kept for the moment you genuinely want to compare roles side by side.
// Scrolling is contained INSIDE this box (never the page), with the permission column
// and the header row pinned so a checkmark is always readable against both its labels.
function MatrixTable({ data, shown }: { data: MatrixData; shown: Domain[] }) {
  const stickyCell: React.CSSProperties = { position: 'sticky', left: 0, background: 'var(--card)', zIndex: 1 }
  const th: React.CSSProperties = { padding: '10px 14px', fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', whiteSpace: 'nowrap', position: 'sticky', top: 0, background: 'var(--card)', zIndex: 2 }

  return (
    <div style={{ ...CARD, overflow: 'auto', maxHeight: '66vh' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 460 }}>
        <thead>
          <tr>
            <th style={{ ...th, ...stickyCell, textAlign: 'left', zIndex: 3 }}>Permission</th>
            {data.roles.map(r => <th key={r.id} style={{ ...th, textAlign: 'center' }}>{r.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {shown.map(d => (
            <Fragment key={d.domain}>
              <tr>
                <td colSpan={data.roles.length + 1} style={{ padding: '9px 14px', fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', background: 'color-mix(in srgb, var(--line) 22%, transparent)' }}>{d.domain}</td>
              </tr>
              {d.permissions.map(p => (
                <tr key={p.id}>
                  <td style={{ ...stickyCell, padding: '11px 14px', borderTop: '1px solid color-mix(in srgb, var(--line) 65%, transparent)' }}>
                    <span style={{ display: 'block', fontSize: 13, color: 'var(--text)', whiteSpace: 'nowrap' }}>{permissionLabel(p.id)}</span>
                    <span style={{ display: 'block', fontSize: 10.5, color: 'var(--muted)', fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap' }}>{p.id}</span>
                  </td>
                  {data.roles.map(r => (
                    <td key={r.id} style={{ padding: '11px 14px', textAlign: 'center', borderTop: '1px solid color-mix(in srgb, var(--line) 65%, transparent)' }}>
                      {p.grantedBy.includes(r.id)
                        ? <Check size={15} style={{ color: GRANT }} aria-label="granted" />
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
}

export default function PermissionsPage() {
  return <OperationsShell><PermissionsView /></OperationsShell>
}
