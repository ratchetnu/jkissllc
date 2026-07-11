'use client'

import { useCallback, useEffect, useState } from 'react'

type Data = {
  title: string; message: string
  ackOptions: string[]; ackLabels: Record<string, string>
  ackedKind: string | null; completedAt: number | null
  staffName: string; sentAt: number
}

const TONE: Record<string, { bg: string; fg: string }> = {
  completed: { bg: '#16a34a', fg: '#fff' },
  already_done: { bg: '#16a34a', fg: '#fff' },
  acknowledged: { bg: '#2563eb', fg: '#fff' },
  calling: { bg: '#E0002A', fg: '#fff' },
  need_help: { bg: '#f59e0b', fg: '#111' },
  having_issues: { bg: '#f59e0b', fg: '#111' },
  unable: { bg: '#6b7280', fg: '#fff' },
}

export default function AckClient({ token }: { token: string }) {
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/ack/${token}`)
      if (!r.ok) { setError('This link is no longer valid.'); return }
      const d = await r.json() as Data
      setData(d)
      if (d.ackedKind) setDone(d.ackedKind)
    } catch { setError('Something went wrong. Please try again.') }
    finally { setLoading(false) }
  }, [token])
  useEffect(() => { load() }, [load])

  async function ack(kind: string) {
    setBusy(kind)
    try {
      const r = await fetch(`/api/ack/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }) })
      if (r.ok) setDone(kind)
      else setError('Could not record your response. Please try again.')
    } catch { setError('Could not record your response. Please try again.') }
    finally { setBusy('') }
  }

  return (
    <main style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 20, background: 'linear-gradient(180deg,#0b0b0c,#161618)', color: '#f3f4f6', fontFamily: '-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif' }}>
      <div style={{ width: '100%', maxWidth: 440, background: '#121214', border: '1px solid rgba(255,255,255,.1)', borderRadius: 22, padding: 26, boxShadow: '0 20px 60px rgba(0,0,0,.5)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <span style={{ width: 9, height: 9, borderRadius: 99, background: 'var(--red)' }} />
          <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: '#b5b7bd' }}>Dispatch</span>
        </div>

        {loading ? (
          <p style={{ color: '#b5b7bd' }}>Loading…</p>
        ) : error ? (
          <p style={{ color: '#fca5a5', fontSize: 16 }}>{error}</p>
        ) : data ? (
          <>
            <h1 style={{ fontSize: 24, fontWeight: 900, margin: '0 0 8px', letterSpacing: '-.02em' }}>{data.title}</h1>
            <p style={{ fontSize: 16, lineHeight: 1.5, color: '#d1d5db', margin: '0 0 22px' }}>{data.message}</p>

            {done ? (
              <div style={{ textAlign: 'center', padding: '18px 0' }}>
                <div style={{ width: 56, height: 56, borderRadius: 99, margin: '0 auto 12px', display: 'grid', placeItems: 'center', background: (TONE[done]?.bg || '#16a34a'), color: TONE[done]?.fg || '#fff', fontSize: 28, fontWeight: 900 }}>✓</div>
                <p style={{ fontSize: 18, fontWeight: 800 }}>{data.ackLabels[done] || 'Got it'}</p>
                <p style={{ color: '#b5b7bd', fontSize: 14, marginTop: 4 }}>Your response was recorded. Thank you, {data.staffName.split(' ')[0]}.</p>
                <button onClick={() => setDone(null)} style={{ marginTop: 14, background: 'none', border: '1px solid rgba(255,255,255,.14)', color: '#b5b7bd', borderRadius: 10, padding: '8px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Change response</button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {data.ackOptions.map(kind => {
                  const tone = TONE[kind] || { bg: '#2a2a2e', fg: '#fff' }
                  return (
                    <button key={kind} onClick={() => ack(kind)} disabled={!!busy}
                      style={{ width: '100%', minHeight: 56, borderRadius: 14, border: 'none', cursor: 'pointer', fontSize: 17, fontWeight: 800, background: tone.bg, color: tone.fg, opacity: busy && busy !== kind ? .5 : 1, transition: 'transform .12s ease', touchAction: 'manipulation' }}>
                      {busy === kind ? '…' : (data.ackLabels[kind] || kind)}
                    </button>
                  )
                })}
              </div>
            )}
          </>
        ) : null}
      </div>
    </main>
  )
}
