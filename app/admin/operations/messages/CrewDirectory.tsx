'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Search, Send, CheckSquare, Square, Users, Bookmark, X } from 'lucide-react'
import { Avatar } from '../ui'
import ComposeSheet from './ComposeSheet'
import {
  api, relTime, SEGMENTS, loadGroups, saveGroups,
  type CrewCardT, type TemplateDef, type SavedGroup,
} from './commsShared'

// The Crew directory inside Messages (request Part 1). Replaces the flat employee
// list: search, dynamic segments with live counts, multi-select (+ select-all /
// clear / saved groups), and a rich status card per crew member — then one tap to
// message the selection through the Command Center.
export default function CrewDirectory({ templates }: { templates: TemplateDef[] }) {
  const [crew, setCrew] = useState<CrewCardT[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [seg, setSeg] = useState('all')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [groups, setGroups] = useState<SavedGroup[]>([])
  const [composing, setComposing] = useState(false)
  const [toast, setToast] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await api<{ crew: CrewCardT[]; counts: Record<string, number> }>('/api/admin/crew-directory')
      setCrew(d.crew); setCounts(d.counts)
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { load(); setGroups(loadGroups()) }, [load])

  const shown = useMemo(() => {
    const query = q.trim().toLowerCase()
    return crew
      .filter(c => seg === 'all' || c.flags.includes(seg))
      .filter(c => !query || c.name.toLowerCase().includes(query) || c.businessNames.join(' ').toLowerCase().includes(query) || (c.role || '').toLowerCase().includes(query))
  }, [crew, seg, q])

  const toggle = (id: string) => setSel(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const selectAllShown = () => setSel(new Set(shown.map(c => c.id)))
  const clear = () => setSel(new Set())

  function applyGroup(g: SavedGroup) { setSel(new Set(g.ids.filter(id => crew.some(c => c.id === id)))) }
  function saveCurrent() {
    if (!sel.size) return
    const name = prompt('Name this group:')?.trim()
    if (!name) return
    const next = [{ name, ids: [...sel] }, ...groups.filter(g => g.name !== name)]
    setGroups(next); saveGroups(next)
  }
  function removeGroup(name: string) { const next = groups.filter(g => g.name !== name); setGroups(next); saveGroups(next) }

  const selNames = crew.filter(c => sel.has(c.id)).map(c => c.name)
  const recipientLabel = sel.size === 1 ? (selNames[0] || '1 crew') : `${sel.size} crew`

  return (
    <div>
      {/* Search */}
      <div style={{ position: 'relative', marginBottom: 12 }}>
        <Search size={16} style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search crew, business, role…"
          style={{ width: '100%', padding: '11px 14px 11px 38px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 12, color: 'var(--text)', fontSize: 15, outline: 'none' }} />
      </div>

      {/* Segment chips with live counts */}
      <div className="cc-subnav" style={{ marginBottom: 14 }}>
        {SEGMENTS.map(s => (
          <button key={s.id} className="cc-seg" data-active={seg === s.id} onClick={() => setSeg(s.id)}>
            {s.label}{counts[s.id] != null && <span className="cc-seg-badge">{counts[s.id]}</span>}
          </button>
        ))}
      </div>

      {/* Saved + recent groups */}
      {groups.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
          <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>Saved</span>
          {groups.map(g => (
            <span key={g.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 6px 5px 11px', borderRadius: 999, border: '1px solid var(--line)', background: 'rgba(255,255,255,.04)', fontSize: 12.5, fontWeight: 700 }}>
              <button onClick={() => applyGroup(g)} className="os-tap" style={{ background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Bookmark size={12} /> {g.name} <span style={{ color: 'var(--muted)' }}>{g.ids.length}</span></button>
              <button onClick={() => removeGroup(g.name)} aria-label="Remove group" style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', display: 'grid', placeItems: 'center' }}><X size={12} /></button>
            </span>
          ))}
        </div>
      )}

      {/* Bulk toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <button onClick={selectAllShown} className="os-tap" style={miniBtn}><CheckSquare size={14} /> Select all ({shown.length})</button>
        {sel.size > 0 && <button onClick={clear} className="os-tap" style={miniBtn}><Square size={14} /> Clear</button>}
        {sel.size > 0 && <button onClick={saveCurrent} className="os-tap" style={miniBtn}><Bookmark size={14} /> Save group</button>}
        <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--muted)' }}>{shown.length} crew</span>
      </div>

      {/* Crew grid */}
      {loading ? (
        <div className="cc-crew-grid">{[0, 1, 2, 3].map(i => <div key={i} className="os-card" style={{ height: 120 }}><div className="skeleton" style={{ width: '60%', height: 16, margin: 16, borderRadius: 8 }} /></div>)}</div>
      ) : shown.length === 0 ? (
        <div className="os-card os-rise" style={{ padding: 40, textAlign: 'center' }}>
          <Users size={30} style={{ color: 'var(--muted)' }} />
          <p className="jkos-h" style={{ fontSize: 18, marginTop: 10 }}>No crew match</p>
          <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 4 }}>Try a different segment or clear your search.</p>
        </div>
      ) : (
        <div className="cc-crew-grid">
          {shown.map((c, i) => <CrewCard key={c.id} c={c} selected={sel.has(c.id)} onToggle={() => toggle(c.id)} delay={i} />)}
        </div>
      )}

      {/* Sticky send bar */}
      {sel.size > 0 && (
        <div className="os-glass" style={{ position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: 'calc(88px + env(safe-area-inset-bottom))', zIndex: 45, borderRadius: 999, padding: '9px 9px 9px 18px', display: 'flex', alignItems: 'center', gap: 12, boxShadow: 'var(--os-shadow)' }}>
          <span style={{ fontSize: 14, fontWeight: 800 }}>{sel.size} selected</span>
          <button onClick={() => setComposing(true)} className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'var(--red)', color: '#fff', border: 'none', borderRadius: 999, padding: '10px 18px', fontSize: 14, fontWeight: 800, cursor: 'pointer' }}>
            <Send size={16} /> Message
          </button>
        </div>
      )}

      {composing && (
        <ComposeSheet
          recipientIds={[...sel]} recipientLabel={recipientLabel} templates={templates}
          onClose={() => setComposing(false)}
          onSent={(n) => { setComposing(false); clear(); setToast(`Sent to ${n} crew`); setTimeout(() => setToast(''), 3000); load() }}
        />
      )}

      {toast && <div className="os-glass" style={{ position: 'fixed', bottom: 'calc(150px + env(safe-area-inset-bottom))', left: '50%', transform: 'translateX(-50%)', zIndex: 80, padding: '10px 18px', borderRadius: 999, fontSize: 14, fontWeight: 700 }}>{toast}</div>}
    </div>
  )
}

const miniBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', fontSize: 12.5, fontWeight: 700, borderRadius: 10, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--muted)', cursor: 'pointer' }

function Dot({ ok, warn, label }: { ok?: boolean; warn?: boolean; label: string }) {
  const color = ok ? '#86efac' : warn ? '#fcd34d' : '#6b7280'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--muted)' }}>
      <span className="cc-dot" style={{ background: color }} /> {label}
    </span>
  )
}

function CrewCard({ c, selected, onToggle, delay }: { c: CrewCardT; selected: boolean; onToggle: () => void; delay: number }) {
  const route = c.todayRoutes[0] || c.upcomingRoutes[0]
  return (
    <button onClick={onToggle} className="os-card os-rise os-tap" style={{ textAlign: 'left', cursor: 'pointer', padding: 14, animationDelay: `${Math.min(delay * 25, 200)}ms`, border: `1px solid ${selected ? 'var(--red)' : 'var(--line)'}`, background: selected ? 'color-mix(in srgb, var(--red) 8%, transparent)' : undefined, position: 'relative' }}>
      <div style={{ display: 'flex', gap: 11, alignItems: 'center' }}>
        <div style={{ position: 'relative' }}>
          <Avatar name={c.name} photoUrl={c.photoUrl} size={44} />
          {c.activeNow && <span style={{ position: 'absolute', right: -1, bottom: -1, width: 12, height: 12, borderRadius: 99, background: '#22c55e', border: '2px solid var(--card)' }} />}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontWeight: 800, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
            {c.onTimeOff && <span style={{ fontSize: 10, fontWeight: 800, padding: '1px 6px', borderRadius: 99, background: 'rgba(148,163,184,.2)', color: '#cbd5e1' }}>OFF</span>}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {c.businessNames[0] || c.role || 'No assignment'}{route ? ` · ${route.routeNumber}` : ''}
          </div>
        </div>
        <span style={{ display: 'grid', placeItems: 'center', width: 24, height: 24, borderRadius: 7, border: `1.5px solid ${selected ? 'var(--red)' : 'var(--line)'}`, background: selected ? 'var(--red)' : 'transparent', color: '#fff', flexShrink: 0 }}>
          {selected && <CheckSquare size={14} />}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 11 }}>
        {c.hasActiveRouteToday && <Dot ok={c.confirmed === true} warn={c.confirmed === false} label={c.confirmed === true ? 'Confirmed' : c.confirmed === false ? 'Unconfirmed' : 'No route'} />}
        {c.hasActiveRouteToday && <Dot ok={c.clockIn === 'in' || c.clockIn === 'out'} warn={c.clockIn === 'none'} label={c.clockIn === 'out' ? 'Clocked out' : c.clockIn === 'in' ? 'Clocked in' : c.clockIn === 'none' ? 'Not clocked in' : 'No clock'} />}
        {c.hasActiveRouteToday && <Dot ok={c.uniform} warn={!c.uniform} label={c.uniform ? 'Uniform ✓' : 'No uniform'} />}
        <Dot ok={c.availabilitySubmitted} warn={!c.availabilitySubmitted} label={c.availabilitySubmitted ? 'Avail ✓' : 'No avail'} />
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)' }}>
        Last activity {relTime(c.lastActivityAt)} · Last response {relTime(c.lastResponseAt)}
      </div>
    </button>
  )
}
