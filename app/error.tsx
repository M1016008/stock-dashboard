'use client' // Error boundaries must be Client Components

// 想定外の実行時エラー。ヘッダーとナビは残したまま、本文だけを差し替える。
// サーバー側エラーの詳細は本番では伏せられるため、照合用の digest だけを表示する。

import Link from 'next/link'
import { useEffect } from 'react'
import { RefreshCw, TriangleAlert } from 'lucide-react'

export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <header className="page-header">
        <div className="page-header__row">
          <div className="page-header__copy">
            <p className="page-header__eyebrow">エラー</p>
            <div className="page-header__title"><h1>画面を表示できませんでした</h1></div>
            <p className="page-header__desc">データの読み込み中に問題が発生しました。少し時間をおいて再試行してください。</p>
          </div>
        </div>
      </header>
      <div className="rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white">
        <div className="empty-state" role="alert">
          <TriangleAlert size={22} aria-hidden />
          <p className="empty-state__title">一時的なエラーの可能性があります</p>
          <p className="empty-state__desc">
            再試行で解消しない場合は、データ鮮度の表示や運用ステータスを確認してください。
            {error.digest && <><br /><span className="font-mono text-[12px] text-[var(--color-text-tertiary)]">エラーID {error.digest}</span></>}
          </p>
          <div className="mt-1 flex flex-wrap justify-center gap-2">
            <button type="button" onClick={() => retry()} className="btn" data-variant="primary">
              <RefreshCw size={14} aria-hidden />
              再試行
            </button>
            <Link href="/" prefetch={false} className="btn">ダッシュボードへ</Link>
          </div>
        </div>
      </div>
    </div>
  )
}
