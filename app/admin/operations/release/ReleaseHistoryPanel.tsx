'use client'
// ── Release Center — Release History panel (Increment 3B.6) ──────────────────
//
// Read-only, filterable history of every release event (publishes + rollbacks), projected from
// the existing records. A single no-store GET; filtering is client-side over the loaded set.
// Each row opens the read-only Release Details drawer. No execution controls here.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StatusBadge, Select, Skeleton, EmptyState, Card } from '../../../components/ui'
import type { ReleaseHistoryEntry } from '../../../lib/platform/release/release-history'
import { releaseStatusTone, releaseStatusLabel, releaseKindLabel, historyTimeAgo, RELEASE_STATUS_FILTER_OPTIONS } from './release-history-view'
import { ReleaseDetailsDrawer } from './ReleaseDetailsDrawer'

type HistoryResponse = { ok: boolean; entries: ReleaseHistoryEntry[]; businesses: { id: string; slug: string }[]; total: number }

export function ReleaseHistoryPanel() {
  const [data, setData] = useState<HistoryResponse | null>(null)
  const [load, setLoad] = useState<'loading' | 'ok' | 'error' | 'unauthorized'>('loading')
  const [business, setBusiness] = useState('')
  const [status, setStatus] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [now] = useState(() => Date.now())
  const abortRef = useRef<AbortController | null>(null)

  const fetchHistory = useCallback((signal: AbortSignal) => {
    fetch('/api/admin/release/history', { credentials: 'same-origin', cache: 'no-store', signal })
      .then(async (r) => {
        if (r.status === 401 || r.status === 403) { setLoad('unauthorized'); return }
        if (!r.ok) { setLoad('error'); return }
        setData(await r.json()); setLoad('ok')
      })
      .catch((e: { name?: string }) => { if (e?.name !== 'AbortError') setLoad('error') })
  }, [])
  useEffect(() => { const ac = new AbortController(); abortRef.current = ac; fetchHistory(ac.signal); return () => ac.abort() }, [fetchHistory])

  const filtered = useMemo(() => {
    const entries = data?.entries ?? []
    return entries.filter((e) => (business ? e.businessId === business : true) && (status ? e.status === status : true))
  }, [data, business, status])

  if (load === 'loading') return <div style={{ display: 'grid', gap: 8 }}><Skeleton height={40} /><Skeleton height={40} /><Skeleton height={40} /></div>
  if (load === 'unauthorized') return <div role="alert" style={{ color: 'var(--muted)', fontSize: 14 }}>Owner access is required.</div>
  if (load === 'error' || !data) return <div role="alert" style={{ color: 'var(--status-bad-fg)', fontSize: 14 }}>Could not load release history.</div>

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ fontSize: 12, color: 'var(--muted)', display: 'inline-flex', gap: 6, alignItems: 'center' }}>Business
          <Select aria-label="Filter by business" value={business} onChange={(e) => setBusiness(e.target.value)} style={{ minHeight: 36 }}
            options={[{ value: '', label: 'All' }, ...data.businesses.map((b) => ({ value: b.id, label: b.slug }))]} />
        </label>
        <label style={{ fontSize: 12, color: 'var(--muted)', display: 'inline-flex', gap: 6, alignItems: 'center' }}>Status
          <Select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)} style={{ minHeight: 36 }}
            options={[{ value: '', label: 'All' }, ...RELEASE_STATUS_FILTER_OPTIONS]} />
        </label>
        <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>{filtered.length} of {data.total} release{data.total === 1 ? '' : 's'}</span>
      </div>

      {filtered.length === 0
        ? <EmptyState title="No releases yet" description="Published releases and rollbacks appear here once they run." />
        : <div style={{ display: 'grid', gap: 8 }}>
            {filtered.map((e) => (
              <Card key={e.id} style={{ padding: 0 }}>
                <button
                  type="button" onClick={() => setOpenId(e.id)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text)', font: 'inherit', textAlign: 'left', minHeight: 44, flexWrap: 'wrap' }}
                >
                  <span style={{ display: 'grid', gap: 2, minWidth: 0, flex: '1 1 200px' }}>
                    <span style={{ fontSize: 13.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{e.businessSlug} · <span style={{ color: 'var(--muted)', fontWeight: 500 }}>{releaseKindLabel(e.kind)}</span></span>
                    <span style={{ fontSize: 12, color: 'var(--muted)', overflowWrap: 'anywhere' }}>{e.commit ? <code>{e.commit.slice(0, 7)}</code> : '—'} · {historyTimeAgo(e.at, now)}{e.rolledBackByRollbackId ? ' · reversed' : ''}</span>
                  </span>
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                    <StatusBadge tone={e.mode === 'live' ? 'bad' : 'info'} dot={false}>{e.mode === 'live' ? 'LIVE' : 'Sim'}</StatusBadge>
                    <StatusBadge tone={releaseStatusTone(e.status)}>{releaseStatusLabel(e.status)}</StatusBadge>
                  </span>
                </button>
              </Card>
            ))}
          </div>}

      <ReleaseDetailsDrawer releaseId={openId} open={openId != null} onClose={() => setOpenId(null)}
        title={openId ? `Release ${openId}` : 'Release details'} />
    </div>
  )
}
