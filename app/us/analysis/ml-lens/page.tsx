import type { Metadata } from 'next'
import Link from 'next/link'
import { Database, Network } from 'lucide-react'
import { PhysicsMlCandidatesPanel } from '@/components/ml/PhysicsMlCandidatesPanel'
import { UsAnalysisNav } from '@/components/us/UsAnalysisNav'
import {
  loadUsAnalysisStatus,
  loadUsCurrentSimilars,
  loadUsModelEvaluations,
  loadUsPhysicsCandidates,
} from '@/lib/server/us-analysis-dashboard'
import { US_ADJUSTED_PRICE_BASIS } from '@/lib/us-adjusted-ohlcv'

export const metadata: Metadata = {
  title: 'US AI Lens — StockBoard',
  description: '米国株のMA物理特徴量、ML候補、類似局面、モデル評価を横断分析',
}
export const dynamic = 'force-dynamic'
export const revalidate = 0

function pct(value: number | null, digits = 1): string {
  if (value == null) return '-'
  return `${(value * 100).toFixed(digits)}%`
}

export default async function UsMlLensPage() {
  const [status, candidates, evaluations, similars] = await Promise.all([
    loadUsAnalysisStatus(),
    loadUsPhysicsCandidates(),
    loadUsModelEvaluations(),
    loadUsCurrentSimilars(),
  ])
  const generationReady = status.priceBasis === US_ADJUSTED_PRICE_BASIS
    && status.derivedPriceBasis === US_ADJUSTED_PRICE_BASIS
    && status.analogPriceBasis === US_ADJUSTED_PRICE_BASIS

  return (
    <div className="sb-page">
      <div className="sb-page-title">
        <h1>US AI Lens</h1>
        <p>US分析DBのMA構造・物理特徴量・ML候補・類似局面だけを横断表示します。</p>
      </div>
      <UsAnalysisNav current="/us/analysis/ml-lens" />

      <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {[
          ['US価格', status.priceDate],
          ['物理特徴量', status.featureDate],
          ['物理ML候補', status.candidateDate],
          ['検証区間終端', status.evaluationDate],
          ['類似局面', status.analogDate],
        ].map(([label, value]) => (
          <div key={label} className="border border-[var(--color-border-default)] bg-white p-3">
            <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
            <div className="mt-1 text-[15px] font-black text-[var(--color-brand-900)]">{value ?? '未生成'}</div>
          </div>
        ))}
      </section>

      {!generationReady && (
        <div className="border-l-4 border-amber-500 bg-amber-50 px-4 py-3 text-[12px] font-bold text-amber-950">
          調整後価格・派生特徴量・類似局面インデックスの世代移行中です。完了済みのUS結果は閲覧できますが、新世代の確定公開は品質検証後に行います。
        </div>
      )}

      <PhysicsMlCandidatesPanel
        market="US"
        status={{
          latestDate: status.featureDate,
          rowsLatest: status.featureRowsLatest,
          candidateDate: status.candidateDate,
          candidateRowsLatest: status.candidateRowsLatest,
        }}
        rows={candidates.map((row) => ({
          as_of_date: row.asOfDate,
          direction: row.direction,
          horizon_days: row.horizonDays,
          rank: row.rank,
          ticker: row.ticker,
          name: row.name,
          sector_large: row.sector,
          candidate_score: row.candidateScore,
          profile: row.profile,
          reason: row.reason,
          explanation: row.explanation,
          analysis: row.analysis,
        }))}
      />

      <section className="grid gap-4 lg:grid-cols-2">
        <div>
          <div className="sb-hd">
            <h2>モデル評価</h2>
            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[var(--color-text-tertiary)]">
              <Database size={15} />
              年次ウォークフォワード検証 / 終端 {status.evaluationDate ?? '未生成'}
            </span>
          </div>
          <div className="overflow-x-auto border border-[var(--color-border-default)] bg-white">
            <table className="w-full min-w-[560px] text-left text-[11px]">
              <thead className="bg-[var(--color-surface-subtle)] text-[10px] font-black text-[var(--color-text-tertiary)]">
                <tr><th className="px-3 py-2">方向</th><th className="px-3 py-2">期間</th><th className="px-3 py-2">標本</th><th className="px-3 py-2">P@20</th><th className="px-3 py-2">勝率</th></tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-soft)]">
                {evaluations.slice(0, 12).map((row) => (
                  <tr key={`${row.modelType}-${row.direction}-${row.horizonDays}`}>
                    <td className="px-3 py-2 font-bold">{row.direction}</td>
                    <td className="px-3 py-2">{row.horizonDays}日</td>
                    <td className="px-3 py-2 tabular-nums">{row.sampleCount.toLocaleString()}</td>
                    <td className="px-3 py-2 tabular-nums">{pct(row.precisionAt20)}</td>
                    <td className="px-3 py-2 tabular-nums">{pct(row.hitRate)}</td>
                  </tr>
                ))}
                {evaluations.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-5 text-center font-semibold text-[var(--color-text-secondary)]">
                      価格基準日以前のUSモデル評価を生成中です。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className="sb-hd">
            <h2>現在の類似銘柄ペア</h2>
            <Network size={15} />
          </div>
          <div className="divide-y divide-[var(--color-border-soft)] border border-[var(--color-border-default)] bg-white">
            {similars.slice(0, 12).map((row) => (
              <div key={`${row.baseTicker}-${row.similarTicker}`} className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-2 px-3 py-2 text-[12px]">
                <Link href={`/us/stock/${encodeURIComponent(row.baseTicker)}#ml`} className="font-black text-[var(--color-brand-800)]">{row.baseTicker}</Link>
                <span className="text-[var(--color-text-tertiary)]">→</span>
                <Link href={`/us/stock/${encodeURIComponent(row.similarTicker)}#ml`} className="font-black text-[var(--color-brand-800)]">{row.similarTicker}</Link>
                <span className="font-mono font-black tabular-nums">{row.similarityScore.toFixed(3)}</span>
              </div>
            ))}
            {similars.length === 0 && <div className="p-5 text-[12px] font-semibold text-[var(--color-text-secondary)]">US類似局面インデックスを生成中です。</div>}
          </div>
        </div>
      </section>
    </div>
  )
}
