// components/us/UsRouteErrorState.tsx
//
// 米国株画面の想定外エラー (app/us/error.tsx) の表示。
// - 例外オブジェクトは受け取らない。メッセージ・スタックは構造上ここへ届かない
// - 照合用の digest は英数字だけのときに限って表示する
// - 操作は「再試行」1 つだけ。別画面への遷移や代替データの表示はしない

import { RefreshCw, TriangleAlert } from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { EmptyState } from '@/components/ui/EmptyState'

const SAFE_DIGEST = /^[A-Za-z0-9_-]{1,64}$/

/** 画面に出してよい digest だけを返す。それ以外 (空・記号・長すぎる値) は伏せる */
export function safeErrorDigest(digest: unknown): string | null {
  return typeof digest === 'string' && SAFE_DIGEST.test(digest) ? digest : null
}

/** ブラウザのコンソールへは固定ラベルと安全な digest だけを出す。例外本体・メッセージ・スタックは渡さない */
export function logUsRouteError(digest: unknown): void {
  console.error('[us-route-error]', safeErrorDigest(digest) ?? 'no-digest')
}

export function UsRouteErrorState({
  digest,
  onRetry,
}: {
  digest?: string | null
  onRetry: () => void
}) {
  const shownDigest = safeErrorDigest(digest)
  return (
    <div className="flex w-full min-w-0 flex-col gap-5" data-us-route-state="error">
      <PageTitle
        eyebrow="米国株"
        title="画面を表示できませんでした"
        subtitle="米国株データの読み込み中、または表示の途中で問題が発生しました。"
        badge="エラー"
        badgeTone="danger"
      />
      <div role="alert" className="rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white">
        <EmptyState
          icon={<TriangleAlert size={22} aria-hidden />}
          title="一時的な問題の可能性があります"
          description={(
            <>
              欠けた値を 0 や古いデータで補った表示はしていません。再試行で解消しない場合は、時間をおいて開き直してください。
              {shownDigest && (
                <>
                  <br />
                  <span className="font-mono text-[12px] text-[var(--color-text-tertiary)]">エラーID {shownDigest}</span>
                </>
              )}
            </>
          )}
          action={(
            <button type="button" onClick={onRetry} className="btn mt-1" data-variant="primary">
              <RefreshCw size={14} aria-hidden />
              再試行
            </button>
          )}
        />
      </div>
    </div>
  )
}
