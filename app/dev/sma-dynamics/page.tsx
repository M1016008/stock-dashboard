import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { SmaDynamicsPreviewClient } from './SmaDynamicsPreviewClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'SMA ダイナミクス プレビュー (開発用)',
  robots: { index: false, follow: false },
}

// Development-only fixture preview. Production builds and share mode resolve to 404.
export default function SmaDynamicsPreviewPage() {
  if (process.env.NODE_ENV === 'production' || process.env.STOCKBOARD_SHARE_MODE === '1') notFound()
  return <SmaDynamicsPreviewClient />
}
