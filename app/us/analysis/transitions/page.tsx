import type { Metadata } from 'next'
import { UsAnalysisNav } from '@/components/us/UsAnalysisNav'
import { PageTitle } from '@/components/layout/PageTitle'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { StageTag } from '@/components/ui/StageTag'
import { EmptyState, Notice } from '@/components/ui/EmptyState'
import { loadUsTransitionAnalysis } from '@/lib/server/us-analysis-dashboard'

export const metadata: Metadata = {
  title: 'USステージ遷移 — StockBoard',
  description: '米国株の日足・週足・月足6ステージ構造と遷移を分析',
}
export const dynamic = 'force-dynamic'
export const revalidate = 0

const AXES = [
  ['daily_a', '日足A'],
  ['daily_b', '日足B'],
  ['weekly_a', '週足A'],
  ['weekly_b', '週足B'],
  ['monthly_a', '月足A'],
  ['monthly_b', '月足B'],
] as const

function fmtReturn(value: number | null): string {
  if (value == null) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

/** 6桁のステージ列はタグで、それ以外の形式はコードのまま表示する */
function PatternCode({ code }: { code: string }) {
  if (!/^[1-6]{6}$/.test(code)) return <span className="font-mono text-[13px] font-semibold">{code}</span>
  return (
    <span className="inline-flex shrink-0 gap-0.5" aria-label={`パターン ${code}`} title={code}>
      {code.split('').map((digit, index) => (
        <StageTag key={`${digit}-${index}`} stage={Number(digit)} size="xs" />
      ))}
    </span>
  )
}

function returnTone(value: number | null): string {
  if (value == null || value === 0) return 'text-[var(--color-text-secondary)]'
  return value > 0 ? 'text-[var(--color-price-up)]' : 'text-[var(--color-price-down)]'
}

export default async function UsTransitionsPage() {
  const analysis = await loadUsTransitionAnalysis()
  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageTitle
        eyebrow="米国株"
        title="USステージ遷移"
        subtitle="US銘柄の日足・週足・月足6軸を使い、現在の分布と過去の遷移を確認します。"
        meta={<span>基準日 {analysis.date ?? '未生成'}</span>}
      >
        <UsAnalysisNav current="/us/analysis/transitions" />
      </PageTitle>

      <section aria-labelledby="us-pattern-dist-title" className="flex min-w-0 flex-col gap-3">
        <SectionHeader
          id="us-pattern-dist-title"
          level={1}
          title="現在の6軸パターン"
          description="並び: 日A 日B 週A 週B 月A 月B / 銘柄数の多い上位30"
        />
        {analysis.distribution.length === 0 ? (
          <EmptyState title="現在の6軸パターンはまだ生成されていません" description="USスナップショットの生成後に表示されます。" />
        ) : (
          <ol className="grid gap-px overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-border-soft)] sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {analysis.distribution.map((row, index) => (
              <li key={row.patternCode} className="flex min-w-0 items-center gap-3 bg-white px-3 py-2.5">
                <span className="w-6 shrink-0 text-right font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">{index + 1}</span>
                <PatternCode code={row.patternCode} />
                <span className="ml-auto whitespace-nowrap font-mono text-[13px] font-semibold tabular-nums text-[var(--color-text-primary)]">
                  {row.count.toLocaleString()}<span className="ml-0.5 font-sans text-[11px] font-normal text-[var(--color-text-tertiary)]">銘柄</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="us-transition-matrix-title" className="flex min-w-0 flex-col gap-3">
        <SectionHeader
          id="us-transition-matrix-title"
          level={1}
          title="ステージ遷移行列"
          description="行=遷移元、列=遷移先。全履歴の回数で、色の濃さは軸ごとの最大値に対する比率"
        />
        {analysis.transitions.length === 0 ? (
          <Notice tone="warning" title="US全履歴の遷移集計を生成中です">
            週次MLの正式工程で生成します。JP統計へのフォールバック表示は行いません。
          </Notice>
        ) : (
          <div className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {AXES.map(([axis, label]) => {
              const rows = analysis.transitions.filter((row) => row.axis === axis)
              const max = Math.max(1, ...rows.map((row) => row.count))
              return (
                <div key={axis} className="panel">
                  <div className="panel-head"><h3>{label}</h3></div>
                  <div className="grid grid-cols-7 gap-1 p-3 text-center text-[11px]">
                    <span className="flex items-center justify-center text-[10px] text-[var(--color-text-tertiary)]">元＼先</span>
                    {[1, 2, 3, 4, 5, 6].map((stage) => <span key={stage} className="flex items-center justify-center"><StageTag stage={stage} size="xs" /></span>)}
                    {[1, 2, 3, 4, 5, 6].flatMap((from) => [
                      <span key={`label-${from}`} className="flex items-center justify-center"><StageTag stage={from} size="xs" /></span>,
                      ...[1, 2, 3, 4, 5, 6].map((to) => {
                        const count = rows.find((row) => row.fromStage === from && row.toStage === to)?.count ?? 0
                        const opacity = 0.08 + 0.82 * count / max
                        return (
                          <span
                            key={`${from}-${to}`}
                            className="flex h-8 items-center justify-center rounded-[3px] font-mono font-semibold tabular-nums"
                            style={{ backgroundColor: `rgba(0,75,147,${opacity.toFixed(3)})`, color: opacity > 0.55 ? 'white' : 'var(--color-text-primary)' }}
                            title={`${label}: ${from}→${to} / ${count.toLocaleString()}回`}
                          >
                            {count > 999 ? `${Math.round(count / 1000)}k` : count}
                          </span>
                        )
                      }),
                    ])}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section aria-labelledby="us-pattern-stats-title" className="flex min-w-0 flex-col gap-3">
        <SectionHeader
          id="us-pattern-stats-title"
          level={1}
          title="60営業日後のパターン統計"
          description="US全履歴。各パターンの60営業日後リターンの分位"
        />
        {analysis.patterns.length === 0 ? (
          <EmptyState title="USパターン統計を生成中です" description="生成完了までは現在分布のみ利用できます。" />
        ) : (
          <div className="table-scroll rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white">
            <table className="w-full min-w-[620px] text-left text-[13px]">
              <thead className="text-[11px] text-[var(--color-text-tertiary)]">
                <tr className="border-b border-[var(--color-border-default)]">
                  <th className="px-4 py-2 font-semibold">パターン</th>
                  <th className="px-3 py-2 text-right font-semibold">標本数</th>
                  <th className="px-3 py-2 text-right font-semibold">25%</th>
                  <th className="px-3 py-2 text-right font-semibold">中央値</th>
                  <th className="px-4 py-2 text-right font-semibold">75%</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-soft)]">
                {analysis.patterns.map((row) => (
                  <tr key={row.patternCode} className="hover:bg-[var(--color-surface-subtle)]">
                    <td className="px-4 py-2"><PatternCode code={row.patternCode} /></td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{row.count.toLocaleString()}</td>
                    <td className={`px-3 py-2 text-right font-mono tabular-nums ${returnTone(row.p25)}`}>{fmtReturn(row.p25)}</td>
                    <td className={`px-3 py-2 text-right font-mono font-semibold tabular-nums ${returnTone(row.p50)}`}>{fmtReturn(row.p50)}</td>
                    <td className={`px-4 py-2 text-right font-mono tabular-nums ${returnTone(row.p75)}`}>{fmtReturn(row.p75)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
