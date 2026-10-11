'use client'

import { useEffect, useState } from 'react'
import { Eye, X } from 'lucide-react'
import { isFriendReadonlyRequestAllowed } from '@/lib/friend-readonly-policy'

type Props = {
  enabled: boolean
}

const BLOCKED_MESSAGE = '友人向けサイトは閲覧専用です。この操作は保存・実行されません。'

export function FriendReadonlyAccessBoundary({ enabled }: Props) {
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return

    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null
      const method = String(init?.method ?? request?.method ?? 'GET').toUpperCase()
      const url = request?.url ?? String(input)
      if (!isFriendReadonlyRequestAllowed(method, url)) {
        window.dispatchEvent(new CustomEvent('stockboard:friend-write-blocked'))
        return new Response(JSON.stringify({ error: 'READ_ONLY_ACCESS', message: BLOCKED_MESSAGE }), {
          status: 405,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
      }
      return originalFetch(input, init)
    }

    const onBlocked = () => {
      setBlockedMessage(BLOCKED_MESSAGE)
      window.setTimeout(() => setBlockedMessage(null), 5000)
    }
    const onSubmit = (event: SubmitEvent) => {
      const form = event.target instanceof HTMLFormElement ? event.target : null
      if (!form || form.method.toUpperCase() === 'GET') return
      event.preventDefault()
      event.stopPropagation()
      onBlocked()
    }
    window.addEventListener('stockboard:friend-write-blocked', onBlocked)
    document.addEventListener('submit', onSubmit, true)
    return () => {
      window.fetch = originalFetch
      window.removeEventListener('stockboard:friend-write-blocked', onBlocked)
      document.removeEventListener('submit', onSubmit, true)
    }
  }, [enabled])

  if (!enabled) return null

  return (
    <>
      <div
        role="status"
        className="border-b border-[#a9bfdc] bg-[#eef4fb] px-4 py-1.5 text-[11px] font-semibold text-[#234a78]"
      >
        <div className="page-wide flex items-center gap-2 px-0">
          <Eye size={14} aria-hidden="true" />
          <span>友人向け閲覧モード</span>
          <span className="font-normal text-[#48698f]">検索・比較は利用できます。保存、更新、削除、AI送信は行われません。</span>
        </div>
      </div>
      {blockedMessage && (
        <div
          role="alert"
          className="fixed right-4 top-4 z-[100] flex max-w-[360px] items-start gap-3 border border-[#9eb5d2] bg-white px-3 py-2.5 text-[12px] font-semibold text-[#234a78] shadow-[0_12px_28px_rgba(23,48,78,0.2)]"
        >
          <Eye size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{blockedMessage}</span>
          <button
            type="button"
            onClick={() => setBlockedMessage(null)}
            className="ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center text-[#48698f]"
            aria-label="通知を閉じる"
          >
            <X size={14} />
          </button>
        </div>
      )}
    </>
  )
}
