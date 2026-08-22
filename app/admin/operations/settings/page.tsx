'use client'

import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { MessageSquare, Mail, Star, Briefcase, CalendarCheck, Trash2, ScrollText, BarChart3, CalendarDays, LogOut, Check, ClipboardList, DollarSign, FileText, Wallet, EyeOff, ShieldCheck, Sparkles, MapPin, Bell, Users, Building2, SlidersHorizontal, Grid2X2, ChevronRight } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import CapabilitiesPanel from './CapabilitiesPanel'
import { osField as field, AccessDenied, DataError } from '../ui'
import { accessStateForStatus, type LoadState } from '../../../lib/access-state'
import styles from './settings.module.css'

type Config = { sms: boolean; email: boolean; smsTo: string; emailTo: string }
type FinanceCfg = { showPayInConfirm: boolean }
type AutoCfg = { confirmationReminders: boolean; morningReminders: boolean }
type BusinessAddress = { line1: string; line2?: string; city: string; state: string; postalCode: string }

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
    { href: '/admin/operations/ai', label: 'AI Command Center', Icon: Sparkles },
  ] },
]

type SettingsSection = 'notifications' | 'crew' | 'business' | 'features' | 'tools' | 'account'

const SETTINGS_SECTIONS: { id: SettingsSection; label: string; description: string; Icon: typeof Bell; color: string }[] = [
  { id: 'notifications', label: 'Notifications', description: 'Owner alerts', Icon: Bell, color: '#0a84ff' },
  { id: 'crew', label: 'Crew', description: 'Reminders & pay', Icon: Users, color: '#30d158' },
  { id: 'business', label: 'Business', description: 'Company details', Icon: Building2, color: '#ff9f0a' },
  { id: 'features', label: 'Features', description: 'Optional tools', Icon: SlidersHorizontal, color: '#bf5af2' },
  { id: 'tools', label: 'More tools', description: 'Quick links', Icon: Grid2X2, color: '#64d2ff' },
  { id: 'account', label: 'Account', description: 'Session', Icon: ShieldCheck, color: '#ff453a' },
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
  const [activeSection, setActiveSection] = useState<SettingsSection>('notifications')
  const [cfg, setCfg] = useState<Config | null>(null)
  const [fin, setFin] = useState<FinanceCfg | null>(null)
  const [auto, setAuto] = useState<AutoCfg | null>(null)
  const [businessAddress, setBusinessAddress] = useState<BusinessAddress | null>(null)
  const [addressBusy, setAddressBusy] = useState(false)
  const [addressSaved, setAddressSaved] = useState(false)
  const [addressError, setAddressError] = useState('')
  const [finBusy, setFinBusy] = useState(false)
  // Settings is governed by `settings:manage`, which a manager does not hold
  // (app/lib/rbac.ts). Both /api/admin/alerts and /api/admin/finance refuse them, and
  // every write on this page is admin-only — /api/admin/reminder-settings answers a manager's
  // GET but rejects the POST, so rendering its toggles would offer switches that
  // silently roll back. The page is therefore denied as a whole, not section by section.
  const [state, setState] = useState<LoadState>('loading')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    setState('loading')
    try {
      const [aRes, fRes, auRes, addressRes] = await Promise.all([
        fetch('/api/admin/alerts', { credentials: 'same-origin' }),
        fetch('/api/admin/finance', { credentials: 'same-origin' }),
        fetch('/api/admin/reminder-settings', { credentials: 'same-origin' }),
        fetch('/api/admin/business-address', { credentials: 'same-origin' }),
      ])
      // The refusal is the answer. Terminal — no retry, no spinner left running.
      if (accessStateForStatus(aRes.status) === 'denied') { setState('denied'); return }
      if (!aRes.ok) { setState('error'); return }
      if (!addressRes.ok) { setState('error'); return }
      const [a, f, au, addressData] = await Promise.all([
        aRes.json().catch(() => ({})),
        fRes.ok ? fRes.json().catch(() => ({})) : Promise.resolve({}),
        auRes.ok ? auRes.json().catch(() => ({})) : Promise.resolve({}),
        addressRes.json().catch(() => ({})),
      ])
      if (a.config) setCfg(a.config)
      if (f.settings) setFin(f.settings)
      if (au.settings) setAuto(au.settings)
      if (addressData.address) setBusinessAddress(addressData.address)
      setState('ready')
    } catch { setState('error') }
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

  // Toggle a crew-reminder automation switch. Optimistic with rollback.
  async function setAutoFlag(patch: Partial<AutoCfg>) {
    const prev = auto
    setAuto(a => (a ? { ...a, ...patch } : a))
    try {
      const res = await fetch('/api/admin/reminder-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(patch) })
      const d = await res.json()
      if (!res.ok || !d.settings) setAuto(prev); else setAuto(d.settings)
    } catch { setAuto(prev) }
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

  async function saveBusinessAddress() {
    if (!businessAddress) return
    setAddressBusy(true); setAddressSaved(false); setAddressError('')
    try {
      const res = await fetch('/api/admin/business-address', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify(businessAddress),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.address) { setAddressError(data.error ?? 'Couldn’t save the business address.'); return }
      setBusinessAddress(data.address); setAddressSaved(true); setTimeout(() => setAddressSaved(false), 2500)
    } catch { setAddressError('Couldn’t save the business address.') } finally { setAddressBusy(false) }
  }

  const setAddress = (patch: Partial<BusinessAddress>) => setBusinessAddress(current => current ? { ...current, ...patch } : current)

  async function signOut() { try { await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }) } catch {} location.href = '/admin/operations' }

  return (
    <div className={styles.settingsPage}>
      <div className={`${styles.settingsHeader} os-rise`}>
        <h1 className="jkos-h" style={{ fontSize: 'clamp(28px,6vw,40px)' }}>Settings</h1>
        <p className={styles.settingsIntro}>Choose a category, then make changes in one focused place. Your software updates stay independent from optional providers and integrations.</p>
      </div>

      {state === 'denied' ? (
        <AccessDenied
          title="Admins only"
          detail="Settings is restricted to administrators. Notification preferences, crew reminders and crew pay visibility are configured by an admin. You can still sign out from the account menu."
          requirement="the Admin role"
        />
      ) : state === 'error' ? (
        <DataError title="Couldn’t load Settings" detail="The settings could not be loaded." onRetry={load} />
      ) : (
      <div className={styles.settingsLayout}>
      <nav className={styles.settingsNav} aria-label="Settings categories">
        {SETTINGS_SECTIONS.map(section => (
          <button
            key={section.id}
            type="button"
            aria-pressed={activeSection === section.id}
            aria-controls="settings-panel"
            className={`${styles.navButton} os-tap`}
            onClick={() => setActiveSection(section.id)}
          >
            <span className={styles.navIcon} style={{ '--nav-color': section.color } as CSSProperties}><section.Icon size={17} /></span>
            <span><span style={{ display: 'block' }}>{section.label}</span><span style={{ display: 'block', color: 'var(--muted)', fontSize: 11.5, fontWeight: 550, marginTop: 1 }}>{section.description}</span></span>
            <ChevronRight size={14} style={{ color: 'var(--muted)' }} />
          </button>
        ))}
      </nav>

      <section className={styles.panel} id="settings-panel" aria-label={SETTINGS_SECTIONS.find(section => section.id === activeSection)?.label}>
      {/* Notifications */}
      {activeSection === 'notifications' && <div className={styles.cardStack}>
      <div className={styles.panelHeading}><h2 className="jkos-h" style={{ fontSize: 22 }}>Notifications</h2><p>Decide how owner alerts reach you.</p></div>
      <div className="os-card os-rise" style={{ padding: 22 }}>
        <h2 className="jkos-h" style={{ fontSize: 18, marginBottom: 4 }}>Notify me</h2>
        <p style={{ fontSize: 13.5, color: 'var(--muted)', marginBottom: 18 }}>When a contractor declines or ignores a route, or a customer replies, we’ll reach you here.</p>

        {state === 'loading' || !cfg ? (
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
      </div>}

      {/* Crew reminders (daily automation) */}
      {activeSection === 'crew' && <div className={styles.cardStack}>
      <div className={styles.panelHeading}><h2 className="jkos-h" style={{ fontSize: 22 }}>Crew</h2><p>Automations and information shown to your field team.</p></div>
      <div className="os-card os-rise" style={{ padding: 22 }}>
        <h2 className="jkos-h" style={{ fontSize: 18, marginBottom: 4 }}>Crew reminders</h2>
        <p style={{ fontSize: 13.5, color: 'var(--muted)', marginBottom: 18 }}>Automatic text reminders sent to crew each morning (9am Central). Owner alerts about unconfirmed routes still come through either way.</p>
        {state === 'loading' || !auto ? (
          <div className="skeleton" style={{ width: '100%', height: 52, borderRadius: 12 }} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <CalendarCheck size={18} style={{ color: 'var(--red-glow)' }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>Confirmation reminders</div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Nudge crew who haven’t confirmed a route yet (today or tomorrow).</div>
              </div>
              <Toggle on={auto.confirmationReminders} onChange={v => setAutoFlag({ confirmationReminders: v })} />
            </div>
            <div style={{ height: 1, background: 'var(--line)' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <MessageSquare size={18} style={{ color: 'var(--red-glow)' }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>Morning-of reminders</div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Remind crew who already confirmed a route happening today.</div>
              </div>
              <Toggle on={auto.morningReminders} onChange={v => setAutoFlag({ morningReminders: v })} />
            </div>
          </div>
        )}
      </div>

      {/* Crew pay visibility */}
      <div className="os-card os-rise" style={{ padding: 22 }}>
        <h2 className="jkos-h" style={{ fontSize: 18, marginBottom: 4 }}>Crew pay visibility</h2>
        <p style={{ fontSize: 13.5, color: 'var(--muted)', marginBottom: 18 }}>Controls what a driver or helper sees in their assignment text and on their confirmation page.</p>

        {state === 'loading' || !fin ? (
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
      </div>}

      {/* Business address */}
      {activeSection === 'business' && <div className={styles.cardStack}>
      <div className={styles.panelHeading}><h2 className="jkos-h" style={{ fontSize: 22 }}>Business</h2><p>Company information used on statements and documents.</p></div>
      <div className="os-card os-rise" style={{ padding: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <MapPin size={18} style={{ color: 'var(--red-glow)' }} />
          <h2 className="jkos-h" style={{ fontSize: 18, margin: 0 }}>Business address</h2>
        </div>
        <p style={{ fontSize: 13.5, color: 'var(--muted)', marginBottom: 18 }}>Shown on pay statements and other company documents. Only administrators can update it.</p>
        {state === 'loading' || !businessAddress ? (
          <div className="skeleton" style={{ width: '100%', height: 150, borderRadius: 12 }} />
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            <label style={{ fontSize: 12, fontWeight: 700 }}>Street address
              <input value={businessAddress.line1} onChange={e => setAddress({ line1: e.target.value })} autoComplete="street-address" style={{ ...field, marginTop: 6 }} />
            </label>
            <label style={{ fontSize: 12, fontWeight: 700 }}>Suite or unit <span style={{ color: 'var(--muted)', fontWeight: 500 }}>(optional)</span>
              <input value={businessAddress.line2 ?? ''} onChange={e => setAddress({ line2: e.target.value })} style={{ ...field, marginTop: 6 }} />
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.4fr) minmax(72px,.5fr) minmax(100px,.7fr)', gap: 10 }}>
              <label style={{ fontSize: 12, fontWeight: 700 }}>City
                <input value={businessAddress.city} onChange={e => setAddress({ city: e.target.value })} autoComplete="address-level2" style={{ ...field, marginTop: 6 }} />
              </label>
              <label style={{ fontSize: 12, fontWeight: 700 }}>State
                <input value={businessAddress.state} onChange={e => setAddress({ state: e.target.value.toUpperCase().slice(0, 2) })} autoComplete="address-level1" style={{ ...field, marginTop: 6 }} />
              </label>
              <label style={{ fontSize: 12, fontWeight: 700 }}>ZIP
                <input value={businessAddress.postalCode} onChange={e => setAddress({ postalCode: e.target.value })} autoComplete="postal-code" inputMode="numeric" style={{ ...field, marginTop: 6 }} />
              </label>
            </div>
            {addressError && <p role="alert" style={{ color: '#fca5a5', fontSize: 13, margin: 0 }}>{addressError}</p>}
            <button onClick={saveBusinessAddress} disabled={addressBusy} className="btn os-tap" style={{ borderRadius: 12, height: 46, justifyContent: 'center', marginTop: 4 }}>
              {addressSaved ? <><Check size={17} /> Saved</> : addressBusy ? 'Saving…' : 'Save business address'}
            </button>
          </div>
        )}
      </div>
      </div>}

      {/* More tools */}
      {activeSection === 'tools' && <div className={styles.cardStack}>
      <div className={styles.panelHeading}><h2 className="jkos-h" style={{ fontSize: 22 }}>More tools</h2><p>Quick links to the rest of your operation.</p></div>
      <div className="os-card os-rise" style={{ padding: 22 }}>
        <h2 className="jkos-h" style={{ fontSize: 18, marginBottom: 4 }}>More tools</h2>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>Everything else, a tap away.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {TOOL_GROUPS.map(g => (
            <div key={g.label}>
              <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }}>{g.label}</div>
              <div className={styles.toolGrid}>
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
      </div>}

      {activeSection === 'features' && <CapabilitiesPanel />}

      {/* Account */}
      {activeSection === 'account' && <div className={styles.cardStack}>
      <div className={styles.panelHeading}><h2 className="jkos-h" style={{ fontSize: 22 }}>Account</h2><p>Manage this signed-in session.</p></div>
      <div className="os-card os-rise" style={{ padding: 22 }}>
        <h2 className="jkos-h" style={{ fontSize: 18, marginBottom: 14 }}>Account</h2>
        <button onClick={signOut} className="os-tap" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '11px 16px', borderRadius: 12, background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', color: '#fca5a5', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
          <LogOut size={16} /> Sign out
        </button>
      </div>
      </div>}
      </section>
      </div>
      )}
    </div>
  )
}

export default function SettingsPage() {
  return <OperationsShell><Settings /></OperationsShell>
}
