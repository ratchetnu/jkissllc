'use client'

import { useCallback, useEffect, useState } from 'react'
import { Inbox, Users, Bell, Zap, BarChart3 } from 'lucide-react'
import OperationsShell from '../OperationsShell'
import { api, type TemplateDef, type DispatchActionT } from './commsShared'
import InboxView from './InboxView'
import CrewDirectory from './CrewDirectory'
import RemindersManager from './RemindersManager'
import DispatchMode from './DispatchMode'
import CommsAnalytics from './CommsAnalytics'

type Section = 'inbox' | 'crew' | 'reminders' | 'dispatch' | 'analytics'
const TABS: { id: Section; label: string; Icon: typeof Inbox }[] = [
  { id: 'inbox', label: 'Inbox', Icon: Inbox },
  { id: 'crew', label: 'Crew', Icon: Users },
  { id: 'reminders', label: 'Reminders', Icon: Bell },
  { id: 'dispatch', label: 'Dispatch', Icon: Zap },
  { id: 'analytics', label: 'Analytics', Icon: BarChart3 },
]

// The Communication Center — the Messages module reimagined as the operations comms
// hub (Inbox · Crew · Reminders · Dispatch · Analytics). One shell, section sub-nav,
// shared template/dispatch catalog loaded once. Everything feels native to OpsPilot.
function CommsCenter() {
  // Restore the last opened section within a session (lazy init — no effect needed).
  const [section, setSection] = useState<Section>(() => {
    if (typeof window === 'undefined') return 'inbox'
    const s = sessionStorage.getItem('cc:section') as Section | null
    return s && TABS.some(t => t.id === s) ? s : 'inbox'
  })
  const [templates, setTemplates] = useState<TemplateDef[]>([])
  const [dispatch, setDispatch] = useState<DispatchActionT[]>([])

  useEffect(() => {
    let alive = true
    api<{ templates: TemplateDef[]; dispatch: DispatchActionT[] }>('/api/admin/reminders/templates')
      .then(d => { if (alive) { setTemplates(d.templates); setDispatch(d.dispatch) } })
      .catch(() => { /* view still works without the catalog */ })
    return () => { alive = false }
  }, [])

  const setSectionPersist = useCallback((s: Section) => {
    setSection(s)
    try { sessionStorage.setItem('cc:section', s) } catch { /* ignore */ }
  }, [])

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <div className="os-rise" style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 12.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--muted)' }}>Communication Center</p>
        <h1 className="jkos-h" style={{ fontSize: 'clamp(26px,6vw,38px)' }}>Messages</h1>
      </div>

      <div className="cc-subnav" style={{ marginBottom: 18 }}>
        {TABS.map(t => (
          <button key={t.id} className="cc-seg" data-active={section === t.id} onClick={() => setSectionPersist(t.id)}>
            <t.Icon size={15} /> {t.label}
          </button>
        ))}
      </div>

      {section === 'inbox' && <InboxView />}
      {section === 'crew' && <CrewDirectory templates={templates} />}
      {section === 'reminders' && <RemindersManager templates={templates} />}
      {section === 'dispatch' && <DispatchMode dispatch={dispatch} />}
      {section === 'analytics' && <CommsAnalytics />}
    </div>
  )
}

export default function MessagesPage() {
  return <OperationsShell><CommsCenter /></OperationsShell>
}
