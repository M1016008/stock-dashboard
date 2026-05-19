'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect } from 'react'

/**
 * Next の Client Cache / bfcache に残った RSC payload を、画面を開き直すタイミングで捨てる。
 * Server 側は RootLayout の connection() と各 API の no-store で最新 DB を読む。
 */
export function FreshDataRefresher() {
  const router = useRouter()
  usePathname()
  useSearchParams()

  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) router.refresh()
    }

    window.addEventListener('pageshow', onPageShow)
    return () => {
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [router])

  return null
}
