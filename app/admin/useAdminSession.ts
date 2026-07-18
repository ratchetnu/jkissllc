'use client'

import { useCallback, useEffect, useState } from 'react'
import { useIdleLogout } from './useIdleLogout'

// Single source of truth for admin auth: session check, login, sign-out, and the
// 10-minute idle logout. Used by AdminGate and OperationsShell so the flow lives
// in one place.
export type LoginRecord = { at: number; device: string | null }
type Role = 'admin' | 'manager' | 'crew' | null

// Module-level cache of the last session check. OperationsShell is rendered per admin
// PAGE (there is no operations layout), so it unmounts/remounts on every navigation.
// Without this cache each remount reset `checked` to false and re-fetched
// /api/admin/session, flashing the auth skeleton on every bottom-nav tap. Seeding
// state from the cache lets remounts render immediately (already checked/authed) while
// still refreshing in the background — the fetch is now non-blocking, not a full-screen
// gate. Cleared on a hard reload; kept in sync on login/sign-out below.
let cachedSession: { authed: boolean; role: Role; lastLogin: LoginRecord | null; name: string | null } | null = null

export function useAdminSession() {
  const [authed, setAuthed] = useState(cachedSession?.authed ?? false)
  const [checked, setChecked] = useState(cachedSession != null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [lastLogin, setLastLogin] = useState<LoginRecord | null>(cachedSession?.lastLogin ?? null)
  const [role, setRole] = useState<Role>(cachedSession?.role ?? null)
  const [name, setName] = useState<string | null>(cachedSession?.name ?? null)

  useEffect(() => {
    let live = true
    fetch('/api/admin/session')
      .then(r => r.json())
      .then(d => {
        if (!live) return
        cachedSession = { authed: !!d.authed, role: d.role ?? null, lastLogin: d.lastLogin ?? null, name: d.name ?? null }
        setAuthed(cachedSession.authed); setLastLogin(cachedSession.lastLogin); setRole(cachedSession.role); setName(cachedSession.name)
      })
      .catch(() => {})
      .finally(() => { if (live) setChecked(true) })
    return () => { live = false }
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
          setAuthed(true); setRole(d.role ?? null)
          cachedSession = { authed: true, role: d.role ?? null, lastLogin: cachedSession?.lastLogin ?? null, name: cachedSession?.name ?? null }
          return true
        }
        setError(d.error ?? 'Incorrect email or password'); return false
      }
      const res = await fetch('/api/admin/auth', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }), credentials: 'same-origin',
      })
      const d = await res.json()
      if (res.ok && d.valid) {
        setAuthed(true); setRole('admin')
        cachedSession = { authed: true, role: 'admin', lastLogin: cachedSession?.lastLogin ?? null, name: cachedSession?.name ?? null }
        return true
      }
      setError(d.error ?? 'Incorrect password'); return false
    } catch { setError('Connection error — try again'); return false }
    finally { setLoading(false) }
  }, [])

  const signOut = useCallback(async () => {
    try { await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }) } catch {}
    setAuthed(false); setRole(null); setName(null)
    cachedSession = { authed: false, role: null, lastLogin: cachedSession?.lastLogin ?? null, name: null }
  }, [])

  useIdleLogout(authed, signOut)

  return { authed, checked, error, loading, login, signOut, lastLogin, role, name }
}
