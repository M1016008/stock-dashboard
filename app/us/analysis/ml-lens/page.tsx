import type { Metadata } from 'next'
import Link from 'next/link'
import { Database, Network } from 'lucide-react'
import { PhysicsMlCandidatesPanel } from '@/components/ml/PhysicsMlCandidatesPanel'
import { UsAnalysisNav } from '@/components/us/UsAnalysisNav'
import { PageTitle } from '@/components/layout/PageTitle'
import { StatStrip } from '@/components/ui/StatStrip'
import { Notice } from '@/components/ui/EmptyState'
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
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageTitle
        eyebrow="米国株"
        title="US AI Lens"
        subtitle="US分析DBのMA構造・物理特徴量・ML候補・類似局面だけを横断表示します。JPの統計は混在させません。"
        badge={generationReady ? undefined : '世代移行中'}
        badgeTone="warning"
      >
        <UsAnalysisNav current="/us/analysis/ml-lens" />
      </PageTitle>

      {/* 各レイヤーの基準日。日付がずれているレイヤーは結果の読み方に注意する */}
      <StatStrip
        label="データ基準日"
        items={[
          ['US価格', status.priceDate],
          ['物理特徴量', status.featureDate],
          ['物理ML候補', status.candidateDate],
          ['検証区間終端', status.evaluationDate],
          ['類似局面', status.analogDate],
        ].map(([label, value]) => ({
          label,
          value: <span className="font-mono text-[17px]">{value ?? '未生成'}</span>,
          tone: value ? undefined : 'muted' as const,
        }))}
      />

      {!generationReady && (
        <Notice tone="warning" title="調整後価格・派生特徴量・類似局面インデックスの世代移行中です">
          完了済みのUS結果は閲覧できますが、新世代の確定公開は品質検証後に行います。
        </Notice>
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

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <section className="panel" aria-labelledby="us-model-eval-title">
          <div className="panel-head">
            <div className="flex min-w-0 items-center gap-2">
              <Database size={15} aria-hidden className="text-[var(--color-text-tertiary)]" />
              <div className="min-w-0">
                <h2 id="us-model-eval-title">モデル評価</h2>
                <p>年次ウォークフォワード検証 / 終端 {status.evaluationDate ?? '未生成'}</p>
              </div>
            </div>
          </div>
          <div className="table-scroll">
            <table className="w-full min-w-[480px] text-left text-[12px]">
              <thead className="text-[11px] text-[var(--color-text-tertiary)]">
                <tr className="border-b border-[var(--color-border-default)]">
                  <th className="px-4 py-2 font-semibold">方向</th>
                  <th className="px-3 py-2 font-semibold">期間</th>
                  <th className="px-3 py-2 text-right font-semibold">標本</th>
                  <th className="px-3 py-2 text-right font-semibold">P@20</th>
                  <th className="px-4 py-2 text-right font-semibold">勝率</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-soft)]">
                {evaluations.slice(0, 12).map((row) => (
                  <tr key={`${row.modelType}-${row.direction}-${row.horizonDays}`} className="hover:bg-[var(--color-surface-subtle)]">
                    <td className="px-4 py-2 font-semibold">{row.direction}</td>
                    <td className="px-3 py-2 tabular-nums">{row.horizonDays}日</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{row.sampleCount.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{pct(row.precisionAt20)}</td>
                    <td className="px-4 py-2 text-right font-mono font-semibold tabular-nums">{pct(row.hitRate)}</td>
                  </tr>
                ))}
                {evaluations.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-[var(--color-text-secondary)]">
                      価格基準日以前のUSモデル評価を生成中です。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel" aria-labelledby="us-similar-pairs-title">
          <div className="panel-head">
            <div className="flex min-w-0 items-center gap-2">
              <Network size={15} aria-hidden className="text-[var(--color-text-tertiary)]" />
              <div className="min-w-0">
                <h2 id="us-similar-pairs-title">現在の類似銘柄ペア</h2>
                <p>類似度の高い順 / 上位12組</p>
              </div>
            </div>
          </div>
          {similars.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-[var(--color-text-secondary)]">US類似局面インデックスを生成中です。</p>
          ) : (
            <ol className="divide-y divide-[var(--color-border-soft)]">
              {similars.slice(0, 12).map((row) => (
                <li key={`${row.baseTicker}-${row.similarTicker}`} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2 text-[13px] hover:bg-[var(--color-surface-subtle)]">
                  <Link href={`/us/stock/${encodeURIComponent(row.baseTicker)}#ml`} prefetch={false} className="truncate font-mono font-bold text-[var(--color-brand-800)] hover:underline">{row.baseTicker}</Link>
                  <span className="text-[var(--color-text-tertiary)]" aria-label="に類似">→</span>
                  <Link href={`/us/stock/${encodeURIComponent(row.similarTicker)}#ml`} prefetch={false} className="truncate font-mono font-bold text-[var(--color-brand-800)] hover:underline">{row.similarTicker}</Link>
                  <span className="font-mono font-semibold tabular-nums text-[var(--color-text-primary)]">{row.similarityScore.toFixed(3)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  )
}
