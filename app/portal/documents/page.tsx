'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { FileText, FileSignature, Receipt, ShieldCheck, GraduationCap, ClipboardList, Download, ExternalLink } from 'lucide-react'

type Category = 'agreement' | 'policy' | 'training' | 'tax' | 'job' | 'other'
type DocItem = {
  id: string
  kind: 'file' | 'statement'
  category: Category
  title: string
  description: string | null
  href: string
  download: boolean
  createdAt: number
}

const CAT_META: Record<Category, { label: string; Icon: typeof FileText }> = {
  agreement: { label: 'Agreements', Icon: FileSignature },
  tax: { label: 'Tax documents', Icon: Receipt },
  policy: { label: 'Policies', Icon: ShieldCheck },
  training: { label: 'Training', Icon: GraduationCap },
  job: { label: 'Job documents', Icon: ClipboardList },
  other: { label: 'Statements & other', Icon: FileText },
}
const ORDER: Category[] = ['agreement', 'tax', 'policy', 'training', 'job', 'other']

function Documents() {
  const [docs, setDocs] = useState<DocItem[] | null>(null)

  useEffect(() => {
    let alive = true
    fetch('/api/portal/documents', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((d) => { if (alive) setDocs(d.documents ?? []) })
      .catch(() => { if (alive) setDocs([]) })
    return () => { alive = false }
  }, [])

  const groups = ORDER.map((cat) => ({ cat, items: (docs ?? []).filter((d) => d.category === cat) })).filter((g) => g.items.length)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h1 className="jkos-h" style={{ fontSize: 24 }}>Documents</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 3 }}>
          Your contractor paperwork, policies, training material, tax documents, and payment statements — all in one place.
        </p>
      </div>

      {docs === null && <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading…</p>}
      {docs?.length === 0 && (
        <div className="os-card" style={{ padding: 18 }}>
          <p style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.5 }}>
            No documents yet. Your contractor agreement, policies, and payment statements appear here as they&apos;re added.
          </p>
        </div>
      )}

      {groups.map(({ cat, items }) => {
        const { label, Icon } = CAT_META[cat]
        return (
          <section key={cat} style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            <h2 style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <Icon size={13} /> {label}
            </h2>
            {items.map((d) => {
              const inner = (
                <>
                  <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ display: 'inline-flex', width: 38, height: 38, flexShrink: 0, borderRadius: 10, alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)' }}>
                      <Icon size={17} style={{ color: 'var(--red-glow, #ff6680)' }} />
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ fontWeight: 700, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</p>
                      {d.description && <p style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.description}</p>}
                    </div>
                  </div>
                  {d.download ? <Download size={17} style={{ color: 'var(--muted)', flexShrink: 0 }} /> : <ExternalLink size={16} style={{ color: 'var(--muted)', flexShrink: 0 }} />}
                </>
              )
              const cardStyle: React.CSSProperties = { padding: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, textDecoration: 'none', color: 'var(--text)' }
              return d.download ? (
                <a key={`${d.kind}-${d.id}`} href={d.href} target="_blank" rel="noreferrer" className="os-card os-tap" style={cardStyle}>{inner}</a>
              ) : (
                <Link key={`${d.kind}-${d.id}`} href={d.href} className="os-card os-tap" style={cardStyle}>{inner}</Link>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}

export default function DocumentsPage() {
  return (
    <Documents />
  )
}
