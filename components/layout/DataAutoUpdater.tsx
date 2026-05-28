'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useRef } from 'react'

const POLL_INTERVAL_MS = 30 * 1000
const MAX_POLLS = 60

type FreshnessResponse = {
  needsUpdate: boolean
  running: boolean
}

export function DataAutoUpdater() {
  const router = useRouter()
  const pathname = usePathname()
  const refreshedRef = useRef(false)
  const startedRef = useRef(false)

  useEffect(() => {
    if (pathname.startsWith('/us')) return
    let cancelled = false
    let pollTimer: number | undefined

    async function readFreshness(): Promise<FreshnessResponse | null> {
      try {
        const res = await fetch('/api/admin/update-latest', {
          cache: 'no-store',
        })
        if (!res.ok) return null
        return res.json() as Promise<FreshnessResponse>
      } catch (err) {
        console.warn('Data freshness monitor failed', err)
        return null
      }
    }

    async function startUpdate(): Promise<void> {
      if (startedRef.current) return
      startedRef.current = true
      try {
        await fetch('/api/admin/update-latest', {
          method: 'POST',
          cache: 'no-store',
        })
      } catch (err) {
        console.warn('Data freshness repair failed', err)
      }
    }

    async function checkAndStartUpdate() {
      const freshness = await readFreshness()
      if (cancelled || !freshness) return
      if (!freshness.running && freshness.needsUpdate) {
        await startUpdate()
      }
      if (cancelled || (!freshness.running && !freshness.needsUpdate)) return
      try {
        await pollUntilFresh(0)
      } catch (err) {
        console.warn('Data freshness monitor failed', err)
      }
    }

    async function pollUntilFresh(count: number) {
      if (cancelled || count >= MAX_POLLS) return

      const freshness = await readFreshness()
      if (!freshness) return

      if (cancelled) return
      if (!freshness.needsUpdate && !freshness.running && !refreshedRef.current) {
        refreshedRef.current = true
        router.refresh()
        return
      }
      if (!freshness.running) {
        if (freshness.needsUpdate && startedRef.current) {
          pollTimer = window.setTimeout(() => {
            void pollUntilFresh(count + 1)
          }, POLL_INTERVAL_MS)
        }
        return
      }

      pollTimer = window.setTimeout(async () => {
        const latest = await readFreshness()

        if (cancelled || !latest) return
        if (!latest.needsUpdate && !latest.running && !refreshedRef.current) {
          refreshedRef.current = true
          router.refresh()
          return
        }
        if (latest.running) await pollUntilFresh(count + 1)
        if (!latest.running && latest.needsUpdate && startedRef.current) await pollUntilFresh(count + 1)
      }, POLL_INTERVAL_MS)
    }

    checkAndStartUpdate()

    return () => {
      cancelled = true
      if (pollTimer) window.clearTimeout(pollTimer)
    }
  }, [pathname, router])

  return null
}
