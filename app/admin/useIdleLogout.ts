'use client'

import { useEffect, useRef } from 'react'

// Signs the admin out after a period of no interaction. Any mouse/key/touch/
// scroll activity resets the countdown. The timer keeps running while the tab
// is hidden, so an unattended session still logs out on schedule.
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'wheel'] as const

export function useIdleLogout(enabled: boolean, onIdle: () => void, timeoutMs = 10 * 60_000) {
  const onIdleRef = useRef(onIdle)
  onIdleRef.current = onIdle

  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout>
    let lastPing = 0
    const reset = () => {
      clearTimeout(timer)
      timer = setTimeout(() => onIdleRef.current(), timeoutMs)
      // Heartbeat: while the admin is active, ping the session route (throttled
      // to once per third of the window) so middleware slides the server-side
      // idle timeout forward to match the client timer.
      const now = Date.now()
      if (now - lastPing > timeoutMs / 3) {
        lastPing = now
        fetch('/api/admin/session', { credentials: 'same-origin' }).catch(() => {})
      }
    }
    ACTIVITY_EVENTS.forEach(e => window.addEventListener(e, reset, { passive: true }))
    reset()
    return () => {
      clearTimeout(timer)
      ACTIVITY_EVENTS.forEach(e => window.removeEventListener(e, reset))
    }
  }, [enabled, timeoutMs])
}
