'use client'
// ── Deliberate-action framework — reusable components ─────────────────────────
//
// Increment 3B.2A. The generic UI foundation for high-consequence owner actions
// (identified in docs/operations/operion-3b2-design-review.md). Composed entirely from
// the existing Operion Design System (Drawer/Button/Input). None of these know anything
// about publishing, promotion, GitHub, or Vercel — they are domain-agnostic and reusable.

import { type ReactNode, useId, useState } from 'react'
import { Info, AlertTriangle, ShieldAlert, CheckCircle2, XCircle } from 'lucide-react'
import { Drawer } from './overlays'
import { Button, Spinner } from './primitives'
import { Input } from './forms'
import {
  matchesConfirmation, riskPresentation, canConfirmDeliberateAction,
  checklistStateLabel, checklistStateGlyph, checklistStateColor, summarizeChecklist,
  type RiskLevel, type ChecklistItem,
} from './deliberate-action-logic'

const RISK_ICON = { info: Info, warning: AlertTriangle, danger: ShieldAlert, success: CheckCircle2 } as const

// ── RiskBanner ───────────────────────────────────────────────────────────────
export function RiskBanner({ level, title, children }: { level: RiskLevel; title: string; children?: ReactNode }) {
  const p = riskPresentation(level)
  const Icon = RISK_ICON[p.icon]
  return (
    <div role={p.role} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', borderLeft: `3px solid ${p.border}`, background: p.bg, borderRadius: 'var(--radius-sm)', padding: '10px 14px' }}>
      <Icon aria-hidden size={18} style={{ color: p.fg, flexShrink: 0, marginTop: 1 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, color: p.fg }}>{title}</div>
        {children && <div style={{ color: 'var(--text)', fontSize: 'var(--text-sm)', marginTop: 2 }}>{children}</div>}
      </div>
    </div>
  )
}

// ── EligibilityChecklist (visual only — accepts structured data) ─────────────
const CHECK_ICON = { pass: CheckCircle2, warn: AlertTriangle, fail: XCircle } as const
export function EligibilityChecklist({ items, title }: { items: ChecklistItem[]; title?: string }) {
  const s = summarizeChecklist(items)
  return (
    <div>
      {title && <div style={{ fontSize: 'var(--text-xs)', fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>{title}</div>}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
        {items.map((it, i) => {
          const Icon = CHECK_ICON[it.state]
          const color = checklistStateColor(it.state)
          return (
            <li key={i} style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontSize: 'var(--text-sm)' }}>
              <Icon aria-hidden size={16} style={{ color, flexShrink: 0, marginTop: 1 }} />
              <span style={{ color: 'var(--text)', minWidth: 0 }}>
                {/* State word is present for screen readers — never color-only. */}
                <span style={{ color, fontWeight: 600 }}>{checklistStateGlyph(it.state)} {checklistStateLabel(it.state)}:</span>{' '}
                {it.label}
                {it.detail && <span style={{ color: 'var(--muted)', display: 'block', fontSize: 'var(--text-xs)' }}>{it.detail}</span>}
              </span>
            </li>
          )
        })}
      </ul>
      <div role="status" style={{ fontSize: 'var(--text-xs)', color: 'var(--muted)', marginTop: 6 }}>
        {s.passed} of {s.total} passed{s.warnings ? ` · ${s.warnings} warning${s.warnings > 1 ? 's' : ''}` : ''}{s.failed ? ` · ${s.failed} failed` : ''}
      </div>
    </div>
  )
}

// ── TypedConfirm (knows nothing about publishing) ────────────────────────────
export function TypedConfirm({ requiredValue, label, caseSensitive, value, onChange, onMatchChange }: {
  requiredValue: string
  label?: string
  caseSensitive?: boolean
  value: string
  onChange: (v: string) => void
  onMatchChange?: (matched: boolean) => void
}) {
  const id = useId()
  const hintId = `${id}-hint`
  const matched = matchesConfirmation(value, requiredValue, { caseSensitive })
  const touched = value.trim().length > 0
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <label htmlFor={id} style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text)' }}>
        {label ?? <>Type <strong>{requiredValue}</strong> to confirm</>}
      </label>
      <Input id={id} value={value} aria-describedby={hintId} aria-invalid={touched && !matched}
        autoComplete="off" autoCorrect="off" spellCheck={false}
        onChange={(e) => { const v = e.target.value; onChange(v); onMatchChange?.(matchesConfirmation(v, requiredValue, { caseSensitive })) }} />
      <div id={hintId} role="status" style={{ fontSize: 'var(--text-xs)', color: matched ? 'var(--status-good-fg)' : 'var(--muted)' }}>
        {matched ? 'Confirmed.' : touched ? 'Value does not match yet.' : `Enter “${requiredValue}” exactly.`}
      </div>
    </div>
  )
}

// ── DeliberateActionDrawer (generic shell; no domain logic) ──────────────────
export function DeliberateActionDrawer({
  open, onClose, title, description, warning, summary, confirm,
  confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = true,
  onConfirm, loading = false, error, blockingFailures = 0,
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: ReactNode
  warning?: { level: RiskLevel; title: string; detail?: ReactNode }
  summary?: ReactNode
  confirm?: { requiredValue: string; label?: string; caseSensitive?: boolean }
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  loading?: boolean
  error?: string
  blockingFailures?: number
}) {
  const [typed, setTyped] = useState('')
  const confirmed = !confirm || matchesConfirmation(typed, confirm.requiredValue, { caseSensitive: confirm.caseSensitive })
  const canFire = canConfirmDeliberateAction({ confirmed, loading, blockingFailures })

  return (
    <Drawer open={open} onClose={onClose} title={title}>
      <div style={{ display: 'grid', gap: 16 }}>
        {warning && <RiskBanner level={warning.level} title={warning.title}>{warning.detail}</RiskBanner>}
        {description && <div style={{ color: 'var(--muted)', fontSize: 'var(--text-base)' }}>{description}</div>}
        {summary && <div>{summary}</div>}
        {confirm && (
          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 14 }}>
            <TypedConfirm requiredValue={confirm.requiredValue} label={confirm.label} caseSensitive={confirm.caseSensitive} value={typed} onChange={setTyped} />
          </div>
        )}
        {error && <div role="alert" style={{ fontSize: 'var(--text-sm)', color: 'var(--status-bad-fg)' }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
          <Button variant="secondary" onClick={onClose} disabled={loading}>{cancelLabel}</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={!canFire} aria-disabled={!canFire}>
            {loading ? <><Spinner size={15} /> Working…</> : confirmLabel}
          </Button>
        </div>
      </div>
    </Drawer>
  )
}
