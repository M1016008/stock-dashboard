import type { Metadata } from 'next'
import { UsAnalysisNav } from '@/components/us/UsAnalysisNav'
import { loadUsBacktestAnalysis } from '@/lib/server/us-analysis-dashboard'

export const metadata: Metadata = {
  title: 'US過去検証 — StockBoard',
  description: '米国株ML、物理状態、RL、類似局面のアウトオブサンプル評価',
}
export const dynamic = 'force-dynamic'
export const revalidate = 0

function pct(value: number | null, scale = 100, digits = 1): string {
  if (value == null) return '-'
  return `${(value * scale).toFixed(digits)}%`
}

function rawPct(value: number | null): string {
  if (value == null) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

export default async function UsBacktestPage() {
  const analysis = await loadUsBacktestAnalysis()
  return (
    <div className="sb-page">
      <div className="sb-page-title">
        <h1>US過去検証</h1>
        <p>US分析DBのモデル評価、物理状態、RL方策、類似局面の事後成績を分離して検証します。</p>
      </div>
      <UsAnalysisNav current="/us/analysis/backtest" />

      {!analysis.servingDate && (
        <div className="border-l-4 border-amber-500 bg-amber-50 px-4 py-3 text-[12px] font-bold text-amber-950">
          USシグナル別サービング統計は全履歴生成中です。以下には、すでに生成済みのUS ML評価だけを表示しています。JP検証結果は混在させません。
        </div>
      )}

      <section>
        <div className="sb-hd">
          <h2>MLモデル評価</h2>
          <span>{analysis.modelEvaluations[0]?.evaluationDate ?? '未生成'}</span>
        </div>
        <div className="overflow-x-auto border border-[var(--color-border-default)] bg-white">
          <table className="w-full min-w-[820px] text-left text-[11px]">
            <thead className="bg-[var(--color-surface-subtle)] text-[10px] font-black text-[var(--color-text-tertiary)]">
              <tr><th className="px-3 py-2">モデル</th><th className="px-3 py-2">方向</th><th className="px-3 py-2">期間</th><th className="px-3 py-2">標本</th><th className="px-3 py-2">P@20</th><th className="px-3 py-2">P@50</th><th className="px-3 py-2">勝率</th><th className="px-3 py-2">中央値</th><th className="px-3 py-2">最大DD</th></tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-soft)]">
              {analysis.modelEvaluations.map((row) => (
                <tr key={`${row.modelType}-${row.direction}-${row.horizonDays}`}>
                  <td className="px-3 py-2 font-bold">{row.modelType}</td><td className="px-3 py-2">{row.direction}</td><td className="px-3 py-2">{row.horizonDays}日</td>
                  <td className="px-3 py-2 tabular-nums">{row.sampleCount.toLocaleString()}</td><td className="px-3 py-2">{pct(row.precisionAt20)}</td>
                  <td className="px-3 py-2">{pct(row.precisionAt50)}</td><td className="px-3 py-2">{pct(row.hitRate)}</td>
                  <td className="px-3 py-2">{rawPct(row.medianReturnPct)}</td><td className="px-3 py-2">{rawPct(row.maxDrawdownPct)}</td>
                </tr>
              ))}
              {analysis.modelEvaluations.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-5 text-center font-semibold text-[var(--color-text-secondary)]">
                    価格基準日以前のUSモデル評価を生成中です。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div className="sb-hd">
          <h2>物理状態別の事後成績</h2>
          <span>{analysis.physicsStatus[0]?.evaluationDate ?? '未生成'}</span>
        </div>
        <div className="overflow-x-auto border border-[var(--color-border-default)] bg-white">
          <table className="w-full min-w-[780px] text-left text-[11px]">
            <thead className="bg-[var(--color-surface-subtle)] text-[10px] font-black text-[var(--color-text-tertiary)]">
              <tr><th className="px-3 py-2">状態</th><th className="px-3 py-2">方向</th><th className="px-3 py-2">期間</th><th className="px-3 py-2">標本</th><th className="px-3 py-2">命中率</th><th className="px-3 py-2">基準率</th><th className="px-3 py-2">Lift</th><th className="px-3 py-2">中央値</th><th className="px-3 py-2">平均最大上昇</th><th className="px-3 py-2">平均最大下落</th></tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-soft)]">
              {analysis.physicsStatus.map((row) => (
                <tr key={`${row.statusLabel}-${row.targetDirection}-${row.horizonDays}`}>
                  <td className="px-3 py-2 font-bold">{row.statusLabel}</td><td className="px-3 py-2">{row.targetDirection}</td><td className="px-3 py-2">{row.horizonDays}日</td>
                  <td className="px-3 py-2 tabular-nums">{row.sampleCount.toLocaleString()}</td><td className="px-3 py-2">{pct(row.hitRate)}</td>
                  <td className="px-3 py-2">{pct(row.baseRate)}</td><td className="px-3 py-2 font-black">{row.lift?.toFixed(2) ?? '-'}</td>
                  <td className="px-3 py-2">{rawPct(row.medianReturnPct)}</td><td className="px-3 py-2">{rawPct(row.avgMaxReturnPct)}</td><td className="px-3 py-2">{rawPct(row.avgMinReturnPct)}</td>
                </tr>
              ))}
              {analysis.physicsStatus.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-3 py-5 text-center font-semibold text-[var(--color-text-secondary)]">
                    価格基準日以前のUS物理状態評価を生成中です。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div>
          <div className="sb-hd"><h2>RL方策評価</h2><span>{analysis.rlEvaluations[0]?.evaluationDate ?? '未生成'}</span></div>
          <div className="divide-y divide-[var(--color-border-soft)] border border-[var(--color-border-default)] bg-white">
            {analysis.rlEvaluations.map((row) => (
              <div key={`${row.policyName}-${row.horizonDays}`} className="grid grid-cols-[1fr_repeat(3,auto)] items-center gap-3 px-3 py-2 text-[11px]">
                <span className="font-bold">{row.policyName} / {row.horizonDays}日</span>
                <span>勝率 {pct(row.winRate)}</span><span>平均 {rawPct(row.avgReturnPct)}</span><span>DD {rawPct(row.maxDrawdownPct)}</span>
              </div>
            ))}
            {analysis.rlEvaluations.length === 0 && <div className="p-5 text-[12px] font-semibold text-[var(--color-text-secondary)]">US RL評価を生成中です。</div>}
          </div>
        </div>
        <div>
          <div className="sb-hd"><h2>類似局面評価</h2><span>{analysis.similarityEvaluations[0]?.asOfDate ?? '未生成'}</span></div>
          <div className="divide-y divide-[var(--color-border-soft)] border border-[var(--color-border-default)] bg-white">
            {analysis.similarityEvaluations.map((row) => (
              <div key={`${row.source}-${row.horizonDays}`} className="grid grid-cols-[1fr_repeat(3,auto)] items-center gap-3 px-3 py-2 text-[11px]">
                <span className="font-bold">{row.source} / {row.horizonDays}日</span>
                <span>{row.pairCount.toLocaleString()}組</span><span>上昇 {pct(row.upRate)}</span><span>中央値 {rawPct(row.medianReturnPct)}</span>
              </div>
            ))}
            {analysis.similarityEvaluations.length === 0 && <div className="p-5 text-[12px] font-semibold text-[var(--color-text-secondary)]">US類似局面評価を生成中です。</div>}
          </div>
        </div>
      </section>
    </div>
  )
}
