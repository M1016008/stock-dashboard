import type { Metadata } from 'next'
import { PageTitle } from '@/components/layout/PageTitle'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { Notice } from '@/components/ui/EmptyState'
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

function signedTone(value: number | null): string {
  if (value == null || value === 0) return ''
  return value > 0 ? 'text-[var(--color-price-up)]' : 'text-[var(--color-price-down)]'
}

const TH = 'px-3 py-2 font-semibold'
const TH_NUM = 'px-3 py-2 text-right font-semibold'
const TD_NUM = 'px-3 py-2 text-right font-mono tabular-nums'

function EmptyRow({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-8 text-center text-[var(--color-text-secondary)]">{children}</td>
    </tr>
  )
}

export default async function UsBacktestPage() {
  const analysis = await loadUsBacktestAnalysis()
  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageTitle
        eyebrow="米国株"
        title="US過去検証"
        subtitle="US分析DBのモデル評価、物理状態、RL方策、類似局面の事後成績を分離して検証します。"
        meta={<span>サービング統計 {analysis.servingDate ?? '生成中'}</span>}
      >
        <UsAnalysisNav current="/us/analysis/backtest" />
      </PageTitle>

      {!analysis.servingDate && (
        <Notice tone="warning" title="USシグナル別サービング統計は全履歴生成中です">
          以下には、すでに生成済みのUS ML評価だけを表示しています。JP検証結果は混在させません。
        </Notice>
      )}

      <section aria-labelledby="us-bt-model-title" className="flex min-w-0 flex-col gap-3">
        <SectionHeader
          id="us-bt-model-title"
          level={1}
          title="MLモデル評価"
          description={`評価日 ${analysis.modelEvaluations[0]?.evaluationDate ?? '未生成'}`}
        />
        <div className="table-scroll rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white">
          <table className="w-full min-w-[820px] text-left text-[12px]">
            <thead className="text-[11px] text-[var(--color-text-tertiary)]">
              <tr className="border-b border-[var(--color-border-default)]">
                <th className={`${TH} pl-4`}>モデル</th><th className={TH}>方向</th><th className={TH}>期間</th>
                <th className={TH_NUM}>標本</th><th className={TH_NUM}>P@20</th><th className={TH_NUM}>P@50</th>
                <th className={TH_NUM}>勝率</th><th className={TH_NUM}>中央値</th><th className={`${TH_NUM} pr-4`}>最大DD</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-soft)]">
              {analysis.modelEvaluations.map((row) => (
                <tr key={`${row.modelType}-${row.direction}-${row.horizonDays}`} className="hover:bg-[var(--color-surface-subtle)]">
                  <td className="px-3 py-2 pl-4 font-semibold">{row.modelType}</td>
                  <td className="px-3 py-2">{row.direction}</td>
                  <td className="px-3 py-2 tabular-nums">{row.horizonDays}日</td>
                  <td className={TD_NUM}>{row.sampleCount.toLocaleString()}</td>
                  <td className={TD_NUM}>{pct(row.precisionAt20)}</td>
                  <td className={TD_NUM}>{pct(row.precisionAt50)}</td>
                  <td className={`${TD_NUM} font-semibold`}>{pct(row.hitRate)}</td>
                  <td className={`${TD_NUM} ${signedTone(row.medianReturnPct)}`}>{rawPct(row.medianReturnPct)}</td>
                  <td className={`${TD_NUM} pr-4 ${signedTone(row.maxDrawdownPct)}`}>{rawPct(row.maxDrawdownPct)}</td>
                </tr>
              ))}
              {analysis.modelEvaluations.length === 0 && <EmptyRow colSpan={9}>価格基準日以前のUSモデル評価を生成中です。</EmptyRow>}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="us-bt-physics-title" className="flex min-w-0 flex-col gap-3">
        <SectionHeader
          id="us-bt-physics-title"
          level={1}
          title="物理状態別の事後成績"
          description={`評価日 ${analysis.physicsStatus[0]?.evaluationDate ?? '未生成'} / Lift = 命中率 ÷ 基準率`}
        />
        <div className="table-scroll rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white">
          <table className="w-full min-w-[860px] text-left text-[12px]">
            <thead className="text-[11px] text-[var(--color-text-tertiary)]">
              <tr className="border-b border-[var(--color-border-default)]">
                <th className={`${TH} pl-4`}>状態</th><th className={TH}>方向</th><th className={TH}>期間</th>
                <th className={TH_NUM}>標本</th><th className={TH_NUM}>命中率</th><th className={TH_NUM}>基準率</th>
                <th className={TH_NUM}>Lift</th><th className={TH_NUM}>中央値</th><th className={TH_NUM}>平均最大上昇</th>
                <th className={`${TH_NUM} pr-4`}>平均最大下落</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-soft)]">
              {analysis.physicsStatus.map((row) => (
                <tr key={`${row.statusLabel}-${row.targetDirection}-${row.horizonDays}`} className="hover:bg-[var(--color-surface-subtle)]">
                  <td className="px-3 py-2 pl-4 font-semibold">{row.statusLabel}</td>
                  <td className="px-3 py-2">{row.targetDirection}</td>
                  <td className="px-3 py-2 tabular-nums">{row.horizonDays}日</td>
                  <td className={TD_NUM}>{row.sampleCount.toLocaleString()}</td>
                  <td className={TD_NUM}>{pct(row.hitRate)}</td>
                  <td className={`${TD_NUM} text-[var(--color-text-tertiary)]`}>{pct(row.baseRate)}</td>
                  <td className={`${TD_NUM} font-bold text-[var(--color-text-primary)]`}>{row.lift?.toFixed(2) ?? '-'}</td>
                  <td className={`${TD_NUM} ${signedTone(row.medianReturnPct)}`}>{rawPct(row.medianReturnPct)}</td>
                  <td className={`${TD_NUM} ${signedTone(row.avgMaxReturnPct)}`}>{rawPct(row.avgMaxReturnPct)}</td>
                  <td className={`${TD_NUM} pr-4 ${signedTone(row.avgMinReturnPct)}`}>{rawPct(row.avgMinReturnPct)}</td>
                </tr>
              ))}
              {analysis.physicsStatus.length === 0 && <EmptyRow colSpan={10}>価格基準日以前のUS物理状態評価を生成中です。</EmptyRow>}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <section className="panel" aria-labelledby="us-bt-rl-title">
          <div className="panel-head">
            <div className="min-w-0">
              <h2 id="us-bt-rl-title">RL方策評価</h2>
              <p>評価日 {analysis.rlEvaluations[0]?.evaluationDate ?? '未生成'}</p>
            </div>
          </div>
          <div className="table-scroll">
            <table className="w-full min-w-[420px] text-left text-[12px]">
              <thead className="text-[11px] text-[var(--color-text-tertiary)]">
                <tr className="border-b border-[var(--color-border-soft)]">
                  <th className={`${TH} pl-4`}>方策 / 期間</th><th className={TH_NUM}>勝率</th><th className={TH_NUM}>平均</th><th className={`${TH_NUM} pr-4`}>最大DD</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-soft)]">
                {analysis.rlEvaluations.map((row) => (
                  <tr key={`${row.policyName}-${row.horizonDays}`} className="hover:bg-[var(--color-surface-subtle)]">
                    <td className="px-3 py-2 pl-4 font-semibold">{row.policyName} <span className="font-normal text-[var(--color-text-tertiary)]">/ {row.horizonDays}日</span></td>
                    <td className={TD_NUM}>{pct(row.winRate)}</td>
                    <td className={`${TD_NUM} ${signedTone(row.avgReturnPct)}`}>{rawPct(row.avgReturnPct)}</td>
                    <td className={`${TD_NUM} pr-4 ${signedTone(row.maxDrawdownPct)}`}>{rawPct(row.maxDrawdownPct)}</td>
                  </tr>
                ))}
                {analysis.rlEvaluations.length === 0 && <EmptyRow colSpan={4}>US RL評価を生成中です。</EmptyRow>}
              </tbody>
            </table>
          </div>
        </section>
        <section className="panel" aria-labelledby="us-bt-similar-title">
          <div className="panel-head">
            <div className="min-w-0">
              <h2 id="us-bt-similar-title">類似局面評価</h2>
              <p>基準日 {analysis.similarityEvaluations[0]?.asOfDate ?? '未生成'}</p>
            </div>
          </div>
          <div className="table-scroll">
            <table className="w-full min-w-[420px] text-left text-[12px]">
              <thead className="text-[11px] text-[var(--color-text-tertiary)]">
                <tr className="border-b border-[var(--color-border-soft)]">
                  <th className={`${TH} pl-4`}>ソース / 期間</th><th className={TH_NUM}>ペア数</th><th className={TH_NUM}>上昇率</th><th className={`${TH_NUM} pr-4`}>中央値</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-soft)]">
                {analysis.similarityEvaluations.map((row) => (
                  <tr key={`${row.source}-${row.horizonDays}`} className="hover:bg-[var(--color-surface-subtle)]">
                    <td className="px-3 py-2 pl-4 font-semibold">{row.source} <span className="font-normal text-[var(--color-text-tertiary)]">/ {row.horizonDays}日</span></td>
                    <td className={TD_NUM}>{row.pairCount.toLocaleString()}組</td>
                    <td className={TD_NUM}>{pct(row.upRate)}</td>
                    <td className={`${TD_NUM} pr-4 ${signedTone(row.medianReturnPct)}`}>{rawPct(row.medianReturnPct)}</td>
                  </tr>
                ))}
                {analysis.similarityEvaluations.length === 0 && <EmptyRow colSpan={4}>US類似局面評価を生成中です。</EmptyRow>}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  )
}
