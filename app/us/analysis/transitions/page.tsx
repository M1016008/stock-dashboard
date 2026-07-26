import type { Metadata } from 'next'
import { UsAnalysisNav } from '@/components/us/UsAnalysisNav'
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

export default async function UsTransitionsPage() {
  const analysis = await loadUsTransitionAnalysis()
  return (
    <div className="sb-page">
      <div className="sb-page-title">
        <h1>USステージ遷移</h1>
        <p>US銘柄の日足・週足・月足6軸を使い、現在分布と過去の遷移を確認します。</p>
      </div>
      <UsAnalysisNav current="/us/analysis/transitions" />

      <section>
        <div className="sb-hd">
          <h2>現在の6軸パターン</h2>
          <span>{analysis.date ?? '未生成'} / 上位30</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {analysis.distribution.map((row, index) => (
            <div key={row.patternCode} className="border border-[var(--color-border-default)] bg-white p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-black text-[var(--color-text-tertiary)]">#{index + 1}</span>
                <span className="text-[11px] font-bold tabular-nums">{row.count.toLocaleString()}銘柄</span>
              </div>
              <div className="mt-2 font-mono text-[18px] font-black tracking-normal text-[var(--color-brand-900)]">{row.patternCode}</div>
              <div className="mt-1 text-[9px] font-bold text-[var(--color-text-tertiary)]">日A 日B 週A 週B 月A 月B</div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="sb-hd">
          <h2>ステージ遷移行列</h2>
          <span>全履歴・6軸</span>
        </div>
        {analysis.transitions.length === 0 ? (
          <div className="border-l-4 border-amber-500 bg-amber-50 px-4 py-3 text-[12px] font-bold text-amber-950">
            US全履歴の遷移集計を週次MLの正式工程で生成中です。JP統計へのフォールバック表示は行いません。
          </div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {AXES.map(([axis, label]) => {
              const rows = analysis.transitions.filter((row) => row.axis === axis)
              const max = Math.max(1, ...rows.map((row) => row.count))
              return (
                <div key={axis} className="border border-[var(--color-border-default)] bg-white p-3">
                  <h3 className="text-[13px] font-black text-[var(--color-brand-900)]">{label}</h3>
                  <div className="mt-3 grid grid-cols-7 gap-1 text-center text-[9px]">
                    <span />
                    {[1, 2, 3, 4, 5, 6].map((stage) => <span key={stage} className="font-black">→{stage}</span>)}
                    {[1, 2, 3, 4, 5, 6].flatMap((from) => [
                      <span key={`label-${from}`} className="flex items-center justify-center font-black">{from}</span>,
                      ...[1, 2, 3, 4, 5, 6].map((to) => {
                        const count = rows.find((row) => row.fromStage === from && row.toStage === to)?.count ?? 0
                        const opacity = 0.08 + 0.82 * count / max
                        return (
                          <span
                            key={`${from}-${to}`}
                            className="flex h-8 items-center justify-center border border-[var(--color-border-soft)] font-bold tabular-nums"
                            style={{ backgroundColor: `rgba(37,99,235,${opacity.toFixed(3)})`, color: opacity > 0.55 ? 'white' : 'var(--color-text-primary)' }}
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

      <section>
        <div className="sb-hd">
          <h2>60営業日後のパターン統計</h2>
          <span>US全履歴</span>
        </div>
        {analysis.patterns.length === 0 ? (
          <div className="border border-dashed border-[var(--color-border-default)] bg-white p-5 text-[12px] font-semibold text-[var(--color-text-secondary)]">
            USパターン統計を生成中です。生成完了までは現在分布のみ利用できます。
          </div>
        ) : (
          <div className="overflow-x-auto border border-[var(--color-border-default)] bg-white">
            <table className="w-full min-w-[620px] text-left text-[12px]">
              <thead className="bg-[var(--color-surface-subtle)] text-[10px] font-black text-[var(--color-text-tertiary)]">
                <tr><th className="px-3 py-2">パターン</th><th className="px-3 py-2">標本数</th><th className="px-3 py-2">25%</th><th className="px-3 py-2">中央値</th><th className="px-3 py-2">75%</th></tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-soft)]">
                {analysis.patterns.map((row) => (
                  <tr key={row.patternCode}>
                    <td className="px-3 py-2 font-mono font-black">{row.patternCode}</td>
                    <td className="px-3 py-2 tabular-nums">{row.count.toLocaleString()}</td>
                    <td className="px-3 py-2 tabular-nums">{fmtReturn(row.p25)}</td>
                    <td className="px-3 py-2 font-black tabular-nums">{fmtReturn(row.p50)}</td>
                    <td className="px-3 py-2 tabular-nums">{fmtReturn(row.p75)}</td>
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
