'use client'
// ── Overlays + Tabs (interactive, focus-managed) ─────────────────────────────
//
// Dialog and Drawer implement a real focus trap: focus moves in on open, is
// trapped while open, Escape closes, and focus returns to the opener on close —
// the gap called out in 11-ux-and-design-system.md §5.

import { type ReactNode, useEffect, useRef } from 'react'

const RADIUS = 'var(--radius-lg)'
const SURFACE = 'var(--card)'
const INK = 'var(--text)'
const SCRIM = 'color-mix(in srgb, #000 55%, transparent)'

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(
    'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])',
  )).filter((el) => el.offsetParent !== null || el === document.activeElement)
}

function useFocusTrap(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    openerRef.current = document.activeElement as HTMLElement | null
    const root = ref.current
    if (root) { const f = focusables(root); (f[0] ?? root).focus() }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return }
      if (e.key !== 'Tab' || !ref.current) return
      const f = focusables(ref.current)
      if (f.length === 0) { e.preventDefault(); return }
      const first = f[0], last = f[f.length - 1], active = document.activeElement
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      openerRef.current?.focus?.() // return focus to the opener
    }
  }, [open, onClose])

  return ref
}

// ── Dialog ───────────────────────────────────────────────────────────────────
export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useFocusTrap(open, onClose)
  if (!open) return null
  return (
    <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, background: SCRIM, display: 'grid', placeItems: 'center', zIndex: 'var(--z-overlay)' as unknown as number, padding: 16 }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        style={{ background: SURFACE, color: INK, borderRadius: RADIUS, width: 'min(520px, 96vw)', maxHeight: '90vh', overflow: 'auto', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--line)', fontWeight: 700 }}>{title}</div>
        <div style={{ padding: 18 }}>{children}</div>
      </div>
    </div>
  )
}

// ── Drawer (side sheet) ──────────────────────────────────────────────────────
export function Drawer({ open, onClose, title, side = 'right', children }: { open: boolean; onClose: () => void; title: string; side?: 'left' | 'right'; children: ReactNode }) {
  const ref = useFocusTrap(open, onClose)
  if (!open) return null
  return (
    <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, background: SCRIM, zIndex: 'var(--z-overlay)' as unknown as number, display: 'flex', justifyContent: side === 'right' ? 'flex-end' : 'flex-start' }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        style={{ background: SURFACE, color: INK, width: 'min(460px, 94vw)', height: '100%', overflow: 'auto', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--line)', fontWeight: 700 }}>{title}</div>
        <div style={{ padding: 18 }}>{children}</div>
      </div>
    </div>
  )
}

// ── Tabs (roving arrow-key navigation) ───────────────────────────────────────
export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: string }[]; value: string; onChange: (id: string) => void }) {
  const onKey = (e: React.KeyboardEvent, idx: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const next = e.key === 'ArrowRight' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length
    onChange(tabs[next].id)
  }
  return (
    <div role="tablist" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--line)' }}>
      {tabs.map((t, i) => {
        const selected = t.id === value
        return (
          <button key={t.id} role="tab" aria-selected={selected} tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.id)} onKeyDown={(e) => onKey(e, i)}
            style={{ padding: '10px 14px', background: 'transparent', border: 'none', cursor: 'pointer', color: selected ? INK : 'var(--muted)', fontWeight: selected ? 700 : 500, borderBottom: selected ? '2px solid var(--red)' : '2px solid transparent' }}>
            {t.label}
          </button>
        )
      })}
    </div>
  )
}
