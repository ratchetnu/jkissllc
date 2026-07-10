'use client'

import { useCallback, useEffect, useState } from 'react'
import { useIdleLogout } from './useIdleLogout'

// Single source of truth for admin auth: session check, login, sign-out, and the
// 10-minute idle logout. Used by AdminGate and OperationsShell so the flow lives
// in one place.
export type LoginRecord = { at: number; device: string | null }

export function useAdminSession() {
  const [authed, setAuthed] = useState(false)
  const [checked, setChecked] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [lastLogin, setLastLogin] = useState<LoginRecord | null>(null)

  useEffect(() => {
    fetch('/api/admin/session')
      .then(r => r.json())
      .then(d => { setAuthed(!!d.authed); setLastLogin(d.lastLogin ?? null) })
      .catch(() => {})
      .finally(() => setChecked(true))
  }, [])

  const login = useCallback(async (password: string): Promise<boolean> => {
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/admin/auth', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }), credentials: 'same-origin',
      })
      const d = await res.json()
      if (res.ok && d.valid) { setAuthed(true); return true }
      setError(d.error ?? 'Incorrect password'); return false
    } catch { setError('Connection error — try again'); return false }
    finally { setLoading(false) }
  }, [])

  const signOut = useCallback(async () => {
    try { await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }) } catch {}
    setAuthed(false)
  }, [])

  useIdleLogout(authed, signOut)

  return { authed, checked, error, loading, login, signOut, lastLogin }
}
