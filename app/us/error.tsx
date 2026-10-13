'use client' // Error boundaries must be Client Components

// 米国株 (/us 配下) で捕捉されなかった実行時エラー。ヘッダーとナビは残したまま、本文だけを差し替える。
// 各画面が自前で扱う「空」「未生成」「取得失敗」はここへ来ない。ここは想定外の失敗だけを受ける。
// 例外メッセージは画面にもブラウザのコンソールにも出さず、照合用の digest だけを渡す。

import { useEffect } from 'react'
import { logUsRouteError, UsRouteErrorState } from '@/components/us/UsRouteErrorState'

export default function UsError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  useEffect(() => {
    logUsRouteError(error.digest)
  }, [error.digest])

  return <UsRouteErrorState digest={error.digest} onRetry={() => retry()} />
}
