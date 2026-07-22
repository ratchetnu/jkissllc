'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, Plus, Truck, UserMinus, X } from 'lucide-react'
import { Avatar, money } from '../../ui'

// ─────────────────────────────────────────────────────────────────────────────
// Crew + equipment for a customer booking — the operational half the Book Now
// lane never had. Same vocabulary the Routes lane uses (roster crew, per-person
// pay, a truck off the equipment roster), so an owner who can crew a route
// already knows how to crew a job.
//
// FLAG-AWARE WITHOUT FLAG PLUMBING. The API 404s when BOOKING_ASSIGNMENT_ENABLED
// is off, so the panel probes once and renders NOTHING on a 404. With the flag
// off this component is invisible and the page is exactly as it was.
//
// Assigning sends nothing. There is deliberately no "text the crew" button here:
// dispatch is a separate, explicit action, as it is on a route.
// ─────────────────────────────────────────────────────────────────────────────

type Crew = {
  staffId: string
  name: string
  role: string | null
  phone: string | null
  payCents: number | null
  paySource: string | null
  confirmedAt: number | null
  declinedAt: number | null
  clockInAt: number | null
  clockOutAt: number | null
}
type Gap = { assigned: number; required: number; needsCrew: boolean; needsDriver: boolean; short: boolean; incomplete: boolean }
type Assignment = {
  crew: Crew[]
  equipmentId: string | null
  vehicle: string | null
  gap: Gap
  customerFacing: { assignedTo: string | null; assignedHelper: string | null }
}
type Staff = { id: string; name: string; role?: string; active?: boolean; photoUrl?: string }
type Equipment = { id: string; name: string; active?: boolean }

const label: React.CSSProperties = {
  fontSize: 11, fontWeight: 800, textTransform: 'uppercase',
  letterSpacing: '.06em', color: 'var(--muted)', marginBottom: 10,
}
const input: React.CSSProperties = {
  background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8,
  padding: '7px 10px', fontSize: 12.5, color: 'var(--text)', minWidth: 0,
}
const btn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700,
  border: '1px solid var(--line)', borderRadius: 8, padding: '7px 12px',
  background: 'transparent', color: 'var(--text)', cursor: 'pointer',
}

export default function CrewPanel({ token }: { token: string }) {
  const [a, setA] = useState<Assignment | null>(null)
  const [available, setAvailable] = useState(true)     // false once the API 404s (flag off)
  const [staff, setStaff] = useState<Staff[]>([])
  const [equipment, setEquipment] = useState<Equipment[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  // Add-crew form
  const [pickStaff, setPickStaff] = useState('')
  const [pickRole, setPickRole] = useState('')
  const [pickPay, setPickPay] = useState('')

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/bookings/${token}/assignment`, { credentials: 'same-origin' })
    if (res.status === 404) { setAvailable(false); return }
    if (!res.ok) { setError('Could not load crew.'); return }
    const d = await res.json()
    setA(d.assignment)
  }, [token])

  useEffect(() => { load() }, [load])

  // Rosters load only once we know the surface is live, so a flag-off page makes
  // no extra requests at all.
  useEffect(() => {
    if (!available || !a) return
    fetch('/api/admin/staff', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null)
      .then(d => setStaff((d?.staff ?? d?.data ?? []).filter((s: Staff) => s.active !== false)))
      .catch(() => {})
    fetch('/api/admin/equipment', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null)
      .then(d => setEquipment((d?.equipment ?? d?.data ?? []).filter((e: Equipment) => e.active !== false)))
      .catch(() => {})
  }, [available, a])

  const act = async (body: Record<string, unknown>, tag: string) => {
    setBusy(tag); setError('')
    try {
      const res = await fetch(`/api/admin/bookings/${token}/assignment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      })
      const d = await res.json().catch(() => null)
      if (!res.ok) { setError(d?.message ?? 'That did not work.'); return }
      setA(d.assignment)
      setPickStaff(''); setPickRole(''); setPickPay('')
    } catch {
      setError('Network error — try again.')
    } finally {
      setBusy('')
    }
  }

  if (!available || !a) return null

  const assigned = new Set(a.crew.map(c => c.staffId))
  const addable = staff.filter(s => !assigned.has(s.id))

  return (
    <div className="os-card" style={{ padding: 18, marginBottom: 14 }}>
      <div className="flex items-center justify-between gap-3" style={{ marginBottom: 10 }}>
        <p style={{ ...label, marginBottom: 0 }}>Crew &amp; Equipment</p>
        {a.gap.incomplete && (
          <span style={{ fontSize: 11, fontWeight: 700, color: '#fcd34d', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <AlertTriangle size={13} />
            {a.gap.needsCrew ? 'No crew assigned'
              : a.gap.short ? `${a.gap.assigned} of ${a.gap.required} assigned`
              : 'No driver assigned'}
          </span>
        )}
      </div>

      {/* ── Assigned crew ── */}
      {a.crew.length === 0 ? (
        <p style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>Nobody is on this job yet.</p>
      ) : (
        <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
          {a.crew.map(c => (
            <div key={c.staffId} className="flex items-center gap-3"
              style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '8px 10px', opacity: c.declinedAt ? 0.55 : 1 }}>
              <Avatar name={c.name} size={32} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{c.name}</p>
                <p style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                  {c.role || 'Crew'}
                  {c.payCents != null && <> · {money(c.payCents)}</>}
                  {c.payCents == null && <> · <span style={{ color: '#fcd34d' }}>unpriced</span></>}
                </p>
              </div>
              <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
                {c.declinedAt ? <span style={{ fontSize: 11, fontWeight: 700, color: '#f87171' }}>Declined</span>
                  : c.confirmedAt ? <span style={{ fontSize: 11, fontWeight: 700, color: '#34d399', display: 'inline-flex', alignItems: 'center', gap: 3 }}><Check size={12} />Accepted</span>
                  : <span style={{ fontSize: 11, color: 'var(--muted)' }}>Awaiting</span>}
                {c.clockInAt && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{c.clockOutAt ? 'Clocked out' : 'On the clock'}</span>}
                <button type="button" aria-label={`Remove ${c.name} from this job`}
                  disabled={!!busy}
                  onClick={() => act({ action: 'unassign_crew', staffId: c.staffId }, `rm:${c.staffId}`)}
                  style={{ ...btn, padding: '5px 8px' }}>
                  <UserMinus size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Add crew ── */}
      <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: 14 }}>
        <select value={pickStaff} onChange={e => setPickStaff(e.target.value)} style={{ ...input, flex: '1 1 160px' }} aria-label="Crew member">
          <option value="">Add crew…</option>
          {addable.map(s => <option key={s.id} value={s.id}>{s.name}{s.role ? ` · ${s.role}` : ''}</option>)}
        </select>
        <input value={pickRole} onChange={e => setPickRole(e.target.value)} placeholder="Role (Driver)" aria-label="Role on this job" style={{ ...input, flex: '0 1 130px' }} />
        <input value={pickPay} onChange={e => setPickPay(e.target.value)} placeholder="Pay (optional)" aria-label="Pay for this job" inputMode="decimal" style={{ ...input, flex: '0 1 120px' }} />
        <button type="button" disabled={!pickStaff || !!busy}
          onClick={() => act({ action: 'assign_crew', staffId: pickStaff, role: pickRole || undefined, pay: pickPay || undefined }, 'add')}
          style={{ ...btn, opacity: !pickStaff || busy ? 0.5 : 1 }}>
          <Plus size={14} /> {busy === 'add' ? 'Adding…' : 'Assign'}
        </button>
      </div>
      <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: -8, marginBottom: 14 }}>
        Leave pay blank to use their default rate. Assigning does not text anyone.
      </p>

      {/* ── Equipment ── */}
      <div className="flex flex-wrap items-center gap-2">
        <Truck size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} />
        <select
          value={a.equipmentId ?? (a.vehicle ? 'own' : '')}
          onChange={e => {
            const v = e.target.value
            if (v === 'own') act({ action: 'set_equipment', vehicleLabel: "Crew's own equipment" }, 'eq')
            else act({ action: 'set_equipment', equipmentId: v || null }, 'eq')
          }}
          disabled={!!busy}
          aria-label="Vehicle or equipment"
          style={{ ...input, flex: '1 1 200px' }}>
          <option value="">No vehicle assigned</option>
          {equipment.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
          <option value="own">Crew&apos;s own equipment</option>
        </select>
        {a.vehicle && !a.equipmentId && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{a.vehicle}</span>}
      </div>

      {/* ── What the customer sees ── */}
      {(a.customerFacing.assignedTo || a.customerFacing.assignedHelper) && (
        <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          Customer sees: <strong style={{ color: 'var(--text)' }}>{a.customerFacing.assignedTo}</strong>
          {a.customerFacing.assignedHelper && <> and <strong style={{ color: 'var(--text)' }}>{a.customerFacing.assignedHelper}</strong></>}
        </p>
      )}

      {error && (
        <p role="alert" style={{ fontSize: 12, color: '#f87171', marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <X size={13} /> {error}
        </p>
      )}
    </div>
  )
}
