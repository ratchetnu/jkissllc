'use client'

// ── AI Command Center — the unified section shell ────────────────────────────
// One destination, eight sections. Sits INSIDE OperationsShell (which owns the admin dock).
// Desktop: a quiet left section rail. Mobile: a horizontal-scroll-free section picker (a
// <select>) so tabs never run off-screen. Every AI page renders through here, so the chrome,
// spacing, and section vocabulary are identical everywhere — the point of the consolidation.
//
// Apple-calm on purpose: soft cards, one restrained accent, generous whitespace, no floating
// buttons, no gradients, hairline separators. State reads at a glance; nothing shouts.

import { useRouter } from 'next/navigation'
import Link from 'next/link'

export type AISection =
  | 'overview' | 'queue' | 'performance' | 'learning' | 'models' | 'controls' | 'alerts' | 'settings'

type SectionDef = { id: AISection; label: string; href: string; hint: string }

// The canonical section order + destinations. Sections not yet migrated into the shell point
// at their existing pages, so the Command Center is fully navigable from day one; each is
// swapped to its in-shell route as it lands.
export const AI_SECTIONS: SectionDef[] = [
  { id: 'overview',    label: 'Overview',      href: '/admin/operations/ai',              hint: 'Health, attention, next step' },
  { id: 'queue',       label: 'Evaluation Queue', href: '/admin/operations/ai/queue',       hint: 'Select, run, review' },
  { id: 'performance', label: 'Performance',   href: '/admin/operations/ai/performance',  hint: 'Accuracy, trends, leaderboards' },
  { id: 'learning',    label: 'Review & Learning', href: '/admin/operations/ai/learning', hint: 'Ground truth, categories, history' },
  { id: 'models',      label: 'Models & Versions', href: '/admin/operations/ai/models',   hint: 'Version registry (read-only)' },
  { id: 'controls',    label: 'Usage & Controls', href: '/admin/operations/ai/usage',     hint: 'Budget, kill switch, usage' },
  { id: 'alerts',      label: 'Alerts & Readiness', href: '/admin/operations/ai/alerts',  hint: 'Readiness, warnings' },
  { id: 'settings',    label: 'Settings',      href: '/admin/operations/ai/settings',     hint: 'Owner-safe configuration' },
]

const railItem = (active: boolean): React.CSSProperties => ({
  display: 'block', padding: '9px 12px', borderRadius: 10, textDecoration: 'none',
  fontSize: 13.5, fontWeight: active ? 700 : 500,
  color: active ? 'var(--text)' : 'var(--muted)',
  background: active ? 'color-mix(in srgb, var(--text) 8%, transparent)' : 'transparent',
})

export default function AICommandShell({ section, title, children }: { section: AISection; title?: string; children: React.ReactNode }) {
  const router = useRouter()
  const current = AI_SECTIONS.find((s) => s.id === section) ?? AI_SECTIONS[0]

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 18 }}>
      {/* Masthead — one calm title bar, identical on every section */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em', margin: 0 }}>AI Command Center</h1>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>{title ?? current.label}</span>
      </div>

      {/* Mobile section picker — a <select>, never a scrolling tab strip */}
      <div className="ai-picker" style={{ display: 'none' }}>
        <label style={{ display: 'block', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', marginBottom: 5 }}>Section</label>
        <select
          value={section}
          onChange={(e) => { const s = AI_SECTIONS.find((x) => x.id === e.target.value); if (s) router.push(s.href) }}
          style={{ width: '100%', padding: '11px 12px', fontSize: 15, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, color: 'var(--text)' }}
        >
          {AI_SECTIONS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </div>

      {/* Desktop: rail + content */}
      <div className="ai-body" style={{ display: 'grid', gridTemplateColumns: '208px minmax(0, 1fr)', gap: 22, alignItems: 'start' }}>
        <nav className="ai-rail" aria-label="AI Command Center sections" style={{ position: 'sticky', top: 16, display: 'grid', gap: 2 }}>
          {AI_SECTIONS.map((s) => (
            <Link key={s.id} href={s.href} style={railItem(s.id === section)} aria-current={s.id === section ? 'page' : undefined}>
              {s.label}
            </Link>
          ))}
          <p style={{ fontSize: 11, color: 'var(--muted)', margin: '10px 12px 0', lineHeight: 1.5 }}>{current.hint}</p>
        </nav>
        <div style={{ minWidth: 0, display: 'grid', gap: 14 }}>{children}</div>
      </div>

      <style>{`
        @media (max-width: 820px) {
          .ai-picker { display: block !important; }
          .ai-body { grid-template-columns: minmax(0, 1fr) !important; }
          .ai-rail { display: none !important; }
        }
      `}</style>
    </div>
  )
}

// ── shared calm primitives, reused by every section ──────────────────────────

export const aiCard: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 16, padding: 18 }
export const aiLabel: React.CSSProperties = { display: 'block', fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.055em', color: 'var(--muted)', marginBottom: 6 }

export function AIStat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div style={aiCard}>
      <span style={aiLabel}>{label}</span>
      <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em', color: tone ?? 'var(--text)', lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

export function AISkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div style={{ display: 'grid', gap: 10 }} aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ ...aiCard, height: 72, opacity: 0.5, animation: 'aipulse 1.4s ease-in-out infinite' }} />
      ))}
      <style>{`@keyframes aipulse { 0%,100% { opacity: .35 } 50% { opacity: .6 } } @media (prefers-reduced-motion: reduce) { [style*="aipulse"] { animation: none !important } }`}</style>
    </div>
  )
}

export function AIEmpty({ title, detail }: { title: string; detail?: string }) {
  return (
    <div style={{ ...aiCard, textAlign: 'center', padding: 32 }}>
      <div style={{ fontSize: 14, fontWeight: 700 }}>{title}</div>
      {detail && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6 }}>{detail}</div>}
    </div>
  )
}

export function AIError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div style={{ ...aiCard, borderColor: '#f8717155' }}>
      <div style={{ fontSize: 13, color: '#f87171' }}>{message}</div>
      {onRetry && <button onClick={onRetry} style={{ marginTop: 10, fontSize: 12.5, fontWeight: 700, padding: '7px 13px', borderRadius: 10, border: '1px solid var(--line)', background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>Try again</button>}
    </div>
  )
}
