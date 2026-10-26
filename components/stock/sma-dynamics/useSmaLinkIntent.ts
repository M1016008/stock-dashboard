'use client'

// Reads the SMA Dynamics link (lib/sma-dynamics-link) from the page URL after mount. The query is
// never read during render, so server and first client render agree.
import { useEffect, useState } from 'react'
import { parseSmaDynamicsLink, type SmaLinkIntent } from '@/lib/sma-dynamics-link'

/** `scope` (market + ticker) re-reads the URL when the page switches to another security. */
export function useSmaLinkIntent(scope: string): SmaLinkIntent | null {
  const [intent, setIntent] = useState<SmaLinkIntent | null>(null)
  useEffect(() => {
    const read = () => setIntent(parseSmaDynamicsLink(window.location.search))
    read()
    window.addEventListener('popstate', read)
    return () => window.removeEventListener('popstate', read)
  }, [scope])
  return intent
}
