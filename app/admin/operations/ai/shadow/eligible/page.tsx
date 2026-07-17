'use client'

// ── Shadow Analytics — eligible-jobs picking list (owner-only) ───────────────
// Reads GET /api/admin/shadow-eligible (pure, zero AI) and lets the owner select/run/retry
// per booking via the shared ShadowRunControls (which talks to the owner-gated run route).
// No "run all" — every run is one explicit, confirmed action on one booking.

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import OperationsShell from '../../../OperationsShell'
import ShadowRunControls from '../ShadowRunControls'

const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 16 }
const seg: React.CSSProperties = { fontSize: 11.5, fontWeight: 700, padding: '6px 12px', cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--muted)' }
const segOn: React.CSSProperties = { background: 'var(--text)', color: 'var(--card)' }
const STATUS_COLOR: Record<string, string> = {
  not_selected: '#94a3b8', selected: '#93c5fd', queued: '#93c5fd', processing: '#fbbf24',
  completed: '#34d399', failed: '#f87171', retry_blocked: '#fb923c', budget_blocked: '#fbbf24',
  kill_switch: '#f87171', awaiting_ground_truth: '#a3e635',
}

type Row = {
  bookingId: string; bookingNumber?: string; createdAt?: number; status: string; label: string
  selected: boolean; eligible: boolean; imageCount: number; jobStatus?: string
  hasComparison: boolean; awaitingGroundTruth: boolean; canRun: boolean; canRetry: boolean; canRerun: boolean
}
type Payload = { enabled: boolean; scope?: string; sampled?: number; matched?: number; rows?: Row[] }

const SCOPES = [{ k: 'eligible', label: 'Candidates' }, { k: 'selected', label: 'Selected' }, { k: 'all', label: 'All recent' }]

export default function EligibleJobsPage() {
  return <Suspense fallback={null}><Inner /></Suspense>
}

function Inner() {
  const [scope, setScope] = useState('eligible')
  const [data, setData] = useState<Payload | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const res = await fetch(`/api/admin/shadow-eligible?scope=${scope}`, { credentials: 'same-origin' })
      if (res.status === 401 || res.status === 403) { setErr('Owner access required.'); setData(null); return }
      setData(await res.json())
    } catch { setErr('Could not load eligible jobs.') } finally { setLoading(false) }
  }, [scope])
  useEffect(() => { load() }, [load])

  return (
    <OperationsShell>
      <div style={{ display: 'grid', gap: 14, paddingBottom: 40 }}>
        <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>Shadow evaluation — eligible jobs</h1>
            <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--muted)' }}>
              Select a booking, then run one V2 shadow evaluation. V1 stays customer-facing; no customer is notified. No “run all”.
            </p>
          </div>
          <Link href="/admin/operations/ai/shadow" style={{ ...seg, border: '1px solid var(--line)', borderRadius: 9, textDecoration: 'none', color: 'var(--text)' }}>← Analytics</Link>
        </header>

        {err && <div style={{ ...card, borderColor: '#f87171', color: '#f87171', fontSize: 13 }}>{err}</div>}
        {data && !data.enabled && <div style={{ ...card, fontSize: 13, color: 'var(--muted)' }}>Shadow Analytics is off (SHADOW_ANALYTICS_ENABLED).</div>}

        {data?.enabled && (
          <>
            <div style={{ display: 'inline-flex', background: 'color-mix(in srgb, var(--card) 60%, transparent)', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden', width: 'fit-content' }}>
              {SCOPES.map((s) => (
                <button key={s.k} onClick={() => setScope(s.k)} style={{ ...seg, ...(scope === s.k ? segOn : {}) }}>{s.label}</button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>{loading ? 'Loading…' : `${data.matched ?? 0} of ${data.sampled ?? 0} recent booking(s).`}</div>

            {(data.rows?.length ?? 0) === 0 && !loading ? (
              <div style={{ ...card, textAlign: 'center', color: 'var(--muted)', fontSize: 13, padding: 28 }}>
                No {scope === 'selected' ? 'selected' : 'candidate'} bookings. A booking becomes a candidate once its authoritative estimate is done and it has photos.
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                {data.rows?.map((r) => {
                  const c = STATUS_COLOR[r.status] ?? 'var(--muted)'
                  const open = expanded === r.bookingId
                  return (
                    <div key={r.bookingId} style={{ ...card, padding: 12 }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                        <span style={{ fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 6, color: c, background: `color-mix(in srgb, ${c} 15%, transparent)`, border: `1px solid color-mix(in srgb, ${c} 35%, transparent)` }}>{r.label}</span>
                        <strong style={{ fontSize: 13 }}>{r.bookingNumber ?? r.bookingId.slice(0, 10)}</strong>
                        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{r.imageCount} image(s)</span>
                        {r.hasComparison && <Link href={`/admin/operations/ai/shadow/${r.bookingId}`} style={{ fontSize: 11, color: '#a3e635', textDecoration: 'none' }}>comparison →</Link>}
                        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                          <Link href={`/admin/operations/book-now/${r.bookingId}`} style={{ ...seg, border: '1px solid var(--line)', borderRadius: 8, textDecoration: 'none', color: 'var(--text)' }}>Booking</Link>
                          <button onClick={() => setExpanded(open ? null : r.bookingId)} style={{ ...seg, border: '1px solid var(--line)', borderRadius: 8, color: 'var(--text)' }}>
                            {open ? 'Hide' : 'Manage'}
                          </button>
                        </div>
                      </div>
                      {open && (
                        <div style={{ marginTop: 10 }}>
                          <ShadowRunControls bookingId={r.bookingId} compact />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>
    </OperationsShell>
  )
}
