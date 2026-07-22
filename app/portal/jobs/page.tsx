'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, CheckCircle2, MapPin, Package, Truck } from 'lucide-react'
import { money, fmtDay } from '../ui'

// My Jobs — every piece of work assigned to this crew member, from BOTH lanes.
// The portal used to read routes only, so a crew member on a moving or junk job
// saw an empty screen. This reads the unified feed (/api/portal/jobs).
//
// Routes still deep-link to their existing confirmation page (/route/{token}) —
// that flow is untouched. Bookings link to the job screen in the portal.

type Job = {
  kind: 'route' | 'booking'
  id: string
  number: string
  token: string | null
  title: string
  serviceLabel: string
  address: string | null
  date: string
  timeLabel: string | null
  status: string
  statusLabel: string
  role: string | null
  payCents: number | null
  confirmedAt: number | null
  declinedAt: number | null
  clockInAt: number | null
  clockOutAt: number | null
  crew: { name: string; role: string | null }[]
  href: string
}

function stateLine(j: Job): string {
  if (j.declinedAt) return 'You declined'
  if (j.clockOutAt) return 'Clocked out'
  if (j.clockInAt) return 'On the clock'
  if (j.confirmedAt) return 'Accepted'
  return j.kind === 'booking' ? 'Tap to accept' : 'Tap to confirm'
}

function JobCard({ j }: { j: Job }) {
  const Icon = j.kind === 'route' ? Truck : Package
  return (
    <Link href={j.href} className="os-card os-tap" style={{ display: 'block', padding: 16, textDecoration: 'none', color: 'inherit' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontWeight: 700, fontSize: 16 }}>{j.title}</p>
          <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 3 }}>
            {j.date ? fmtDay(j.date) : 'Date TBD'}
            {j.timeLabel ? ` · ${j.timeLabel}` : ''}
            {j.role ? ` · ${j.role}` : ''}
          </p>
        </div>
        <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 800, padding: '3px 9px', borderRadius: 999, color: 'var(--muted)', border: '1px solid var(--line)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Icon size={12} /> {j.serviceLabel}
        </span>
      </div>

      {j.address && (
        <p style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 13, marginTop: 8 }}>
          <MapPin size={13} /> {j.address}
        </p>
      )}

      {j.crew.length > 0 && (
        <p style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 6 }}>
          With {j.crew.map(c => c.name).join(', ')}
        </p>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
        <span style={{ fontSize: 13, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {j.clockOutAt && <CheckCircle2 size={14} style={{ color: '#86efac' }} />}
          {stateLine(j)}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 13 }}>
          {typeof j.payCents === 'number' && <span style={{ color: 'var(--text)' }}>{money(j.payCents)}</span>}
          <ArrowRight size={15} style={{ color: 'var(--red)' }} />
        </span>
      </div>
    </Link>
  )
}

function MyJobs() {
  const [upcoming, setUpcoming] = useState<Job[]>([])
  const [past, setPast] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/portal/jobs', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error('failed')))
      .then(d => { setUpcoming(d.upcoming ?? []); setPast(d.past ?? []) })
      .catch(() => setError('Could not load your jobs. Pull down to retry.'))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1 className="jkos-h" style={{ fontSize: 24 }}>My Jobs</h1>
      {loading && <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading…</p>}
      {error && <p role="alert" style={{ color: '#f87171', fontSize: 14 }}>{error}</p>}

      {!loading && !error && (
        <>
          <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h2 style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>Upcoming</h2>
            {upcoming.length
              ? upcoming.map(j => <JobCard key={`${j.kind}:${j.id}`} j={j} />)
              : <div className="os-card" style={{ padding: 16 }}><p style={{ color: 'var(--muted)', fontSize: 14 }}>Nothing scheduled yet.</p></div>}
          </section>

          {past.length > 0 && (
            <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <h2 style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>Past</h2>
              {past.map(j => <JobCard key={`${j.kind}:${j.id}`} j={j} />)}
            </section>
          )}
        </>
      )}
    </div>
  )
}

// The portal chrome lives in app/portal/layout.tsx and stays mounted across
// navigations — a page must NOT wrap itself in PortalShell again.
export default function MyJobsPage() {
  return <MyJobs />
}
