// components/us/backtest/UsBacktestSummary.tsx
//
// 抽出条件全体 (ページ単位ではない) のサーバー集計をそのまま並べる要約帯。
// - 到達率と平均値の分母は「結果あり」の件数。null は N/A と明示し 0% にしない
// - 到達条件で絞り込んでいる場合、その到達率は条件上 100% になる旨を添える

import { fmtPct } from '@/components/us/UsMarketMomentumParts'
import {
  DOWN_TEXT,
  MUTED_TEXT,
  UP_TEXT,
  fmtCount,
  fmtRate,
  type UsBacktestFilterState,
  type UsBacktestQueryResponse,
} from '@/components/us/backtest/usBacktestShared'

type Cell = {
  label: string
  value: string | null
  sub: string
  tone?: 'up' | 'down'
}

function signTone(value: number | null | undefined): Cell['tone'] {
  if (value == null || value === 0) return undefined
  return value > 0 ? 'up' : 'down'
}

export function UsBacktestSummary({
  summary,
  appliedTarget,
  loading,
}: {
  summary: UsBacktestQueryResponse['summary'] | null
  appliedTarget: UsBacktestFilterState['targetPct']
  loading: boolean
}) {
  const withOutcome = summary?.withOutcome ?? 0
  const basis = summary ? `結果あり ${fmtCount(withOutcome)}件で算出` : ''
  const hitSub = (target: '10' | '20' | '40') => appliedTarget === target ? '到達条件で絞込中（条件上100%）' : basis
  const cells: Cell[] = [
    {
      label: '抽出件数',
      value: summary ? `${fmtCount(summary.count)}件` : null,
      sub: summary ? `結果あり ${fmtCount(withOutcome)} / 未取得 ${fmtCount(summary.count - withOutcome)}` : '',
    },
    { label: '+10% 到達率', value: fmtRate(summary?.hit10Rate ?? null), sub: hitSub('10') },
    { label: '+20% 到達率', value: fmtRate(summary?.hit20Rate ?? null), sub: hitSub('20') },
    { label: '+40% 到達率', value: fmtRate(summary?.hit40Rate ?? null), sub: hitSub('40') },
    {
      label: '平均 最大上昇',
      value: summary?.avgMaxReturnPct == null ? null : fmtPct(summary.avgMaxReturnPct),
      sub: summary?.avgDaysToMax == null ? '平均到達 N/A' : `平均到達 ${summary.avgDaysToMax.toFixed(1)}営業日`,
      tone: signTone(summary?.avgMaxReturnPct),
    },
    {
      label: '平均 最大下落',
      value: summary?.avgMinReturnPct == null ? null : fmtPct(summary.avgMinReturnPct),
      sub: basis,
      tone: signTone(summary?.avgMinReturnPct),
    },
  ]

  return (
    <dl
      aria-label="抽出結果の集計"
      aria-busy={loading}
      className={`m-0 grid min-w-0 grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-border-soft)] sm:grid-cols-3 xl:grid-cols-6 ${loading ? 'opacity-60' : ''}`}
    >
      {cells.map((cell) => (
        <div key={cell.label} className="min-w-0 bg-[var(--color-surface-subtle)] px-3 py-2">
          <dt className={`truncate text-[11px] font-semibold ${MUTED_TEXT}`}>{cell.label}</dt>
          <dd className="m-0">
            {cell.value == null ? (
              <span className={`block text-[18px] font-bold leading-6 ${MUTED_TEXT}`} title="データなし">N/A</span>
            ) : (
              <span
                className={`block truncate font-mono text-[18px] font-bold leading-6 tabular-nums ${
                  cell.tone === 'up' ? UP_TEXT : cell.tone === 'down' ? DOWN_TEXT : 'text-[var(--color-text-primary)]'
                }`}
              >
                {cell.value}
              </span>
            )}
            <span className={`block min-h-4 truncate text-[10px] leading-4 ${MUTED_TEXT}`} title={cell.sub || undefined}>{cell.sub}</span>
          </dd>
        </div>
      ))}
    </dl>
  )
}
