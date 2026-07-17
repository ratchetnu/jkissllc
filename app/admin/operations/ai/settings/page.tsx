'use client'

// ── AI Command Center — Settings (canonical) ─────────────────────────────────
// Owner-safe display preferences + configuration PRESENCE. Reuses /api/admin/ai-settings.
// ZERO AI. NEVER shows a secret value — only configured / missing. Editable prefs validate
// server-side and are audited; deployment-only values are shown read-only.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import OperationsShell from '../../OperationsShell'
import AICommandShell, { aiCard, aiLabel, AISkeleton, AIError, AIEmpty } from '../AICommandShell'

type Prefs = { defaultPerformanceRange: string; defaultQueueTier: string; showInformationalAlerts: boolean }
type Cfg = { key: string; label: string; status: string }
type Payload = { enabled: boolean; prefs?: Prefs; config?: Cfg[]; backgroundAlerting?: boolean }

const RANGES = ['7d', '30d', '90d']
const TIERS = [{ v: '', l: 'All' }, { v: 'needs_intervention', l: 'Intervention' }, { v: 'awaiting_review', l: 'Review' }, { v: 'missing_ground_truth', l: 'Ground truth' }, { v: 'uncategorized', l: 'Categorize' }, { v: 'ready_to_run', l: 'Run' }]
const CFG_COLOR: Record<string, string> = { configured: '#34d399', missing: '#f87171', default: '#94a3b8', invalid: '#fbbf24' }

export default function SettingsPage() {
  return <OperationsShell><AICommandShell section="settings" title="Settings"><Settings /></AICommandShell></OperationsShell>
}

function Settings() {
  const [res, setRes] = useState<{ payload: Payload | null; err: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState('')

  const load = useCallback((signal?: AbortSignal) =>
    fetch('/api/admin/ai-settings', { credentials: 'same-origin', signal })
      .then(async (r) => { if (r.status === 401 || r.status === 403) return setRes({ payload: null, err: 'Owner access required.' }); setRes({ payload: await r.json(), err: '' }) })
      .catch((e) => { if ((e as { name?: string })?.name !== 'AbortError') setRes({ payload: null, err: 'Could not load settings.' }) }), [])
  useEffect(() => { const c = new AbortController(); load(c.signal); return () => c.abort() }, [load])

  const save = async (patch: Record<string, unknown>) => {
    setSaving(true); setSaved('')
    try {
      const r = await fetch('/api/admin/ai-settings', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
      const j = await r.json().catch(() => ({}))
      if (r.ok) { setRes((p) => p?.payload ? { payload: { ...p.payload, prefs: j.prefs }, err: '' } : p); setSaved('Saved') }
      else setSaved(j.error ?? 'Could not save')
    } finally { setSaving(false) }
  }

  if (!res) return <AISkeleton rows={3} />
  if (res.err) return <AIError message={res.err} />
  const d = res.payload
  if (d && !d.enabled) return <AIEmpty title="AI evaluation is off" detail="Enable SHADOW_ANALYTICS_ENABLED to view settings." />
  if (!d?.prefs) return <AISkeleton rows={3} />
  const p = d.prefs

  return (
    <>
      {/* Editable display preferences (validated + audited server-side) */}
      <div style={{ ...aiCard, display: 'grid', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={aiLabel}>Display preferences</span>
          {saving && <span style={{ fontSize: 11, color: 'var(--muted)' }}>Saving…</span>}
          {saved && <span style={{ fontSize: 11, color: saved === 'Saved' ? '#34d399' : '#f87171' }}>{saved}</span>}
        </div>

        <Pref label="Default performance date range">
          <div style={{ display: 'inline-flex', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
            {RANGES.map((r) => <button key={r} disabled={saving} onClick={() => save({ defaultPerformanceRange: r })} style={seg(p.defaultPerformanceRange === r)}>{r}</button>)}
          </div>
        </Pref>

        <Pref label="Default queue tier on open">
          <select disabled={saving} value={p.defaultQueueTier} onChange={(e) => save({ defaultQueueTier: e.target.value })} style={{ padding: '7px 9px', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, color: 'var(--text)', fontSize: 12.5 }}>
            {TIERS.map((t) => <option key={t.v || 'all'} value={t.v}>{t.l}</option>)}
          </select>
        </Pref>

        <Pref label="Show informational alerts">
          <button disabled={saving} onClick={() => save({ showInformationalAlerts: !p.showInformationalAlerts })} style={seg(p.showInformationalAlerts)}>{p.showInformationalAlerts ? 'On' : 'Off'}</button>
        </Pref>
      </div>

      {/* Notification preferences pointer (existing owner-alerts, not duplicated here) */}
      <div style={{ ...aiCard, fontSize: 12.5, color: 'var(--muted)' }}>
        Owner notification channels (SMS/email) are managed in the existing owner-alerts settings and are not duplicated here.
        Background AI alerting is <strong style={{ color: d.backgroundAlerting ? '#34d399' : '#94a3b8' }}>{d.backgroundAlerting ? 'on' : 'off'}</strong>; the live view is in <Link href="/admin/operations/ai/alerts" style={{ color: '#93c5fd', textDecoration: 'none' }}>Alerts &amp; Readiness</Link>.
      </div>

      {/* Configuration presence — never secret values */}
      <div style={{ ...aiCard, display: 'grid', gap: 8 }}>
        <span style={aiLabel}>Configuration (presence only — no secret values shown)</span>
        {(d.config ?? []).map((c) => (
          <div key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, padding: '4px 0', borderBottom: '1px solid var(--line)' }}>
            <span style={{ flex: 1 }}>{c.label}</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: CFG_COLOR[c.status] ?? 'var(--muted)' }}>{c.status}</span>
          </div>
        ))}
        <p style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0 0' }}>Secrets and provider credentials are never displayed. Values change only through deployment configuration.</p>
      </div>
    </>
  )
}

function Pref({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}><span style={{ fontSize: 12.5 }}>{label}</span>{children}</div>
}
const seg = (on: boolean): React.CSSProperties => ({ fontSize: 12, fontWeight: 700, padding: '6px 12px', border: 'none', cursor: 'pointer', background: on ? 'var(--text)' : 'transparent', color: on ? 'var(--card)' : 'var(--muted)', borderRadius: 6 })
