'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

type RequestState = { applicantNumber: string; firstName: string; request: string; submitted: boolean }

export default function UpdateApplicationForm({ token }: { token: string }) {
  const [state, setState] = useState<RequestState | null>(null)
  const [response, setResponse] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    let active = true
    void fetch(`/api/careers/update?token=${encodeURIComponent(token)}`, { cache: 'no-store' })
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || 'This request could not be opened.')
        if (active) setState(json)
      })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : 'This request could not be opened.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [token])

  async function submit() {
    if (!response.trim() || busy) return
    setBusy(true); setError('')
    try {
      const res = await fetch('/api/careers/update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, response }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Your response could not be submitted.')
      setDone(true)
    } catch (e) { setError(e instanceof Error ? e.message : 'Your response could not be submitted.') }
    finally { setBusy(false) }
  }

  return (
    <main className="min-h-screen px-6 py-24" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <div className="max-w-xl mx-auto glass-card p-6 md:p-8" style={{ borderRadius: 20 }}>
        <Link href="/" className="text-sm" style={{ color: 'var(--muted)' }}>J Kiss LLC</Link>
        <h1 className="text-2xl font-black text-white mt-3 mb-3">Application information request</h1>
        {loading && <p>Loading your request…</p>}
        {error && <p role="alert" className="text-sm mb-4" style={{ color: '#f87171' }}>{error}</p>}
        {state && !done && !state.submitted && <>
          <p className="text-sm mb-4" style={{ color: 'var(--muted)' }}>Hi {state.firstName}. For application <strong>{state.applicantNumber}</strong>, our hiring team asked:</p>
          <blockquote className="p-4 mb-5 rounded-xl" style={{ background: 'rgba(255,255,255,.04)', borderLeft: '3px solid var(--red)' }}>{state.request}</blockquote>
          <label htmlFor="application-response" className="text-sm font-semibold block mb-2">Your response</label>
          <textarea id="application-response" value={response} onChange={e => setResponse(e.target.value)} rows={7} maxLength={2000} required style={{ width: '100%', padding: 12, borderRadius: 10, background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)', color: '#fff' }} />
          <button disabled={busy || !response.trim()} onClick={submit} className="btn mt-4" style={{ opacity: busy || !response.trim() ? .5 : 1 }}>{busy ? 'Submitting…' : 'Submit response'}</button>
        </>}
        {(done || state?.submitted) && <p style={{ color: '#34d399' }}>Thank you. Your response was added to the original application and the hiring team was notified.</p>}
      </div>
    </main>
  )
}
