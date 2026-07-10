'use client'

import { useCallback, useEffect, useState } from 'react'
import { useIdleLogout } from '../admin/useIdleLogout'

// Crew portal auth — mirrors useAdminSession but scoped to a crew principal.
// The same signed cookie is used; /api/portal/me admits only crew (role + staffId).
export type LoginRecord = { at: number; device: string | null }
export type CrewMe = {
  id: string; name: string; email: string | null; phone: string | null
  role: string | null; photoUrl: string | null; onboarding: boolean
}

export function usePortalSession() {
  const [me, setMe] = useState<CrewMe | null>(null)
  const [authed, setAuthed] = useState(false)
  const [checked, setChecked] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [lastLogin, setLastLogin] = useState<LoginRecord | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/portal/me', { credentials: 'same-origin' })
      if (res.ok) {
        const d = await res.json()
        setMe(d.crew ?? null); setAuthed(true); setLastLogin(d.lastLogin ?? null)
      } else {
        setAuthed(false); setMe(null)
      }
    } catch { setAuthed(false) } finally { setChecked(true) }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const login = useCallback(async (email: string, password: string): Promise<boolean> => {
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ email: email.trim(), password }),
      })
      const d = await res.json()
      if (res.ok && d.ok) {
        if (d.role !== 'crew') { window.location.href = '/admin/operations'; return true }
        await refresh(); return true
      }
      setError(d.error ?? 'Incorrect email or password'); return false
    } catch { setError('Connection error — try again'); return false }
    finally { setLoading(false) }
  }, [refresh])

  const signOut = useCallback(async () => {
    try { await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }) } catch {}
    setAuthed(false); setMe(null)
  }, [])

  useIdleLogout(authed, signOut, 10 * 60_000, '/api/portal/me')

  return { me, authed, checked, error, loading, login, signOut, lastLogin }
}
