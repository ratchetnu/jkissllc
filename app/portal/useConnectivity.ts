'use client'

import { useEffect, useState } from 'react'

export function useConnectivity(): { offline: boolean } {
  // Unknown during SSR/hydration is treated as online so the first client render
  // matches. The effect then applies the browser's real state.
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    const sync = () => setOffline(!navigator.onLine)
    sync()
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => {
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
    }
  }, [])

  return { offline }
}
