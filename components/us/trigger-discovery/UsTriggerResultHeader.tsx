'use client'

// components/us/trigger-discovery/UsTriggerResultHeader.tsx
//
// 検索結果の見出し帯。件数・評価日・適用条件・母集団の根拠を 1 か所にまとめる。
// - CURRENT_ACTIVE: 現在上場中の普通株 (現在の銘柄マスタ)
// - TRADING_COVERAGE: 過去日。価格履歴の取引開始〜終了日のカバレッジで母集団を作る。
//   公式な当時の上場銘柄リスト (PIT 構成) ではないことを必ず明示する
// - 件数・除外理由はサーバーの診断値をそのまま表示し、再計算しない

import { History, SlidersHorizontal } from 'lucide-react'
import { StatusTag } from '@/components/layout/PageTitle'
import { Notice } from '@/components/ui/EmptyState'
import { fmtCount } from '@/components/us/UsMarketMomentumParts'
import { FOCUS_RING } from '@/components/us/trigger-discovery/UsTriggerControls'
import {
  REJECTION_LABELS,
  REJECTION_ORDER,
  timeframeLabel,
  usTriggerCriteriaParts,
} from '@/components/us/trigger-discovery/usTriggerDiscoveryShared'
import type { TriggerDiscoverySearchRequest } from '@/lib/trigger-discovery-contract'
import type { UsTriggerDiscoverySearchResponse } from '@/lib/us-trigger-discovery-contract'

export function UsTriggerResultHeader({
  response,
  request,
  exchangeLabel,
  builderOpen,
  onEdit,
}: {
  response: UsTriggerDiscoverySearchResponse
  request: TriggerDiscoverySearchRequest
  exchangeLabel: (value: string | null) => string
  builderOpen: boolean
  onEdit: () => void
}) {
  const { meta, criteria } = response
  const historical = meta.universeBasis === 'TRADING_COVERAGE'
  const adjusted = meta.resolvedAsOf != null && meta.requestedAsOf !== meta.resolvedAsOf
  const criteriaParts = usTriggerCriteriaParts(request, exchangeLabel)
  const rejected = REJECTION_ORDER
    .map((reason) => [reason, meta.rejected[reason] ?? 0] as const)
    .filter(([, count]) => count > 0)
  const funnel = [
    ['母集団', meta.pitUniverseCount],
    ['価格データあり', meta.currentPriceCount + meta.staleAcceptedCount],
    ['株価・流動性条件後', meta.triggerEvaluatedCount],
    ['Trigger一致', meta.triggerMatchedCount],
    ['表示条件後', meta.matchedCount],
  ] as const

  return (
    <div data-us-trigger-result-header className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 id="us-trigger-results-heading" className="inline-flex items-baseline gap-1">
              <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">候補</span>
              <strong className="text-[22px] font-semibold leading-none tabular-nums text-[var(--color-text-primary)]">{fmtCount(meta.matchedCount)}</strong>
              <span className="text-[12px] font-medium text-[var(--color-text-secondary)]">件</span>
            </h2>
            <span className="inline-flex items-baseline gap-1 text-[11px] text-[var(--color-text-tertiary)]">
              評価日
              <strong className="font-mono font-semibold tabular-nums text-[var(--color-text-primary)]">{meta.resolvedAsOf ?? '—'}</strong>
              終値（米国時間）
            </span>
            <span className="text-[11px] font-semibold tabular-nums text-[var(--color-text-secondary)]">
              {timeframeLabel(meta.timeframe)} {criteria.ma1Period}/{criteria.ma2Period}
            </span>
            <StatusTag tone={meta.isLatest ? 'positive' : 'warning'}>{meta.isLatest ? '最新データ' : '過去日'}</StatusTag>
          </div>
          <p className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] leading-5 text-[var(--color-text-tertiary)]">
            <span className="font-semibold text-[var(--color-text-secondary)]">適用条件</span>
            {criteriaParts.map((part, index) => (
              <span key={part} className="whitespace-nowrap">{index > 0 && <span aria-hidden className="mr-2">・</span>}{part}</span>
            ))}
          </p>
        </div>
        {!builderOpen && (
          <button
            type="button"
            data-us-trigger-edit
            aria-expanded={builderOpen}
            aria-controls="us-trigger-builder-region"
            onClick={onEdit}
            className={`btn shrink-0 self-start ${FOCUS_RING}`}
          >
            <SlidersHorizontal size={13} aria-hidden />条件を編集
          </button>
        )}
      </div>

      {historical ? (
        <Notice tone="warning" title="過去日：母集団は価格履歴のカバレッジから作っています">
          <p>
            <span className="font-mono tabular-nums">{meta.resolvedAsOf ?? meta.requestedAsOf}</span> が取引記録の期間（取引開始日〜終了日）に含まれる普通株を母集団にしています。公式な当時の上場銘柄リスト（PIT構成）ではありません。
            取引所は当時の情報がないため、表示・絞り込みに使いません。銘柄名は現在の登録名です。
          </p>
        </Notice>
      ) : (
        <p className="flex items-start gap-1.5 text-[10px] leading-5 text-[var(--color-text-tertiary)]">
          <History size={12} className="mt-1 shrink-0" aria-hidden />
          <span>母集団：現在上場中の米国普通株（現在の銘柄マスタ）。取引所は現在の登録値です。</span>
        </p>
      )}

      {(adjusted || meta.insufficientHistoryCount > 0) && (
        <ul className="flex flex-col gap-0.5 text-[10px] leading-5 text-[var(--color-text-secondary)]">
          {adjusted && (
            <li>
              指定日 <span className="font-mono tabular-nums">{meta.requestedAsOf}</span> の米国市場データがないため、直近の取引日 <strong className="font-mono font-semibold tabular-nums">{meta.resolvedAsOf}</strong> で評価しました。
            </li>
          )}
          {meta.insufficientHistoryCount > 0 && (
            <li>
              移動平均の計算に必要な履歴が足りない <strong className="font-semibold tabular-nums">{fmtCount(meta.insufficientHistoryCount)}</strong> 銘柄は評価できないため除外しています（取引開始から日が浅い銘柄など）。
            </li>
          )}
        </ul>
      )}

      <details className="text-[10px] text-[var(--color-text-tertiary)]">
        <summary className={`w-fit cursor-pointer select-none rounded-[2px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-brand-700)] ${FOCUS_RING}`}>評価の内訳</summary>
        <ol className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 leading-5" aria-label="絞り込みの流れ">
          {funnel.map(([label, count], index) => (
            <li key={label} className="inline-flex items-center gap-1.5 whitespace-nowrap">
              {index > 0 && <span aria-hidden>→</span>}
              <span>{label}</span>
              <strong className="font-semibold tabular-nums text-[var(--color-text-primary)]">{fmtCount(count)}</strong>
            </li>
          ))}
        </ol>
        {meta.staleAcceptedCount > 0 && (
          <p className="mt-1 leading-5">価格データありのうち {fmtCount(meta.staleAcceptedCount)} 銘柄は、評価日の数営業日前の価格で評価しています。</p>
        )}
        {rejected.length > 0 && (
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 leading-5">
            <span className="font-medium text-[var(--color-text-secondary)]">除外理由</span>
            {rejected.map(([reason, count]) => (
              <span key={reason} className="whitespace-nowrap">{REJECTION_LABELS[reason]} <span className="tabular-nums">{fmtCount(count)}</span></span>
            ))}
          </p>
        )}
        <p className="mt-1 leading-5">Trigger Score は条件への適合度で、将来の値動きの予測ではありません。</p>
      </details>
    </div>
  )
}
