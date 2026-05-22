'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

const POLL_INTERVAL_MS = 30 * 1000
const MAX_POLLS = 60

type FreshnessResponse = {
  needsUpdate: boolean
  running: boolean
}

export function DataAutoUpdater() {
  const router = useRouter()

  useEffect(() => {
    let cancelled = false
    let pollTimer: number | undefined

    async function checkAndStartUpdate() {
      try {
        const freshness = await fetch('/api/admin/update-latest', {
          cache: 'no-store',
        }).then((res) => res.json() as Promise<FreshnessResponse>)

        if (cancelled || (!freshness.needsUpdate && !freshness.running)) return
        await pollUntilFresh(0)
      } catch (err) {
        console.warn('Data freshness monitor failed', err)
      }
    }

    async function pollUntilFresh(count: number) {
      if (cancelled || count >= MAX_POLLS) return

      const freshness = await fetch('/api/admin/update-latest', {
        cache: 'no-store',
      }).then((res) => res.json() as Promise<FreshnessResponse>)

      if (cancelled || (!freshness.needsUpdate && !freshness.running)) {
        router.refresh()
        return
      }

      pollTimer = window.setTimeout(async () => {
        const latest = await fetch('/api/admin/update-latest', {
          cache: 'no-store',
        }).then((res) => res.json() as Promise<FreshnessResponse>)

        if (cancelled) return
        if (!latest.needsUpdate && !latest.running) {
          router.refresh()
          return
        }
        await pollUntilFresh(count + 1)
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
