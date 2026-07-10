'use client'

import { useCallback, useEffect, useState } from 'react'
import { MessageSquare, Mail, Star, Briefcase, CalendarCheck, Trash2, ScrollText, BarChart3, CalendarDays, LogOut, Check, ClipboardList, DollarSign, FileText, Wallet, EyeOff, ShieldCheck } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { osField as field } from '../ui'

type Config = { sms: boolean; email: boolean; smsTo: string; emailTo: string }
type FinanceCfg = { showPayInConfirm: boolean }

const TOOL_GROUPS: { label: string; items: { href: string; label: string; Icon: typeof Star }[] }[] = [
  { label: 'Work', items: [
    { href: '/admin/routes', label: 'Dispatch board', Icon: ClipboardList },
    { href: '/admin/operations/finance', label: 'Money', Icon: Wallet },
    { href: '/admin/routes/pay', label: 'Contractor Pay', Icon: DollarSign },
    { href: '/admin/operations/pay-statements', label: 'Pay Statements', Icon: FileText },
    { href: '/admin/routes/invoices', label: 'Client Invoices', Icon: FileText },
  ] },
  { label: 'Customers', items: [
    { href: '/admin/bookings', label: 'Bookings', Icon: CalendarDays },
    { href: '/admin/inbox', label: 'Inbox', Icon: MessageSquare },
    { href: '/admin/promos', label: 'Promos', Icon: Star },
    { href: '/admin/reviews', label: 'Reviews', Icon: Star },
  ] },
  { label: 'Team', items: [
    { href: '/admin/operations/users', label: 'Team & Access', Icon: ShieldCheck },
    { href: '/admin/careers', label: 'Careers', Icon: Briefcase },
    { href: '/admin/availability', label: 'Availability', Icon: CalendarCheck },
  ] },
  { label: 'Business', items: [
    { href: '/admin/disposal', label: 'Disposal Pricing', Icon: Trash2 },
    { href: '/admin/policy', label: 'Policy', Icon: ScrollText },
    { href: '/admin/analytics', label: 'Analytics', Icon: BarChart3 },
  ] },
]

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} onClick={() => onChange(!on)} className="os-tap"
      style={{ width: 50, height: 30, borderRadius: 999, border: 'none', cursor: 'pointer', padding: 3, background: on ? 'var(--red)' : 'rgba(255,255,255,.14)', transition: 'background .2s var(--os-ease)', flexShrink: 0 }}>
      <span style={{ display: 'block', width: 24, height: 24, borderRadius: 999, background: '#fff', transform: on ? 'translateX(20px)' : 'translateX(0)', transition: 'transform .2s var(--os-spring)' }} />
    </button>
  )
}

function Settings() {
  const [cfg, setCfg] = useState<Config | null>(null)
  const [fin, setFin] = useState<FinanceCfg | null>(null)
  const [finBusy, setFinBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    try {
      const [a, f] = await Promise.all([
        fetch('/api/admin/alerts', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({})),
        fetch('/api/admin/finance', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({})),
      ])
      if (a.config) setCfg(a.config)
      if (f.settings) setFin(f.settings)
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  // Optimistic, with rollback — a failed write must not leave the switch lying
  // about whether drivers can see their pay.
  async function setShowPay(v: boolean) {
    const prev = fin
    setFin({ showPayInConfirm: v }); setFinBusy(true)
    try {
      const res = await fetch('/api/admin/finance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ showPayInConfirm: v }) })
      const d = await res.json()
      if (!res.ok || !d.settings) setFin(prev)
      else setFin(d.settings)
    } catch { setFin(prev) } finally { setFinBusy(false) }
  }

  async function save() {
    if (!cfg) return
    setSaving(true); setSaved(false)
    try {
      const d = await fetch('/api/admin/alerts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(cfg) }).then(r => r.json())
      if (d.config) { setCfg(d.config); setSaved(true); setTimeout(() => setSaved(false), 2500) }
    } finally { setSaving(false) }
  }
  const set = (patch: Partial<Config>) => setCfg(c => c ? { ...c, ...patch } : c)

  async function signOut() { try { await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }) } catch {} location.href = '/admin/operations' }

  return (
    <div style={{ maxWidth: 600, margin: '0 auto' }}>
      <div className="os-rise" style={{ marginBottom: 22 }}>
        <h1 className="jkos-h" style={{ fontSize: 'clamp(28px,6vw,40px)' }}>Settings</h1>
      </div>

      {/* Notifications */}
      <div className="os-card os-rise" style={{ padding: 22, marginBottom: 16 }}>
        <h2 className="jkos-h" style={{ fontSize: 18, marginBottom: 4 }}>Notify me</h2>
        <p style={{ fontSize: 13.5, color: 'var(--muted)', marginBottom: 18 }}>When a contractor declines or ignores a route, or a customer replies, we’ll reach you here.</p>

        {loading || !cfg ? (
          <div className="skeleton" style={{ width: '100%', height: 52, borderRadius: 12 }} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <MessageSquare size={18} style={{ color: 'var(--red-glow)' }} />
                <div style={{ flex: 1 }}><div style={{ fontWeight: 700, fontSize: 15 }}>Text me</div><div style={{ fontSize: 12.5, color: 'var(--muted)' }}>SMS alerts</div></div>
                <Toggle on={cfg.sms} onChange={v => set({ sms: v })} />
              </div>
              {cfg.sms && <input placeholder="Your phone (e.g. +18179094312)" value={cfg.smsTo} onChange={e => set({ smsTo: e.target.value })} style={{ ...field, marginTop: 10 }} />}
            </div>
            <div style={{ height: 1, background: 'var(--line)' }} />
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Mail size={18} style={{ color: 'var(--red-glow)' }} />
                <div style={{ flex: 1 }}><div style={{ fontWeight: 700, fontSize: 15 }}>Email me</div><div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Email alerts</div></div>
                <Toggle on={cfg.email} onChange={v => set({ email: v })} />
              </div>
              {cfg.email && <input placeholder="Your email" value={cfg.emailTo} onChange={e => set({ emailTo: e.target.value })} style={{ ...field, marginTop: 10 }} />}
            </div>

            <button onClick={save} disabled={saving} className="btn os-tap" style={{ borderRadius: 12, height: 46, justifyContent: 'center', marginTop: 4 }}>
              {saved ? <><Check size={17} /> Saved</> : saving ? 'Saving…' : 'Save preferences'}
            </button>
          </div>
        )}
      </div>

      {/* Crew pay visibility */}
      <div className="os-card os-rise" style={{ padding: 22, marginBottom: 16 }}>
        <h2 className="jkos-h" style={{ fontSize: 18, marginBottom: 4 }}>Crew pay visibility</h2>
        <p style={{ fontSize: 13.5, color: 'var(--muted)', marginBottom: 18 }}>Controls what a driver or helper sees in their assignment text and on their confirmation page.</p>

        {loading || !fin ? (
          <div className="skeleton" style={{ width: '100%', height: 52, borderRadius: 12 }} />
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <DollarSign size={18} style={{ color: 'var(--red-glow)' }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>Show their pay amount</div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Each person sees only their own pay for that route.</div>
              </div>
              <div style={{ opacity: finBusy ? .5 : 1 }}><Toggle on={fin.showPayInConfirm} onChange={setShowPay} /></div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 16, padding: '11px 13px', borderRadius: 11, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
              <EyeOff size={15} style={{ color: 'var(--muted)', flexShrink: 0, marginTop: 2 }} />
              <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                Crew <b style={{ color: 'var(--text)' }}>never</b> see what the business pays, this route&rsquo;s profit, or another crew member&rsquo;s pay — regardless of this setting.
              </div>
            </div>
          </>
        )}
      </div>

      {/* More tools */}
      <div className="os-card os-rise" style={{ padding: 22, marginBottom: 16 }}>
        <h2 className="jkos-h" style={{ fontSize: 18, marginBottom: 4 }}>More tools</h2>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>Everything else, a tap away.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {TOOL_GROUPS.map(g => (
            <div key={g.label}>
              <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }}>{g.label}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
                {g.items.map(t => (
                  <a key={t.href} href={t.href} className="os-tap" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 14px', borderRadius: 13, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)', textDecoration: 'none', color: 'var(--text)', fontWeight: 600, fontSize: 14 }}>
                    <t.Icon size={17} style={{ color: 'var(--muted)', flexShrink: 0 }} /> {t.label}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Account */}
      <div className="os-card os-rise" style={{ padding: 22 }}>
        <h2 className="jkos-h" style={{ fontSize: 18, marginBottom: 14 }}>Account</h2>
        <button onClick={signOut} className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '11px 16px', borderRadius: 12, background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', color: '#fca5a5', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
          <LogOut size={16} /> Sign out
        </button>
      </div>
    </div>
  )
}

export default function SettingsPage() {
  return <OperationsShell><Settings /></OperationsShell>
}
