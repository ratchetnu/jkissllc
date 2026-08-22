'use client'

// ── Accessible in-app confirmation ──────────────────────────────────────────
//
// Replaces `window.confirm` in the update workflow. The native dialog was not a
// styling problem: it BLOCKS the JavaScript thread, so nothing can poll, nothing
// can render a pending state, and the string it shows cannot carry a link, a list
// of what is about to change, or a typed-phrase field. It is also unusable for the
// one action that most needs care — a typed Production intent.
//
// What this provides that `confirm()` cannot:
//   • focus moves INTO the dialog on open and back to the trigger on close;
//   • Tab is trapped inside it, so the page behind cannot be reached blind;
//   • Escape and the backdrop cancel; neither ever confirms;
//   • errors are announced via role="alert", not swallowed;
//   • the confirm button disables itself for the duration of the submit, so a
//     double-click cannot produce two jobs, two approvals or two publishes;
//   • an optional exact phrase must be typed before confirm is enabled at all.

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'

const panel: React.CSSProperties = {
  background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 16,
  padding: 20, width: 'min(520px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 64px)', overflowY: 'auto',
  boxShadow: '0 24px 60px rgba(0,0,0,.45)',
}
const backdrop: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex',
  alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16,
}
const btn = (kind: 'primary' | 'ghost' | 'danger'): React.CSSProperties => ({
  fontSize: 13, fontWeight: 700, padding: '9px 16px', borderRadius: 9, cursor: 'pointer', whiteSpace: 'nowrap',
  border: '1px solid ' + (kind === 'primary' ? 'var(--red)' : kind === 'danger' ? 'rgba(224,0,42,.5)' : 'var(--line)'),
  background: kind === 'primary' ? 'var(--red)' : 'transparent',
  color: kind === 'primary' ? '#fff' : kind === 'danger' ? '#ff6680' : 'var(--text)',
})
const field: React.CSSProperties = {
  width: '100%', padding: '9px 11px', background: 'color-mix(in srgb, var(--card) 90%, transparent)',
  border: '1px solid var(--line)', borderRadius: 9, color: 'var(--text)', fontSize: 13, outline: 'none',
  fontFamily: 'monospace',
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

const normalize = (s: string) => s.trim().replace(/\s+/g, ' ').toUpperCase()

export type ConfirmDialogProps = {
  open: boolean
  title: string
  /** Rich body — what is about to change, a Preview link, a list of files. */
  children?: ReactNode
  confirmLabel: string
  cancelLabel?: string
  destructive?: boolean
  /**
   * When set, the exact phrase must be typed before Confirm becomes enabled. The
   * SERVER re-checks it; this only saves a pointless round trip and makes the
   * requirement visible.
   */
  requiredPhrase?: string
  onCancel: () => void
  onConfirm: () => Promise<void> | void
}

/**
 * The wrapper exists so the panel MOUNTS fresh on every open. Keeping one long-lived
 * panel and clearing its fields in an effect leaves a window where the previous
 * attempt's typed phrase is still on screen — which, for a typed Production intent,
 * is the difference between a deliberate confirmation and a pre-filled one.
 */
export default function ConfirmDialog(props: ConfirmDialogProps) {
  if (!props.open) return null
  return <ConfirmPanel {...props} />
}

function ConfirmPanel({
  title, children, confirmLabel, cancelLabel = 'Cancel', destructive, requiredPhrase, onCancel, onConfirm,
}: ConfirmDialogProps) {
  const titleId = useId()
  const descId = useId()
  const phraseId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreTo = useRef<HTMLElement | null>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Remember what had focus, move focus into the dialog, and put it back on close.
  // Mount/unmount scoped — the wrapper above guarantees one mount per open, so this
  // needs no `open` bookkeeping and cannot leave focus stranded on a hidden panel.
  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null
    panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
    return () => { restoreTo.current?.focus?.() }
  }, [])

  const keydown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); if (!busy) onCancel(); return }
    if (e.key !== 'Tab') return
    const nodes = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    if (nodes.length === 0) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }, [busy, onCancel])

  const phraseOk = !requiredPhrase || normalize(typed) === normalize(requiredPhrase)
  const confirmDisabled = busy || !phraseOk

  const submit = async () => {
    if (confirmDisabled) return
    setBusy(true); setError('')
    try {
      await onConfirm()
    } catch (e) {
      // Never leave the dialog looking like it worked.
      setError(e instanceof Error ? e.message : 'That did not go through. Nothing was changed.')
      setBusy(false)
    }
  }

  return (
    <div
      style={backdrop}
      // A click on the backdrop cancels; it can never confirm.
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel() }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        style={panel}
        onKeyDown={keydown}
      >
        <h2 id={titleId} style={{ fontSize: 17, fontWeight: 900, letterSpacing: '-.01em', marginBottom: 8 }}>{title}</h2>
        <div id={descId} style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.55 }}>{children}</div>

        {requiredPhrase && (
          <div style={{ marginTop: 16 }}>
            <label htmlFor={phraseId} style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted)', marginBottom: 6 }}>
              Type <code style={{ color: 'var(--text)' }}>{requiredPhrase}</code> to continue
            </label>
            <input
              id={phraseId}
              style={field}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={`${phraseId}-hint`}
              aria-invalid={typed.length > 0 && !phraseOk}
              disabled={busy}
            />
            <p id={`${phraseId}-hint`} style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 5 }}>
              Case-insensitive, but every word has to be there. The server checks it again.
            </p>
          </div>
        )}

        {error && (
          // role="alert" so a screen reader is told without the user hunting for it.
          <p role="alert" style={{ marginTop: 14, fontSize: 13, color: '#ff6680', fontWeight: 600 }}>{error}</p>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
          <button type="button" style={btn('ghost')} onClick={onCancel} disabled={busy}>{cancelLabel}</button>
          <button
            type="button"
            style={{ ...btn(destructive ? 'danger' : 'primary'), opacity: confirmDisabled ? 0.5 : 1, cursor: confirmDisabled ? 'not-allowed' : 'pointer' }}
            onClick={submit}
            disabled={confirmDisabled}
            aria-disabled={confirmDisabled}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
