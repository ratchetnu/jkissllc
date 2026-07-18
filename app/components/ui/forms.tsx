'use client'
// ── Form controls ────────────────────────────────────────────────────────────
//
// The inputs the audit found hand-rolled across screens (search boxes, text /
// number / currency fields, toggles, segmented switches). All token-driven and
// theme-aware; pair with <FormField> from primitives for label + hint + error.

import { type InputHTMLAttributes, type TextareaHTMLAttributes, type ReactNode, useId } from 'react'

const FIELD = {
  width: '100%', padding: '11px 13px', minHeight: 40,
  background: 'color-mix(in srgb, var(--card) 90%, transparent)',
  border: '1px solid var(--line)', borderRadius: 'var(--radius-md)',
  color: 'var(--text)', fontSize: 'var(--text-base)', outline: 'none',
} as const

// ── Input (text / number / email / etc.) ─────────────────────────────────────
type InputProps = InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
export function Input({ invalid, style, ...rest }: InputProps) {
  return <input {...rest} aria-invalid={invalid || undefined} style={{ ...FIELD, borderColor: invalid ? 'var(--status-bad-fg)' : 'var(--line)', ...style }} />
}

// ── Textarea ─────────────────────────────────────────────────────────────────
type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
export function Textarea({ invalid, style, ...rest }: TextareaProps) {
  return <textarea {...rest} aria-invalid={invalid || undefined} style={{ ...FIELD, minHeight: 88, resize: 'vertical', lineHeight: 1.5, borderColor: invalid ? 'var(--status-bad-fg)' : 'var(--line)', ...style }} />
}

// ── SearchInput (leading glyph, rounded, the app's one search look) ──────────
export function SearchInput({ style, 'aria-label': ariaLabel = 'Search', ...rest }: InputProps) {
  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <span aria-hidden style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none', fontSize: 15 }}>⌕</span>
      <Input {...rest} type="search" aria-label={ariaLabel} style={{ paddingLeft: 32, borderRadius: 'var(--radius-pill)', ...style }} />
    </div>
  )
}

// ── CurrencyInput ($ affix, decimal keypad, tabular numerals) ────────────────
export function CurrencyInput({ value, onChange, placeholder = '0.00', invalid, ...rest }: {
  value: string; onChange: (v: string) => void; placeholder?: string; invalid?: boolean
  'aria-label'?: string; disabled?: boolean
}) {
  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <span aria-hidden style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', fontSize: 15, fontWeight: 600, color: 'var(--muted)', pointerEvents: 'none' }}>$</span>
      <input {...rest} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} inputMode="decimal" className="tabular-nums"
        style={{ ...FIELD, paddingLeft: 27, borderColor: invalid ? 'var(--status-bad-fg)' : 'var(--line)' }} />
    </div>
  )
}

// ── Toggle (the switch) ──────────────────────────────────────────────────────
export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
      style={{ width: 50, height: 30, borderRadius: 'var(--radius-pill)', border: 'none', cursor: 'pointer', padding: 3, background: on ? 'var(--red)' : 'rgba(255,255,255,.14)', transition: 'background var(--dur-2) var(--ease-standard)', flexShrink: 0 }}>
      <span style={{ display: 'block', width: 24, height: 24, borderRadius: 999, background: '#fff', transform: on ? 'translateX(20px)' : 'translateX(0)', transition: 'transform var(--dur-2) var(--ease-spring)' }} />
    </button>
  )
}

// ── Segmented control (iOS-style single-select switch) ───────────────────────
export function Segmented<T extends string>({ options, value, onChange, ariaLabel }: {
  options: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; ariaLabel?: string
}) {
  const id = useId()
  return (
    <div role="radiogroup" aria-label={ariaLabel} style={{ display: 'inline-flex', gap: 2, padding: 3, background: 'color-mix(in srgb, var(--card) 85%, transparent)', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)' }}>
      {options.map((o) => {
        const active = o.value === value
        return (
          <button key={o.value} role="radio" aria-checked={active} id={`${id}-${o.value}`} onClick={() => onChange(o.value)}
            style={{ padding: '6px 14px', minHeight: 32, borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer', fontSize: 'var(--text-sm)', fontWeight: 600, whiteSpace: 'nowrap', color: active ? 'var(--text)' : 'var(--muted)', background: active ? 'color-mix(in srgb, var(--card) 60%, #fff 10%)' : 'transparent', boxShadow: active ? 'var(--shadow-xs)' : 'none', transition: 'color var(--dur-1) var(--ease-standard)' }}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
