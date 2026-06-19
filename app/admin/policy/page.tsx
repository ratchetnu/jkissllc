'use client'

import { useState, useEffect, useCallback } from 'react'
import AdminGate from '../AdminGate'

type Policy = { version: number; text: string; updatedAt: number }

function PolicyEditor() {
  const [current, setCurrent] = useState<Policy | null>(null)
  const [versions, setVersions] = useState<Policy[]>([])
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const res = await fetch('/api/admin/policy', { credentials: 'same-origin' })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'Failed')
      setCurrent(j.current); setVersions(j.versions ?? []); setText(j.current?.text ?? '')
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function save() {
    setSaving(true); setMsg(''); setErr('')
    try {
      const res = await fetch('/api/admin/policy', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'Failed')
      setMsg(`Saved as v${j.policy.version}. New bookings will use this version.`)
      await load()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
    finally { setSaving(false) }
  }

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-2xl font-black text-white mb-1" style={{ letterSpacing: '-0.03em' }}>Cancellation &amp; Refund Policy</h1>
      <p className="text-sm mb-6" style={{ color: 'var(--muted)' }}>
        Edit the policy customers must accept. Saving creates a new version; older bookings keep the version they accepted.
        {current && <> Current: <strong className="text-white">v{current.version}</strong>{current.updatedAt ? ` · updated ${new Date(current.updatedAt).toLocaleString()}` : ' (built-in default)'}.</>}
      </p>

      {loading ? <p className="text-sm" style={{ color: 'var(--muted)' }}>Loading…</p> : (
        <>
          <textarea value={text} onChange={e => setText(e.target.value)} rows={22}
            className="w-full p-4 font-mono text-sm"
            style={{ background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.1)', borderRadius: '12px', color: '#f3f4f6', outline: 'none', resize: 'vertical', lineHeight: 1.5 }} />
          {msg && <p className="text-sm mt-3" style={{ color: '#34d399' }}>{msg}</p>}
          {err && <p className="text-sm mt-3" style={{ color: '#f87171' }}>{err}</p>}
          <div className="flex gap-3 mt-4">
            <button onClick={save} disabled={saving} className="btn">{saving ? 'Saving…' : 'Save New Version'}</button>
            <button onClick={() => setText(current?.text ?? '')} className="btn-ghost">Reset</button>
          </div>

          {versions.length > 1 && (
            <div className="mt-8">
              <p className="text-sm font-bold text-white mb-3">Version History</p>
              <div className="space-y-2">
                {versions.map(v => (
                  <details key={v.version} className="glass-card p-4" style={{ borderRadius: '12px' }}>
                    <summary className="cursor-pointer text-sm font-semibold" style={{ color: 'var(--text)' }}>
                      v{v.version} {v.updatedAt ? `· ${new Date(v.updatedAt).toLocaleDateString()}` : '· built-in default'}
                    </summary>
                    <pre className="mt-3 text-xs whitespace-pre-wrap" style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5 }}>{v.text}</pre>
                  </details>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default function PolicyPage() {
  return <AdminGate title="Policy"><PolicyEditor /></AdminGate>
}
