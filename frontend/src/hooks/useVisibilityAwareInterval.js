import { useEffect, useRef } from 'react'

export function useVisibilityAwareInterval(callback, delayMs, { enabled = true, fireOnVisible = true } = {}) {
  const cbRef = useRef(callback)
  useEffect(() => { cbRef.current = callback }, [callback])

  useEffect(() => {
    if (!enabled || !delayMs || delayMs <= 0) return
    let intervalId = null
    let lastFiredAt = Date.now()

    const tick = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        lastFiredAt = Date.now()
        try { cbRef.current() } catch (e) { console.error(e) }
      }
    }

    const start = () => {
      if (intervalId != null) return
      intervalId = setInterval(tick, delayMs)
    }
    const stop = () => {
      if (intervalId != null) { clearInterval(intervalId); intervalId = null }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        if (fireOnVisible && Date.now() - lastFiredAt >= delayMs) tick()
        start()
      } else {
        stop()
      }
    }

    if (typeof document === 'undefined' || document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [delayMs, enabled, fireOnVisible])
}
