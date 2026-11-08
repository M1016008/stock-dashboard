'use client'

import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { CandlestickChart } from '@/components/charts/CandlestickChart'
import { StageTimeline, type StageTimelineSnapshot } from '@/components/stock/StageTimeline'
import { SmaDynamicsSection } from '@/components/stock/sma-dynamics/SmaDynamicsSection'
import { useSmaLinkIntent } from '@/components/stock/sma-dynamics/useSmaLinkIntent'
import { TechnicalChartSnapshot, useChartHeight } from '@/components/stock/TechnicalChartSnapshot'
import {
  MA_FIELD_THRESHOLD_DEG,
  maFieldChangeConditions,
  maFieldInputs,
  type TechnicalMomentumSnapshot,
} from '@/components/stock/technical-view'
import { UsPhysicalMomentumSection } from './UsPhysicalMomentumSection'
import { technicalMomentumSnapshot } from './us-technical-view'
import type { UsPhysicalMomentumState } from './useUsPhysicalMomentum'

const LOADING_STAGE: StageTimelineSnapshot = { status: 'loading', date: null, stages: null, message: null }

export function UsChartWorkspace({
  ticker,
  companyName = null,
  analysisDate,
  showActual,
  momentum,
}: {
  ticker: string
  companyName?: string | null
  analysisDate: string | null
  showActual: boolean
  momentum: UsPhysicalMomentumState
}) {
  const [stageSnapshot, setStageSnapshot] = useState<StageTimelineSnapshot>(LOADING_STAGE)
  // StageTimeline は取得のたびに loading → available/missing/error を通知するので、日付・銘柄の切替時もここで追従する
  const handleStageSnapshot = useCallback((snapshot: StageTimelineSnapshot) => {
    setStageSnapshot(snapshot)
  }, [])
  const momentumSnapshot = useMemo(
    () => technicalMomentumSnapshot(momentum.status, momentum.data, momentum.error),
    [momentum.data, momentum.error, momentum.status],
  )
  const chartHeight = useChartHeight()
  const smaLinkIntent = useSmaLinkIntent(`US:${ticker}`)

  // 読み順: 現在の状態(結論) → チャート → 根拠(MA・3スコア・6ステージ) → SMAダイナミクス → ステージ変遷 → Physical Momentum・観察プラン → 指標の見方
  return (
    <div className="space-y-3 pb-6 sm:space-y-4" aria-label="チャート・6ステージ分析">
      <section className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white" aria-labelledby="us-main-chart-title">
        <TechnicalChartSnapshot
          market="US"
          stage={stageSnapshot}
          momentum={momentumSnapshot}
          analysisDate={analysisDate}
          chart={(
            <>
              <h2 id="us-main-chart-title" className="m-0 mb-2 text-[14px] font-bold text-[var(--color-text-primary)]">価格と移動平均</h2>
              <CandlestickChart
                ticker={ticker}
                market="US"
                interval="D"
                height={chartHeight}
                historyPeriod="all"
                showTwoYearLines
                showTimeframeSelector
                toolbarVariant="segmented"
                summaryVariant="strip"
                analysisDate={analysisDate}
                revealAfterAnalysis={showActual}
              />
            </>
          )}
        />
      </section>

      <SmaDynamicsSection market="US" ticker={ticker} name={companyName} analysisDate={analysisDate} linkIntent={smaLinkIntent} />

      <StageTimeline
        ticker={ticker}
        market="US"
        analysisDate={analysisDate}
        onSnapshotChange={handleStageSnapshot}
      />

      <UsPhysicalMomentumSection ticker={ticker} analysisDate={analysisDate} momentum={momentum} />

      <TechnicalSnapshotGuide momentum={momentumSnapshot} />
    </div>
  )
}

function TechnicalSnapshotGuide({ momentum }: { momentum: TechnicalMomentumSnapshot }) {
  const [open, setOpen] = useState(false)
  const inputs = momentum.maAngles ? maFieldInputs(momentum.maAngles) : null
  const conditions = momentum.status === 'available' && momentum.maStructure && inputs
    ? maFieldChangeConditions(momentum.maStructure, inputs)
    : []
  const t = MA_FIELD_THRESHOLD_DEG
  const items: Array<{ term: string; body: ReactNode }> = [
    {
      term: 'MA力場(現在の状態)',
      body: (
        <>
          4本のMA(5・25・75・200)の角度だけで決まります。短期平均(5・25MA)と長期平均(75・200MA)が±{t}°を超えて同じ向きにそろい、同じ向きが3本以上で「上/下方向へ力が拡散」です。
          {conditions.length > 0 && (
            <ul className="m-0 mt-1 list-disc pl-4">
              {conditions.map((condition) => <li key={condition}>{condition}</li>)}
            </ul>
          )}
        </>
      ),
    },
    {
      term: '逆向きと矢印',
      body: `逆向きは、上向き・下向きの本数が多い側と反対に±${t}°を超えて傾くMAです(同数なら付けません)。セルの語(上向き・横ばいなど)は表示用の別基準(±1.2°で横ばい、±3°で強)なので、本数と一致しない場合があります。矢印は角度どおりの傾きで、チャート上の見た目の傾きとは異なります。`,
    },
    {
      term: '6ステージ',
      body: 'S1=短>中>長(安定上昇期)、S2=中>短>長、S3=中>長>短、S4=長>中>短(安定下降期)、S5=長>短>中、S6=短>長>中。使うMAは 日A 5/25/75、日B 75/150/300、週A 5/13/25、週B 25/50/100、月A 3/5/10、月B 10/20/25。',
    },
    {
      term: '3スコア',
      body: '日足のPMS(総合の強さ)・PFS(足元の力の向き)・PES(値動きの熱量)はUS市場横断の標準化(Z)、2日足・週足・月足は銘柄内の時間軸Zです。いずれも分布の裾1%を抑えた標準化で、時間軸が違う数値同士は直接比較しません。バーは±2.5で頭打ちになります。',
    },
    {
      term: 'US版の補正',
      body: '株式分割・併合を補正し、相対出来高と価格水準に依存しないMA傾斜で比較します。',
    },
    {
      term: 'Stageの色と遷移',
      body: 'Stageの色は種別を区別する色で、上昇・下落の赤・青とは別です。Stageが切り替わっても良し悪しは示しません。',
    },
  ]
  return (
    <section className="rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white">
      <button
        type="button"
        className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-[12px] font-bold text-[var(--color-text-secondary)] sm:min-h-9"
        aria-expanded={open}
        aria-controls="us-technical-guide"
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronRight size={13} className={`shrink-0 text-[var(--color-text-tertiary)] transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
        指標の見方
        <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">MA力場・ステージ・3スコア</span>
      </button>
      <dl id="us-technical-guide" hidden={!open} className="m-0 grid gap-x-6 gap-y-3 border-t border-[var(--color-border-soft)] px-3 py-3 md:grid-cols-2">
        {items.map(({ term, body }) => (
          <div key={term} className="min-w-0">
            <dt className="text-[12px] font-bold text-[var(--color-text-primary)]">{term}</dt>
            <dd className="m-0 mt-0.5 text-[11px] font-medium leading-5 text-[var(--color-text-secondary)]">{body}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
