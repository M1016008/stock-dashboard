'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef } from 'react'

const POLL_INTERVAL_MS = 30 * 1000
const MAX_POLLS = 60

type FreshnessResponse = {
  needsUpdate: boolean
  running: boolean
}

export function DataAutoUpdater() {
  const router = useRouter()
  const refreshedRef = useRef(false)

  useEffect(() => {
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

    async function checkAndStartUpdate() {
      const freshness = await readFreshness()
      if (cancelled || !freshness?.running) return
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
      if (!freshness.running) return

      pollTimer = window.setTimeout(async () => {
        const latest = await readFreshness()

        if (cancelled || !latest) return
        if (!latest.needsUpdate && !latest.running && !refreshedRef.current) {
          refreshedRef.current = true
          router.refresh()
          return
        }
        if (latest.running) await pollUntilFresh(count + 1)
      }, POLL_INTERVAL_MS)
    }

    checkAndStartUpdate()

    return () => {
      cancelled = true
      if (pollTimer) window.clearTimeout(pollTimer)
    }
  }, [router])

  return null
}
