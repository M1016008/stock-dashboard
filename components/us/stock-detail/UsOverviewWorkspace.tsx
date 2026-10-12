'use client'

import { useEffect, useState } from 'react'
import { ChevronRight, LayoutDashboard } from 'lucide-react'
import { PerformanceCard } from '@/components/stock/PerformanceCard'
import type { NextUsEarnings } from '@/lib/queries/us-earnings'
import { buildShortTermCheck, formatShortTermStrength } from '@/lib/short-term-check'
import type { StockQuote } from '@/types/stock'
import {
  ConditionList,
  CurrentOnlyDataNotice,
  LedgerItem,
  SheetRow,
  StageRibbon,
} from './SummarySheet'
import {
  angleDirectionArrow,
  angleDirectionColor,
  angleDirectionLabel,
  buildMaFieldInsight,
  buildUsShortTermEvidence,
  directionColor,
  directionGlyph,
  directionWord,
  fmtCount,
  fmtDeg,
  fmtMoney,
  fmtPct,
  fmtUsd,
  MA_FIELD_THRESHOLD_DEG,
  maAngleSet,
  maFieldChangeConditions,
  maFieldInputs,
  previousMomentumRow,
  shortTermToneColor,
  type MaAngleSet,
  type UsStageEntry,
} from './technical-view'
import type { UsPhysicalMomentumState } from './useUsPhysicalMomentum'

/** 傾き(physical のMA角度)と終値の位置(stage-history のMA値)を同じ列で読む列定義。長期列だけ両者の期間が異なる */
const MA_SHEET_COLUMNS: Array<{ heading: string; angleKey: keyof MaAngleSet; angleLabel: string }> = [
  { heading: '5日', angleKey: 'ma5', angleLabel: '5MA' },
  { heading: '25日', angleKey: 'ma25', angleLabel: '25MA' },
  { heading: '75日', angleKey: 'ma75', angleLabel: '75MA' },
  { heading: '長期', angleKey: 'ma200', angleLabel: '200MA' },
]

const HISTORICAL_PRICE_PENDING = 'この日の過去終値を確認中、または該当データがありません。'

export function UsOverviewWorkspace({
  ticker,
  quote,
  displayedQuote,
  analysisDate,
  shortTermChangePercent,
  nextEarnings,
  momentum,
}: {
  ticker: string
  /** 最新の quote(現在情報: 時価総額・平均出来高・MACD に使う) */
  quote: StockQuote
  /** 表示中の価格。過去分析モードでは指定日の終値、確認中・該当なしは null */
  displayedQuote: StockQuote | null
  analysisDate: string | null
  /** 短期チェックに渡す日次騰落率。過去分析モードでは指定日の値、未確認なら null */
  shortTermChangePercent: number | null
  nextEarnings: NextUsEarnings | null
  momentum: UsPhysicalMomentumState
}) {
  const [latestStage, setLatestStage] = useState<UsStageEntry | null>(null)
  const [stageLoading, setStageLoading] = useState(true)
  const [showSignalDetails, setShowSignalDetails] = useState(false)

  useEffect(() => {
    let cancelled = false
    setStageLoading(true)
    setLatestStage(null)
    const stageParams = new URLSearchParams({ market: 'US', granularity: 'daily', count: '1' })
    if (analysisDate) {
      stageParams.set('startDate', '1900-01-01')
      stageParams.set('endDate', analysisDate)
    }
    fetch(`/api/stage-history/${encodeURIComponent(ticker)}?${stageParams.toString()}`, { cache: 'no-store' })
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
      .then((payload) => {
        if (cancelled) return
        const history = Array.isArray(payload?.history) ? payload.history as UsStageEntry[] : []
        setLatestStage(history[history.length - 1] ?? null)
      })
      .catch(() => {
        if (!cancelled) setLatestStage(null)
      })
      .finally(() => {
        if (!cancelled) setStageLoading(false)
      })
    return () => { cancelled = true }
  }, [analysisDate, ticker])

  const momentumLoading = momentum.status === 'idle' || momentum.status === 'loading'
  const latestPhysical = momentum.data?.latest ?? null
  const momentumHistoryCount = momentum.data?.history?.length ?? 0
  const isMomentumCoverageSparse = momentumHistoryCount < 20
  const field = latestPhysical ? buildMaFieldInsight(latestPhysical, previousMomentumRow(momentum.data)) : null
  const angles = latestPhysical ? maAngleSet(latestPhysical) : null
  const fieldInputs = angles ? maFieldInputs(angles) : null
  const changeConditions = field && fieldInputs ? maFieldChangeConditions(field.label, fieldInputs) : []

  const stageClose = latestStage?.close ?? null
  const priceVsMa = latestStage && stageClose != null && Number.isFinite(stageClose)
    ? ([
      ['5日', latestStage.ma_5],
      ['25日', latestStage.ma_25],
      ['75日', latestStage.ma_75],
      ['300日', latestStage.ma_300],
    ] as const).map(([label, ma]) => ({
      label,
      position: ma == null || !Number.isFinite(ma)
        ? null
        : stageClose > ma ? 'above' as const : stageClose < ma ? 'below' as const : 'equal' as const,
    }))
    : []

  // 入力は従来どおり Stage・PMS・PFS・日次騰落のみ(US版は類似銘柄・物理分類を含めない)
  const shortTermCheck = latestPhysical ? buildShortTermCheck({
    stages: latestStage ? {
      dailyA: latestStage.daily_a_stage,
      dailyB: latestStage.daily_b_stage,
      weeklyA: latestStage.weekly_a_stage,
      weeklyB: latestStage.weekly_b_stage,
      monthlyA: latestStage.monthly_a_stage,
      monthlyB: latestStage.monthly_b_stage,
    } : null,
    physicalMomentumScore: latestPhysical.physicalMomentumScore,
    physicalForceScore: latestPhysical.physicalForceScore,
    changePercent: shortTermChangePercent,
  }) : null
  const shortTermReady = shortTermCheck != null && !isMomentumCoverageSparse
  const shortTerm = buildUsShortTermEvidence(latestStage, latestPhysical, shortTermChangePercent, shortTermReady ? shortTermCheck : null)
  const combinedLoading = momentumLoading || stageLoading

  const stateTitle = field?.label
    ?? (momentumLoading
      ? '読み込み中'
      : momentum.status === 'error'
        ? 'MA力場を取得できませんでした'
        : 'MA力場は未算出')

  const rowId = ticker.replace(/[^a-zA-Z0-9_-]/g, '-')
  const signalDetailsId = `us-overview-signal-details-${rowId}`
  const conditionCount = changeConditions.length + shortTerm.conditions.length
  const evidenceSummary = shortTerm.sides
    .map((side) => `${side.key === 'short' ? '短期' : '中期'} ${directionWord(side.direction)}(▲${side.up} ▼${side.down})`)
    .join(' ・ ')

  return (
    <section className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white" aria-labelledby="us-summary-title">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border-soft)] px-3 py-3 sm:gap-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <LayoutDashboard size={16} className="shrink-0 text-[var(--color-brand-700)]" aria-hidden="true" />
          <div className="min-w-0">
            <h2 id="us-summary-title" className="m-0 text-[14px] font-bold text-[var(--color-text-primary)]">サマリー</h2>
            <div className="mt-0.5 text-[11px] font-medium text-[var(--color-text-tertiary)]">市場データ US EOD</div>
          </div>
        </div>
        <div className="font-mono text-[11px] font-medium tabular-nums text-[var(--color-text-tertiary)]">
          基準日 {displayedQuote?.priceDate ?? analysisDate ?? '---'}
        </div>
      </header>

      <div className="grid items-start gap-x-6 px-3 py-1 sm:px-4 xl:grid-cols-[minmax(0,1.08fr)_minmax(0,.92fr)]" data-overview-basic-grid>
        {/* 左列: 結論(MA力場) → 根拠(MA・6ステージ・短期チェック) → 見方が変わる条件 */}
        <div className="@container min-w-0" data-overview-current-state>
          <SheetRow label="現在の状態" note={latestPhysical?.date ? `MA力場 ${latestPhysical.date}` : 'MA力場'}>
            <div className="grid gap-x-6 gap-y-1 xl:@[42rem]:grid-cols-[minmax(13rem,auto)_minmax(0,1fr)] xl:@[42rem]:items-baseline">
              <p className="m-0 text-[22px] font-black leading-tight [text-wrap:pretty]" style={{ color: field?.color ?? 'var(--color-text-tertiary)' }}>
                {stateTitle}
              </p>
              {fieldInputs ? (
                <p className="m-0 text-[12px] font-medium leading-5 text-[var(--color-text-secondary)]">
                  4本のMAのうち±{MA_FIELD_THRESHOLD_DEG}°超で上向き<b className="font-mono tabular-nums">{fieldInputs.up}</b>本・下向き<b className="font-mono tabular-nums">{fieldInputs.down}</b>本。
                  短期平均<b className="font-mono tabular-nums" style={{ color: angleDirectionColor(fieldInputs.shortAvg) }}>{fmtDeg(fieldInputs.shortAvg)}</b>、
                  長期平均<b className="font-mono tabular-nums" style={{ color: angleDirectionColor(fieldInputs.longAvg) }}>{fmtDeg(fieldInputs.longAvg)}</b>
                  {field?.spreadChangeDeg != null && (
                    <>。角度幅は前回比<b className="font-mono tabular-nums">{fmtDeg(field.spreadChangeDeg)}</b>({field.spreadChangeDeg > 0 ? '広がる' : field.spreadChangeDeg < 0 ? '狭まる' : '変わらず'})</>
                  )}
                </p>
              ) : momentum.status === 'error' ? (
                <p className="m-0 text-[12px] font-medium leading-5 text-[var(--color-text-tertiary)]">MAの角度を取得できませんでした({momentum.error})。</p>
              ) : !momentumLoading ? (
                <p className="m-0 text-[12px] font-medium leading-5 text-[var(--color-text-tertiary)]">このUS銘柄のMA角度はまだ算出されていません。</p>
              ) : null}
            </div>
          </SheetRow>

          <SheetRow label="MA" note="短期 → 長期">
            <table className="w-full max-w-[720px] table-fixed border-collapse text-left" aria-label="移動平均線の傾きと終値の位置(短期→長期)">
              <thead>
                <tr className="border-b border-[var(--color-border-soft)]">
                  <th scope="col" className="w-10 pb-1 sm:w-14"><span className="sr-only">項目</span></th>
                  {MA_SHEET_COLUMNS.map(({ heading }) => (
                    <th key={heading} scope="col" className="pb-1 pr-2 text-[11px] font-bold text-[var(--color-text-tertiary)]">{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row" className="py-1.5 text-[11px] font-bold text-[var(--color-text-tertiary)]">傾き</th>
                  {angles ? MA_SHEET_COLUMNS.map(({ angleKey, angleLabel }) => {
                    const deg = angles[angleKey]
                    const color = angleDirectionColor(deg)
                    return (
                      <td key={angleKey} className="py-1.5 pr-2" title={`${angleLabel} ${angleDirectionLabel(deg)}${deg == null ? '' : ` ${deg.toFixed(1)}°`}`}>
                        <span className="inline-flex items-baseline gap-0.5 whitespace-nowrap font-mono text-[12px] font-bold tabular-nums xl:text-[13px]" style={{ color }}>
                          <span aria-hidden="true" className="text-[11px]">{angleDirectionArrow(deg)}</span>
                          <span className="sr-only">{angleLabel} {angleDirectionLabel(deg)} </span>
                          {deg == null ? '—' : fmtDeg(deg)}
                        </span>
                      </td>
                    )
                  }) : (
                    <td colSpan={4} className="py-1.5 text-[11px] font-semibold text-[var(--color-text-tertiary)]">{momentumLoading ? '読み込み中' : '未取得'}</td>
                  )}
                </tr>
                <tr className="border-t border-[var(--color-border-soft)]">
                  <th scope="row" className="py-1.5 text-[11px] font-bold text-[var(--color-text-tertiary)]">終値</th>
                  {priceVsMa.length === 0 ? (
                    <td colSpan={4} className="py-1.5 text-[11px] font-semibold text-[var(--color-text-tertiary)]">{stageLoading ? '読み込み中' : '未取得'}</td>
                  ) : priceVsMa.map(({ label, position }) => (
                    <td
                      key={label}
                      className="py-1.5 pr-2"
                      title={`終値は${label}MAの${position === 'above' ? '上' : position === 'below' ? '下' : position === 'equal' ? '同値' : '—'}`}
                    >
                      <b
                        className="text-[13px] font-bold"
                        style={{ color: position === 'above' ? 'var(--price-up)' : position === 'below' ? 'var(--price-down)' : 'var(--color-text-tertiary)' }}
                      >
                        <span className="sr-only">{label}MAの</span>
                        {position === 'above' ? '上' : position === 'below' ? '下' : position === 'equal' ? '同値' : '—'}
                      </b>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
            <p className="m-0 mt-1 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">
              傾きは5・25・75・200MA、終値の位置は5・25・75・300日MA(長期列のみ期間が異なる)
            </p>
          </SheetRow>

          <SheetRow label="6ステージ" note={latestStage?.date ?? undefined}>
            {latestStage ? (
              <StageRibbon stage={latestStage} />
            ) : (
              <p className="m-0 text-[12px] font-medium text-[var(--color-text-tertiary)]">{stageLoading ? '6ステージを読み込み中' : 'この日付までの6ステージデータがありません。'}</p>
            )}
          </SheetRow>

          <SheetRow label="短期チェック" note={analysisDate ? `${displayedQuote?.priceDate ?? analysisDate}時点` : '最新'}>
            <div data-overview-signal-row>
              {combinedLoading ? (
                <p className="m-0 text-[12px] font-medium text-[var(--color-text-tertiary)]" role="status">読み込み中</p>
              ) : !shortTermCheck ? (
                <p className="m-0 text-[12px] font-medium text-[var(--color-text-tertiary)]">PMSが未算出のため判定していません。</p>
              ) : isMomentumCoverageSparse ? (
                <p className="m-0 text-[12px] font-medium text-amber-800">PMS履歴が{momentumHistoryCount}営業日分のため、判定は保留中です。</p>
              ) : (
                <>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <strong className="text-[15px] font-black leading-tight" style={{ color: shortTermToneColor(shortTermCheck.tone) }}>
                      {shortTermCheck.label}
                    </strong>
                    <span className="font-mono text-[11px] font-bold tabular-nums" style={{ color: shortTermToneColor(shortTermCheck.tone) }}>
                      {formatShortTermStrength(shortTermCheck.label, shortTermCheck.score)}
                    </span>
                    <span className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
                      短期と中期 <b style={{ color: shortTerm.agreement.color }}>{shortTerm.agreement.label}</b>
                    </span>
                  </div>
                  {shortTerm.reading && (
                    <p className="m-0 mt-1 text-[12px] font-medium leading-5 text-[var(--color-text-secondary)]">{shortTerm.reading}</p>
                  )}
                </>
              )}
              <p className="m-0 mt-1 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">
                US版は類似銘柄・物理分類を判定に含みません。
                {analysisDate && shortTermChangePercent == null && ' 指定日の日次騰落は未確認のため含めていません。'}
              </p>
            </div>
          </SheetRow>

          <SheetRow label="根拠と条件" note="短期・中期・変わる条件">
            <button
              type="button"
              className="flex min-h-11 w-full flex-wrap items-center gap-x-3 gap-y-0.5 py-1 text-left hover:bg-[var(--color-surface-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand-700)] sm:min-h-9"
              aria-expanded={showSignalDetails}
              aria-controls={signalDetailsId}
              onClick={() => setShowSignalDetails((current) => !current)}
            >
              <span className="min-w-0 text-[11px] font-semibold text-[var(--color-text-secondary)]">
                {combinedLoading ? '読み込み中' : <>{evidenceSummary} ・ 変わる条件 <b className="font-mono tabular-nums">{conditionCount}</b>件</>}
              </span>
              <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] font-bold text-[var(--color-brand-700)]">
                {showSignalDetails ? '閉じる' : '根拠と条件を見る'}
                <ChevronRight size={13} className={`transition-transform ${showSignalDetails ? 'rotate-90' : ''}`} aria-hidden="true" />
              </span>
            </button>
            <div id={signalDetailsId} hidden={!showSignalDetails} className="mt-2 grid gap-x-8 gap-y-4 md:grid-cols-2">
              {shortTerm.sides.map((side) => (
                <section key={side.key} className="min-w-0" aria-label={side.label}>
                  <div className="flex items-baseline justify-between gap-2 border-b border-[var(--color-border-soft)] pb-1">
                    <h4 className="m-0 text-[11px] font-bold text-[var(--color-text-primary)]">{side.label}</h4>
                    <span className="shrink-0 font-mono text-[11px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">▲{side.up} ▼{side.down}</span>
                  </div>
                  <ul className="m-0 mt-1 grid gap-0.5 p-0">
                    {side.items.map((item) => (
                      <li key={item.label} className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-baseline gap-1.5 text-[11px] leading-5">
                        <span aria-hidden="true" className="font-mono text-[11px] font-black" style={{ color: directionColor(item.direction) }}>{directionGlyph(item.direction)}</span>
                        <span className="font-medium text-[var(--color-text-tertiary)]">{item.label}</span>
                        <b className="text-right font-mono text-[11px] font-semibold tabular-nums text-[var(--color-text-primary)]">
                          <span className="sr-only">{directionWord(item.direction)} </span>{item.value}
                        </b>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              <section className="min-w-0 md:col-span-2" aria-label="見方が変わる条件">
                <h4 className="m-0 border-b border-[var(--color-border-soft)] pb-1 text-[11px] font-bold text-[var(--color-text-primary)]">見方が変わる条件</h4>
                {changeConditions.length > 0 && (
                  <>
                    <div className="mt-1.5 text-[11px] font-semibold text-[var(--color-text-tertiary)]">MA力場「{field?.label}」</div>
                    <ConditionList conditions={changeConditions} />
                  </>
                )}
                {shortTermReady && shortTermCheck && (
                  <>
                    <div className="mt-1.5 text-[11px] font-semibold text-[var(--color-text-tertiary)]">短期チェック「{shortTermCheck.label}」</div>
                    {shortTerm.conditions.length > 0
                      ? <ConditionList conditions={shortTerm.conditions} />
                      : <p className="m-0 mt-0.5 text-[11px] font-medium text-[var(--color-text-tertiary)]">—</p>}
                  </>
                )}
                {changeConditions.length === 0 && !shortTermReady && (
                  <p className="m-0 mt-1 text-[11px] font-medium text-[var(--color-text-tertiary)]">判定材料がそろうと表示します。</p>
                )}
              </section>
            </div>
          </SheetRow>
        </div>

        {/* 右列(xl)/下段: 価格の位置・予定・市場データ。判断の結論ではなく文脈として読む */}
        <div
          className="@container min-w-0 border-t border-[var(--color-border-default)] xl:border-l xl:border-t-0 xl:border-[var(--color-border-soft)] xl:pl-6"
          data-overview-market-column
        >
          <SheetRow label="52週の位置" note={analysisDate ? `${displayedQuote?.priceDate ?? analysisDate}時点` : '高値・安値レンジ'}>
            {analysisDate && !displayedQuote ? (
              <p className="m-0 text-[12px] font-medium text-[var(--color-text-tertiary)]">{HISTORICAL_PRICE_PENDING}</p>
            ) : (
              <FiftyTwoWeekPosition quote={displayedQuote} />
            )}
          </SheetRow>

          <SheetRow label="次回決算" note={analysisDate ? '現在情報' : 'Finnhub'}>
            {analysisDate ? (
              <CurrentOnlyDataNotice label="決算予定は現在情報のため、過去分析モードでは表示していません。" />
            ) : nextEarnings?.reportDate ? (
              <div>
                <b className="font-mono text-[13px] font-semibold tabular-nums text-[var(--color-text-primary)]">{nextEarnings.reportDate}</b>
                <span className="ml-2 text-[11px] font-medium text-[var(--color-text-secondary)]">
                  {nextEarnings.hour === 'bmo' ? '寄付前'
                    : nextEarnings.hour === 'dmh' ? '取引時間中'
                      : nextEarnings.hour === 'amc' ? '引け後'
                        : '時刻未定'}
                  {nextEarnings.fiscalYear && nextEarnings.fiscalQuarter ? (
                    <span className="font-mono tabular-nums"> ・ {nextEarnings.fiscalYear} Q{nextEarnings.fiscalQuarter}</span>
                  ) : null}
                </span>
              </div>
            ) : (
              <p className="m-0 text-[12px] font-medium text-[var(--color-text-tertiary)]">予定未取得</p>
            )}
          </SheetRow>

          <SheetRow label="市場データ" note={analysisDate ? undefined : quote.technicals?.asOfDate ? `指標 ${quote.technicals.asOfDate}` : undefined}>
            <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-2.5">
              <LedgerItem
                label="出来高"
                value={analysisDate && !displayedQuote ? '—' : fmtCount(displayedQuote?.volume) ?? '未取得'}
                detail={analysisDate && !displayedQuote ? '過去終値の確認後に表示' : analysisDate ? `${displayedQuote?.priceDate ?? analysisDate}` : undefined}
              />
              {!analysisDate && <CurrentMarketLedger quote={quote} />}
            </dl>
            {analysisDate && (
              <div className="mt-2">
                <CurrentOnlyDataNotice label="時価総額・平均出来高・MACDは現在情報のため、過去分析モードでは表示していません。" />
              </div>
            )}
          </SheetRow>

          <div className="border-t border-[var(--color-border-soft)] py-3">
            <PerformanceCard ticker={ticker} market="US" embedded analysisDate={analysisDate} />
          </div>
        </div>
      </div>
    </section>
  )
}

function CurrentMarketLedger({ quote }: { quote: StockQuote }) {
  const technicals = quote.technicals
  const macd = technicals?.macd
  const averageVolumeLabel = technicals?.averageVolumeObservationCount && technicals.averageVolumeObservationCount < 30
    ? `${technicals.averageVolumeObservationCount}日平均出来高`
    : '30日平均出来高'
  const macdValue = macd?.relation === 'golden'
    ? 'ゴールデンクロス側'
    : macd?.relation === 'dead'
      ? 'デッドクロス側'
      : macd?.relation === 'neutral'
        ? '中立'
        : '未取得'
  const macdDetail = macd?.lastCrossDate
    ? `直近${macd.lastCrossType === 'golden' ? 'GC' : 'DC'} ${macd.lastCrossDate}`
    : macd
      ? `MACD ${macd.value.toFixed(2)} / Signal ${macd.signal.toFixed(2)}`
      : undefined
  return (
    <>
      {/* 2列の台帳: 出来高 | 平均出来高、時価総額 | MACD */}
      <LedgerItem
        label={averageVolumeLabel}
        value={fmtCount(technicals?.averageVolume30) ?? '未取得'}
      />
      <LedgerItem label="時価総額" value={fmtMoney(quote.marketCap) ?? '未取得'} />
      <LedgerItem
        label="MACD (12・26・9)"
        value={macdValue}
        detail={macdDetail}
        color={macd?.relation === 'golden'
          ? 'var(--color-market-red)'
          : macd?.relation === 'dead'
            ? 'var(--color-market-blue)'
            : undefined}
      />
    </>
  )
}

function FiftyTwoWeekPosition({ quote }: { quote: StockQuote | null }) {
  const price = quote?.price ?? null
  const high = quote?.fiftyTwoWeekHigh ?? null
  const low = quote?.fiftyTwoWeekLow ?? null
  if (high == null && low == null) {
    return <p className="m-0 text-[12px] font-medium text-[var(--color-text-tertiary)]">52週の高値・安値は未取得です。</p>
  }
  const highDistance = price != null && high != null && high > 0 ? ((price / high) - 1) * 100 : null
  const lowDistance = price != null && low != null && low > 0 ? ((price / low) - 1) * 100 : null
  // 高値=安値のときは位置を定義できないため、バーと%を出さない
  const rangePosition = price != null && high != null && low != null && high > low
    ? Math.min(100, Math.max(0, ((price - low) / (high - low)) * 100))
    : null
  return (
    <div className="max-w-[720px]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[11px] font-medium text-[var(--color-text-tertiary)]">
        <span>安値 <b className="whitespace-nowrap font-mono text-[13px] font-semibold tabular-nums text-[var(--color-text-primary)]">{low == null ? '未取得' : fmtUsd(low)}</b></span>
        {rangePosition != null && (
          <span>レンジ内の位置 <b className="font-mono text-[15px] font-black tabular-nums text-[var(--color-text-primary)]">{rangePosition.toFixed(0)}%</b></span>
        )}
        <span>高値 <b className="whitespace-nowrap font-mono text-[13px] font-semibold tabular-nums text-[var(--color-text-primary)]">{high == null ? '未取得' : fmtUsd(high)}</b></span>
      </div>
      {rangePosition != null && low != null && high != null && (
        <span
          className="relative mt-1.5 block h-3"
          role="img"
          aria-label={`52週安値${fmtUsd(low)}から高値${fmtUsd(high)}の間での価格の位置 ${rangePosition.toFixed(0)}%`}
        >
          <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 bg-[var(--color-surface-subtle)] ring-1 ring-[var(--color-border-soft)]" />
          <span className="absolute top-0 h-3 w-[3px] -translate-x-1/2 bg-[var(--color-brand-900)]" style={{ left: `${rangePosition}%` }} />
        </span>
      )}
      <div className="mt-1 flex flex-wrap justify-between gap-x-4 font-mono text-[11px] font-medium tabular-nums text-[var(--color-text-tertiary)]">
        <span>安値比 {lowDistance == null ? '---' : fmtPct(lowDistance)}</span>
        <span>高値比 {highDistance == null ? '---' : fmtPct(highDistance)}</span>
      </div>
    </div>
  )
}
