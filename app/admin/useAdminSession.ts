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
  const [role, setRole] = useState<'admin' | 'manager' | 'crew' | null>(null)

  useEffect(() => {
    fetch('/api/admin/session')
      .then(r => r.json())
      .then(d => { setAuthed(!!d.authed); setLastLogin(d.lastLogin ?? null); setRole(d.role ?? null) })
      .catch(() => {})
      .finally(() => setChecked(true))
  }, [])

  // Sign in to the operations surface. An email means a named user account
  // (manager/admin) → /api/auth/login; no email means the legacy owner password →
  // /api/admin/auth. Crew accounts are redirected to their portal.
  const login = useCallback(async (password: string, email?: string): Promise<boolean> => {
    setLoading(true); setError('')
    try {
      if (email && email.trim()) {
        const res = await fetch('/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim(), password }), credentials: 'same-origin',
        })
        const d = await res.json()
        if (res.ok && d.ok) {
          if (d.role === 'crew') { window.location.href = '/portal'; return true }
          setAuthed(true); setRole(d.role ?? null); return true
        }
        setError(d.error ?? 'Incorrect email or password'); return false
      }
      const res = await fetch('/api/admin/auth', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }), credentials: 'same-origin',
      })
      const d = await res.json()
      if (res.ok && d.valid) { setAuthed(true); setRole('admin'); return true }
      setError(d.error ?? 'Incorrect password'); return false
    } catch { setError('Connection error — try again'); return false }
    finally { setLoading(false) }
  }, [])

  const signOut = useCallback(async () => {
    try { await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }) } catch {}
    setAuthed(false)
  }, [])

  useIdleLogout(authed, signOut)

  return { authed, checked, error, loading, login, signOut, lastLogin, role }
}
