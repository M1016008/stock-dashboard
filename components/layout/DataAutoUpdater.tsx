'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

const ATTEMPT_KEY = 'stockboard:lastAutoUpdateAttempt'
const ATTEMPT_INTERVAL_MS = 30 * 60 * 1000
const POLL_INTERVAL_MS = 30 * 1000
const MAX_POLLS = 60

type FreshnessResponse = {
  needsUpdate: boolean
  running: boolean
}

function recentlyAttempted(): boolean {
  const last = Number(window.localStorage.getItem(ATTEMPT_KEY) ?? 0)
  return Number.isFinite(last) && Date.now() - last < ATTEMPT_INTERVAL_MS
}

function markAttempted() {
  window.localStorage.setItem(ATTEMPT_KEY, String(Date.now()))
}

export function DataAutoUpdater() {
  const router = useRouter()

  useEffect(() => {
    let cancelled = false
    let pollTimer: number | undefined

    async function checkAndStartUpdate() {
      try {
        if (recentlyAttempted()) {
          await pollUntilFresh(0)
          return
        }

        const freshness = await fetch('/api/admin/update-latest', {
          cache: 'no-store',
        }).then((res) => res.json() as Promise<FreshnessResponse>)

        if (cancelled || !freshness.needsUpdate) return
        if (freshness.running) {
          await pollUntilFresh(0)
          return
        }

        markAttempted()
        await fetch('/api/admin/update-latest', {
          method: 'POST',
          cache: 'no-store',
        })
        await pollUntilFresh(0)
      } catch (err) {
        console.warn('Data auto update check failed', err)
      }
    }

    async function pollUntilFresh(count: number) {
      if (cancelled || count >= MAX_POLLS) return

      const freshness = await fetch('/api/admin/update-latest', {
        cache: 'no-store',
      }).then((res) => res.json() as Promise<FreshnessResponse>)

      if (cancelled || !freshness.needsUpdate) return
      if (!freshness.running) return

      pollTimer = window.setTimeout(async () => {
        const latest = await fetch('/api/admin/update-latest', {
          cache: 'no-store',
        }).then((res) => res.json() as Promise<FreshnessResponse>)

        if (cancelled) return
        if (!latest.needsUpdate) {
          router.refresh()
          return
        }
        if (latest.running) {
          await pollUntilFresh(count + 1)
        }
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
