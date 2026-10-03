'use client'

import { useRouter } from 'next/navigation'
import { LoaderCircle, Trash2 } from 'lucide-react'
import { useState } from 'react'

export function ArchiveTradeScenarioButton({
  id,
  label,
  className = '',
}: {
  id: string
  label: string
  className?: string
}) {
  const router = useRouter()
  const [archiving, setArchiving] = useState(false)
  const [error, setError] = useState('')

  async function archive() {
    const confirmed = window.confirm(
      `「${label}」の完了シナリオを一覧から削除しますか？\n履歴データはアーカイブとして保持されます。`,
    )
    if (!confirmed) return

    setArchiving(true)
    setError('')
    try {
      const response = await fetch(`/api/trade/scenarios/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'archived' }),
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload.message ?? payload.error ?? `HTTP ${response.status}`)
      }
      router.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '削除できませんでした')
      setArchiving(false)
    }
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={archive}
        disabled={archiving}
        className="inline-flex h-7 w-7 items-center justify-center text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-price-down-bg)] hover:text-[var(--color-price-down)] disabled:cursor-wait disabled:opacity-50"
        aria-label={`${label}の完了シナリオを削除`}
        title="完了シナリオを削除"
      >
        {archiving
          ? <LoaderCircle size={14} className="animate-spin" />
          : <Trash2 size={14} />}
      </button>
      {error && (
        <div role="alert" className="mt-1 max-w-[180px] text-right text-[9px] font-bold text-[var(--color-price-down)]">
          {error}
        </div>
      )}
    </div>
  )
}
