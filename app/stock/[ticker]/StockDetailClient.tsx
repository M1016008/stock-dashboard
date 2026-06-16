// app/stock/[ticker]/StockDetailClient.tsx
'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { MarketBadge } from '@/components/ui/MarketBadge'
import { MarginBadges } from '@/components/ui/MarginBadges'
import { PriceDisplay } from '@/components/ui/PriceDisplay'
import { CandlestickChart, type ChartDateRange, type TvInterval } from '@/components/charts/CandlestickChart'
import { PerformanceCard } from '@/components/stock/PerformanceCard'
import { EarningsCard } from '@/components/stock/EarningsCard'
import { WatchlistButton } from '@/components/ui/WatchlistButton'
import { StageTimeline, type StageRangeSelection } from '@/components/stock/StageTimeline'
import { StockMovePeriods } from '@/components/stock/StockMovePeriods'
import { StockMlInsights } from '@/components/stock/StockMlInsights'
import { findTicker } from '@/lib/master/tickers'
import { STAGE_BORDER_COLORS } from '@/lib/hex-stage'
import type { StockQuote } from '@/types/stock'

interface StockDetailClientProps {
  ticker: string
}

interface SectorMasterRow {
  ticker: string
  name?: string | null
  sector_large?: string | null
  sector_small?: string | null
  sector33?: string | null
  market_segment?: string | null
  margin_type?: string | null
}

interface StockMarginInfo {
  latest: {
    marginType: string | null
    asOfDate: string | null
    longMargin: number | null
    shortMargin: number | null
    longChange: number | null
    shortChange: number | null
    creditRatio: number | null
    shortRatio: number | null
  } | null
  history: Array<{
    date: string
    longMargin: number | null
    shortMargin: number | null
    longChange: number | null
    shortChange: number | null
  }>
}

interface StockSelectedRange extends ChartDateRange {
  sourceLabel: string
  source: 'chart' | 'stage' | 'calendar'
  sourceInterval?: TvInterval
}

export function StockDetailClient({ ticker }: StockDetailClientProps) {
  const [quote, setQuote] = useState<StockQuote | null>(null)
  const [smaster, setSmaster] = useState<SectorMasterRow | null>(null)
  const [marginInfo, setMarginInfo] = useState<StockMarginInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedRange, setSelectedRange] = useState<StockSelectedRange | null>(null)

  const hardcoded = findTicker(ticker)

  useEffect(() => {
    let cancelled = false
    let pending = 3
    const done = () => {
      pending -= 1
      if (!cancelled && pending <= 0) setLoading(false)
    }
    async function fetchData() {
      setLoading(true)
      fetch(`/api/quote/${encodeURIComponent(ticker)}`, { cache: 'no-store' })
        .then((res) => res.ok ? res.json() : null)
        .then((data) => { if (!cancelled && data) setQuote(data) })
        .catch((error) => console.error('Failed to fetch quote:', error))
        .finally(done)

      fetch(`/api/sector-master/${encodeURIComponent(ticker)}`, { cache: 'no-store' })
        .then((res) => res.ok ? res.json() : null)
        .then((data) => { if (!cancelled) setSmaster(data?.master ?? null) })
        .catch((error) => console.error('Failed to fetch sector master:', error))
        .finally(done)

      fetch(`/api/stock-margin/${encodeURIComponent(ticker)}`, { cache: 'no-store' })
        .then((res) => res.ok ? res.json() : null)
        .then((data) => { if (!cancelled && data) setMarginInfo(data) })
        .catch((error) => console.error('Failed to fetch stock margin:', error))
        .finally(done)
    }
    fetchData()
    return () => { cancelled = true }
  }, [ticker])

  // 表示用にマージ: sector_master(JPX/CSV) → ハードコードマスタ
  const displaySectorLarge   = smaster?.sector_large   ?? hardcoded?.sectorLarge
  const displaySector33      = smaster?.sector33       ?? null
  const displayMarketSegment = smaster?.market_segment ?? hardcoded?.marketSegment
  const displayMarginType    = smaster?.margin_type    ?? hardcoded?.marginType

  const displayCode = ticker.replace('.T', '')
  const name = smaster?.name ?? hardcoded?.name ?? quote?.name ?? '---'

  const updateSelectedRange = useCallback((next: StockSelectedRange) => {
    setSelectedRange((prev) => {
      if (
        prev?.startDate === next.startDate &&
        prev?.endDate === next.endDate &&
        prev?.sourceLabel === next.sourceLabel &&
        prev?.sourceInterval === next.sourceInterval
      ) {
        return prev
      }
      return next
    })
  }, [])

  const handleChartRangeChange = useCallback((range: ChartDateRange, interval: TvInterval, source: 'visible' | 'drag' = 'visible') => {
    updateSelectedRange({
      ...range,
      source: 'chart',
      sourceInterval: interval,
      sourceLabel: source === 'drag' ? `${intervalLabel(interval)}選択範囲` : `${intervalLabel(interval)}表示範囲`,
    })
  }, [updateSelectedRange])

  const handleStageRangeSelect = useCallback((selection: StageRangeSelection) => {
    updateSelectedRange({
      startDate: selection.startDate,
      endDate: selection.endDate,
      source: 'stage',
      sourceLabel: selection.sourceLabel,
    })
  }, [updateSelectedRange])

  const handleCalendarRangeSelect = useCallback((range: ChartDateRange) => {
    updateSelectedRange({
      ...range,
      source: 'calendar',
      sourceLabel: 'カレンダー選択範囲',
    })
  }, [updateSelectedRange])

  const clearSelectedRange = useCallback(() => {
    setSelectedRange(null)
  }, [])

  const shouldSyncChartRange = useCallback((interval: TvInterval) => {
    if (!selectedRange) return false
    return selectedRange.source !== 'chart' || selectedRange.sourceInterval !== interval
  }, [selectedRange])

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

      {/* ヘッダー */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        borderBottom: '1px solid var(--border-subtle)',
        paddingBottom: '12px',
        flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '22px', lineHeight: 1 }}>
            <WatchlistButton ticker={ticker} size="md" />
          </span>
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '22px',
            fontWeight: 700,
            color: 'var(--accent-primary)',
          }}>
            {displayCode}
          </span>
          <MarketBadge />
        </div>

        <span style={{ fontSize: '14px', color: 'var(--text-primary)', fontWeight: 600 }}>
          {name}
        </span>

        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {displayMarginType && <Pill label={displayMarginType} />}
          {displayMarketSegment && <Pill label={`市場: ${displayMarketSegment}`} accent />}
          {displaySectorLarge && <Pill label={`17業種: ${displaySectorLarge}`} />}
          {displaySector33 && <Pill label={`33業種: ${displaySector33}`} />}
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '12px' }}>
          {quote && (
            <PriceDisplay
              value={quote.price}
              change={quote.change}
              changePercent={quote.changePercent}
              currency={quote.currency}
              size="lg"
            />
          )}
          {loading && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>読込中...</span>}
        </div>
      </div>

      {/* 基本情報 + 直近変化率 */}
      <div className="stock-info-grid">
        <BasicInfoCard quote={quote} />
        <PerformanceCard ticker={ticker} />
        <MarginInfoCard info={marginInfo} fallbackType={displayMarginType} />
      </div>

      {/* 決算情報 */}
      <EarningsCard ticker={ticker} />

      <PhysicalMomentumSection ticker={ticker} />

      {/* ステージ変遷 */}
      <div>
        <div className="section-header">ステージ変遷</div>
        <StageTimeline
          ticker={ticker}
          selectedRange={selectedRange}
          onStageRangeSelect={handleStageRangeSelect}
        />
        <CalendarRangeSelector
          selectedRange={selectedRange}
          onRangeSelect={handleCalendarRangeSelect}
          onClear={clearSelectedRange}
        />
        <SelectedRangeSummary ticker={ticker} range={selectedRange} />
      </div>

      {/* TradingView チャート: 日足 / 週足 / 月足 を縦に並べて時間軸比較 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div>
          <div className="section-header">📈 日足チャート（短期トレンド）</div>
          <CandlestickChart
            ticker={ticker}
            interval="D"
            height={420}
            maLines={[5, 25, 75]}
            historyPeriod="all"
            initialVisiblePeriod="1y"
            selectedRange={selectedRange}
            syncSelectedRange={shouldSyncChartRange('D')}
            rangeLabel={selectedRange?.sourceLabel}
            enableRangeDragSelect
            onVisibleRangeChange={handleChartRangeChange}
          />
        </div>
        <div>
          <div className="section-header">📊 週足チャート（中期トレンド）</div>
          <CandlestickChart
            ticker={ticker}
            interval="W"
            height={420}
            maLines={[13, 26, 52]}
            historyPeriod="all"
            initialVisiblePeriod="5y"
            selectedRange={selectedRange}
            syncSelectedRange={shouldSyncChartRange('W')}
            rangeLabel={selectedRange?.sourceLabel}
            enableRangeDragSelect
            onVisibleRangeChange={handleChartRangeChange}
          />
        </div>
        <div>
          <div className="section-header">📉 月足チャート（長期トレンド）</div>
          <CandlestickChart
            ticker={ticker}
            interval="M"
            height={420}
            maLines={[12, 24, 60]}
            historyPeriod="all"
            initialVisiblePeriod="10y"
            selectedRange={selectedRange}
            syncSelectedRange={shouldSyncChartRange('M')}
            rangeLabel={selectedRange?.sourceLabel}
            enableRangeDragSelect
            onVisibleRangeChange={handleChartRangeChange}
          />
        </div>
      </div>

      {/* 過去の大きな値動き */}
      <StockMovePeriods ticker={ticker} />

      {/* 最新ML類似候補 */}
      <StockMlInsights ticker={ticker} />

    </div>
  )
}

interface PhysicalMomentumApiRow {
  date: string
  velocity: number | null
  acceleration: number | null
  momentum: number | null
  force: number | null
  ma5Angle: number | null
  ma25Angle: number | null
  ma75Angle: number | null
  ma200Angle: number | null
  maAngleAvg: number | null
  energy: number | null
  physicalMomentumScore: number | null
  physicalForceScore: number | null
  physicalEnergyScore: number | null
}

interface PhysicalMomentumResponse {
  latest: PhysicalMomentumApiRow | null
  history: PhysicalMomentumApiRow[]
  rank: number | null
  totalRanked: number
  trend: 'rising' | 'falling' | 'flat' | null
}

function PhysicalMomentumSection({ ticker }: { ticker: string }) {
  const [data, setData] = useState<PhysicalMomentumResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    fetch(`/api/physical-momentum/${encodeURIComponent(ticker)}?market=JP&limit=260`, { cache: 'no-store' })
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
      .then((payload) => {
        if (!cancelled) setData(payload)
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [ticker])

  const latest = data?.latest ?? null
  const previous = latest
    ? [...(data?.history ?? [])].reverse().find((row) => row.date < latest.date) ?? null
    : null
  const fieldInsight = latest ? buildMaFieldInsight(latest, previous) : null
  const insight = latest ? buildPhysicalMomentumInsight(latest, data?.rank ?? null, data?.totalRanked ?? 0, data?.trend ?? null, fieldInsight) : null

  return (
    <div className="card" style={physicalCardStyle}>
      <div style={physicalHeaderStyle}>
        <div>
          <div className="section-header" style={{ margin: 0 }}>Physical Momentum</div>
          <div style={physicalSubTextStyle}>
            市場平均との差で、いまの値動きの「力の向き・拡散/収縮・運動エネルギー」を読む共通スコアです。
          </div>
        </div>
        {latest && (
          <span style={physicalDateBadgeStyle}>
            {latest.date}
          </span>
        )}
      </div>

      {loading ? (
        <p style={summaryEmptyStyle}>PMSを読込中...</p>
      ) : error ? (
        <p style={{ ...summaryEmptyStyle, color: 'var(--price-down)' }}>PMS取得エラー: {error}</p>
      ) : !latest ? (
        <p style={summaryEmptyStyle}>PMS未計算です。`npm run batch:physical-momentum` 実行後に表示されます。</p>
      ) : (
        <>
          {insight && (
            <div style={physicalHeroStyle}>
              <div style={physicalHeroMainStyle}>
                <div style={physicalHeroLabelStyle}>総合判定</div>
                <div style={{ ...physicalHeroTitleStyle, color: insight.color }}>{insight.label}</div>
                <p style={physicalHeroDescriptionStyle}>{insight.description}</p>
                <div style={physicalReasonListStyle}>
                  {insight.reasons.map((reason) => (
                    <span key={reason} style={physicalReasonPillStyle}>{reason}</span>
                  ))}
                </div>
              </div>
              <PhysicalMomentumGauge
                value={latest.physicalMomentumScore}
                rank={data?.rank ?? null}
                total={data?.totalRanked ?? 0}
                trend={data?.trend ?? null}
              />
            </div>
          )}

          <div style={physicalScoreGridStyle}>
            <PhysicalScoreCard
              label="PMS"
              title="総合運動状態"
              value={latest.physicalMomentumScore}
              sub={data?.rank && data.totalRanked ? `市場順位 ${data.rank}/${data.totalRanked}` : '市場順位 -'}
              guide="物理量を銘柄横断で標準化した総合点"
              trend={data?.trend ?? null}
            />
            <PhysicalScoreCard
              label="PFS"
              title="力の変化"
              value={latest.physicalForceScore}
              sub={physicalSignalText(latest.physicalForceScore, 'force')}
              guide="Force と Acceleration。力が増えているかを見る"
              trend={null}
            />
            <PhysicalScoreCard
              label="PES"
              title="運動エネルギー"
              value={latest.physicalEnergyScore}
              sub={physicalSignalText(latest.physicalEnergyScore, 'energy')}
              guide="Energy と Momentum。力が蓄積/放出されているかを見る"
              trend={null}
            />
          </div>

          <div style={physicalBodyGridStyle}>
            <PhysicalMaFieldMap latest={latest} previous={previous} />
            <div style={physicalBreakdownPanelStyle}>
              <div style={physicalMiniHeaderStyle}>
                <strong>内訳</strong>
                <span>数値は補足。まずは力場とPMS/PFS/PESを見ます。</span>
              </div>
              <div style={physicalBreakdownGridStyle}>
                <PhysicalBreakdown label="速度" help="20営業日前からの変化率" value={fmtPctValue(latest.velocity)} tone={latest.velocity} />
                <PhysicalBreakdown label="加速度" help="速度の変化" value={fmtDecimal(latest.acceleration, 4)} tone={latest.acceleration} />
                <PhysicalBreakdown label="運動量" help="出来高 × 速度" value={fmtCompact(latest.momentum)} tone={latest.momentum} />
                <PhysicalBreakdown label="力" help="出来高 × 加速度" value={fmtCompact(latest.force)} tone={latest.force} />
                <PhysicalBreakdown label="運動エネルギー" help="出来高 × 速度^2" value={fmtCompact(latest.energy)} tone={latest.energy} />
              </div>
            </div>
            <PhysicalMomentumSparkline history={data?.history ?? []} />
          </div>
        </>
      )}
    </div>
  )
}

function PhysicalScoreCard({
  label,
  title,
  value,
  sub,
  guide,
  trend,
  valueFormatter = fmtScore,
}: {
  label: string
  title: string
  value: number | null
  sub: string
  guide: string
  trend: 'rising' | 'falling' | 'flat' | null
  valueFormatter?: (value: number | null | undefined) => string
}) {
  const tone = value == null ? 'var(--text-muted)' : value >= 0 ? 'var(--price-up)' : 'var(--price-down)'
  const pct = scoreBarPercent(value)
  return (
    <div style={physicalScoreCardStyle}>
      <div style={physicalScoreTopStyle}>
        <span style={physicalScoreLabelStyle}>{label}</span>
        <strong style={{ color: tone }}>{valueFormatter(value)}</strong>
      </div>
      <div style={physicalScoreTitleStyle}>{title}</div>
      <div style={physicalMeterTrackStyle}>
        <span style={{ ...physicalMeterFillStyle, width: `${pct}%`, background: tone }} />
      </div>
      <small style={physicalScoreSubStyle}>
        {trend === 'rising' ? '上昇中 / ' : trend === 'falling' ? '低下中 / ' : trend === 'flat' ? '横ばい / ' : ''}
        {sub}
      </small>
      <span style={physicalScoreGuideStyle}>{guide}</span>
    </div>
  )
}

function PhysicalMomentumGauge({
  value,
  rank,
  total,
  trend,
}: {
  value: number | null
  rank: number | null
  total: number
  trend: PhysicalMomentumResponse['trend']
}) {
  const pct = scoreBarPercent(value)
  const tone = value == null ? 'var(--text-muted)' : value >= 0 ? 'var(--price-up)' : 'var(--price-down)'
  const fillLeft = value == null || !Number.isFinite(value) ? 50 : value >= 0 ? 50 : pct
  const fillWidth = value == null || !Number.isFinite(value) ? 0 : Math.abs(pct - 50)
  const rankText = rank && total ? `市場 ${rank.toLocaleString('ja-JP')}位 / ${total.toLocaleString('ja-JP')}銘柄` : '市場順位 -'
  return (
    <div style={physicalGaugeStyle}>
      <div style={physicalGaugeValueRowStyle}>
        <span>PMS</span>
        <strong style={{ color: tone }}>{fmtScore(value)}</strong>
      </div>
      <div style={physicalGaugeTrackStyle}>
        <span style={physicalGaugeZeroStyle} />
        <span style={{ ...physicalGaugeFillStyle, left: `${fillLeft}%`, width: `${fillWidth}%`, background: tone }} />
      </div>
      <div style={physicalGaugeScaleStyle}>
        <span>弱い -2</span>
        <span>平均 0</span>
        <span>強い +2</span>
      </div>
      <div style={physicalGaugeMetaStyle}>
        <span>{rankText}</span>
        <b>{trend === 'rising' ? '上昇中' : trend === 'falling' ? '低下中' : trend === 'flat' ? '横ばい' : '方向未判定'}</b>
      </div>
    </div>
  )
}

function PhysicalBreakdown({ label, help, value, tone }: { label: string; help: string; value: string; tone?: number | null }) {
  const color = tone == null || !Number.isFinite(tone) ? 'var(--text-primary)' : tone >= 0 ? 'var(--price-up)' : 'var(--price-down)'
  return (
    <div style={physicalBreakdownStyle}>
      <span>{label}</span>
      <strong style={{ color }}>{value}</strong>
      <small>{help}</small>
    </div>
  )
}

function PhysicalMaFieldMap({ latest, previous }: { latest: PhysicalMomentumApiRow; previous: PhysicalMomentumApiRow | null }) {
  const field = buildMaFieldInsight(latest, previous)
  const angles = [
    { label: '5MA', value: latest.ma5Angle },
    { label: '25MA', value: latest.ma25Angle },
    { label: '75MA', value: latest.ma75Angle },
    { label: '200MA', value: latest.ma200Angle },
  ]

  return (
    <div style={physicalFieldPanelStyle}>
      <div style={physicalMiniHeaderStyle}>
        <strong>MA力場</strong>
        <span>平均ではなく、短期から長期への力の伝わり方を見ます。</span>
      </div>
      <div style={physicalFieldSummaryStyle}>
        <strong style={{ color: field.color }}>{field.label}</strong>
        <span>{field.description}</span>
      </div>
      <div style={physicalFieldMetaStyle}>
        <span>角度幅 {field.spreadDeg == null ? '-' : `${field.spreadDeg.toFixed(1)}°`}</span>
        <span>{field.spreadChangeDeg == null ? '変化 -' : `前回比 ${field.spreadChangeDeg >= 0 ? '+' : ''}${field.spreadChangeDeg.toFixed(1)}°`}</span>
      </div>
      <div style={physicalAngleRowsStyle}>
        {angles.map((angle) => {
          const deg = angleDeg(angle.value)
          const tone = deg == null ? 'var(--text-muted)' : deg >= 0 ? 'var(--price-up)' : 'var(--price-down)'
          const pct = angleBarPercent(deg)
          const left = deg == null ? 50 : deg >= 0 ? 50 : pct
          const width = deg == null ? 0 : Math.abs(pct - 50)
          return (
            <div key={angle.label} style={physicalAngleRowStyle}>
              <span>{angle.label}</span>
              <div style={physicalAngleTrackStyle}>
                <i style={physicalAngleZeroStyle} />
                <b style={{ ...physicalAngleFillStyle, left: `${left}%`, width: `${width}%`, background: tone }} />
              </div>
              <strong style={{ color: tone }}>{deg == null ? '-' : `${deg.toFixed(1)}°`}</strong>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PhysicalMomentumSparkline({ history }: { history: PhysicalMomentumApiRow[] }) {
  const chart = useMemo(() => {
    const points = history
      .filter((row) => row.physicalMomentumScore != null && Number.isFinite(row.physicalMomentumScore))
      .slice(-160)
    if (points.length < 2) return null
    const values = points.map((row) => row.physicalMomentumScore as number)
    const min = Math.min(...values)
    const max = Math.max(...values)
    const span = max - min || 1
    const width = 420
    const height = 128
    const polyline = points
      .map((row, index) => {
        const x = (index / (points.length - 1)) * width
        const y = height - (((row.physicalMomentumScore as number) - min) / span) * height
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
    const zeroY = min <= 0 && max >= 0
      ? height - ((0 - min) / span) * height
      : null
    return { polyline, min, max, width, height, zeroY, firstDate: points[0].date, lastDate: points[points.length - 1].date }
  }, [history])

  if (!chart) {
    return <div style={physicalSparklineEmptyStyle}>PMS時系列はまだ不足しています。</div>
  }

  return (
    <div style={physicalSparklineBoxStyle}>
      <div style={physicalSparklineHeaderStyle}>
        <strong>PMS推移</strong>
        <span>{chart.firstDate} → {chart.lastDate}</span>
      </div>
      <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label="PMS時系列チャート" style={{ width: '100%', height: '128px' }}>
        {chart.zeroY != null && (
          <line x1="0" x2={chart.width} y1={chart.zeroY} y2={chart.zeroY} stroke="var(--border-subtle)" strokeDasharray="4 4" />
        )}
        <polyline points={chart.polyline} fill="none" stroke="var(--accent-primary)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div style={physicalSparklineScaleStyle}>
        <span>{fmtScore(chart.min)}</span>
        <span>{fmtScore(chart.max)}</span>
      </div>
    </div>
  )
}

interface PhysicalMaFieldInsight {
  label: string
  description: string
  color: string
  spreadDeg: number | null
  spreadChangeDeg: number | null
}

function buildMaFieldInsight(latest: PhysicalMomentumApiRow, previous: PhysicalMomentumApiRow | null): PhysicalMaFieldInsight {
  const latestAngles = [latest.ma5Angle, latest.ma25Angle, latest.ma75Angle, latest.ma200Angle]
    .map(angleDeg)
    .filter((value): value is number => value != null)
  const previousAngles = previous
    ? [previous.ma5Angle, previous.ma25Angle, previous.ma75Angle, previous.ma200Angle]
      .map(angleDeg)
      .filter((value): value is number => value != null)
    : []

  if (latestAngles.length < 3) {
    return {
      label: 'MA力場未判定',
      description: 'MA角度データが不足しています。',
      color: 'var(--text-muted)',
      spreadDeg: null,
      spreadChangeDeg: null,
    }
  }

  const ma5 = angleDeg(latest.ma5Angle)
  const ma25 = angleDeg(latest.ma25Angle)
  const ma75 = angleDeg(latest.ma75Angle)
  const ma200 = angleDeg(latest.ma200Angle)
  const shortAvg = averageFinite([ma5, ma25])
  const longAvg = averageFinite([ma75, ma200])
  const positive = latestAngles.filter((value) => value > 0.2).length
  const negative = latestAngles.filter((value) => value < -0.2).length
  const spreadDeg = angularSpread(latestAngles)
  const previousSpread = previousAngles.length >= 3 ? angularSpread(previousAngles) : null
  const spreadChangeDeg = spreadDeg != null && previousSpread != null ? spreadDeg - previousSpread : null

  let label = '力場は中立'
  let description = '短期線と長期線の向きがまだ揃っていません。価格の力がどちらへ伝わるか確認する局面です。'
  let color = 'var(--text-secondary)'

  if (shortAvg != null && longAvg != null && shortAvg > 0.2 && longAvg > 0.2 && positive >= 3) {
    label = '上方向へ力が拡散'
    description = '短期線だけでなく長期線側にも上向きの力が伝わっています。上位足との整合を確認したい状態です。'
    color = 'var(--price-up)'
  } else if (shortAvg != null && longAvg != null && shortAvg < -0.2 && longAvg < -0.2 && negative >= 3) {
    label = '下方向へ力が拡散'
    description = '短期線から長期線側まで下向きの力が広がっています。反発よりも下落継続リスクを優先確認します。'
    color = 'var(--price-down)'
  } else if (shortAvg != null && longAvg != null && shortAvg > 0.2 && longAvg < -0.2) {
    label = '短期上向き・長期収縮'
    description = '短期には上向きの力がありますが、長期線はまだ下向きです。力が長期側へ拡散するかが焦点です。'
    color = 'var(--price-up)'
  } else if (shortAvg != null && longAvg != null && shortAvg < -0.2 && longAvg > 0.2) {
    label = '短期調整・長期残存'
    description = '短期線は下向きですが、長期線には上向きの力が残っています。一時調整か崩れ始めかを確認します。'
    color = 'var(--price-down)'
  } else if (spreadChangeDeg != null && spreadChangeDeg >= 5) {
    label = '力場が拡散中'
    description = 'MA角度の幅が広がっています。力が一方向へ揃うか、ねじれとして分散するかを確認します。'
    color = positive >= negative ? 'var(--price-up)' : 'var(--price-down)'
  } else if (spreadChangeDeg != null && spreadChangeDeg <= -5) {
    label = '力場が収縮中'
    description = 'MA角度の幅が狭まっています。方向感はいったん圧縮され、次の拡散方向を待つ局面です。'
    color = 'var(--text-secondary)'
  } else if (positive > 0 && negative > 0) {
    label = '力場がねじれ'
    description = '短期・中期・長期の向きが混在しています。単純な上昇/下落ではなく、時間軸ごとの力の差を見ます。'
    color = 'var(--text-secondary)'
  }

  return { label, description, color, spreadDeg, spreadChangeDeg }
}

function angleDeg(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null
  return (value * 180) / Math.PI
}

function averageFinite(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => value != null && Number.isFinite(value))
  if (finite.length === 0) return null
  return finite.reduce((sum, value) => sum + value, 0) / finite.length
}

function angularSpread(values: number[]): number | null {
  if (values.length === 0) return null
  return Math.max(...values) - Math.min(...values)
}

function angleBarPercent(value: number | null): number {
  if (value == null || !Number.isFinite(value)) return 50
  const clipped = Math.max(-75, Math.min(75, value))
  return ((clipped + 75) / 150) * 100
}

function buildPhysicalMomentumInsight(
  latest: PhysicalMomentumApiRow,
  rank: number | null,
  total: number,
  trend: PhysicalMomentumResponse['trend'],
  field: PhysicalMaFieldInsight | null,
) {
  const pms = latest.physicalMomentumScore
  const pfs = latest.physicalForceScore
  const pes = latest.physicalEnergyScore
  const color = pms == null ? 'var(--text-muted)' : pms >= 0 ? 'var(--price-up)' : 'var(--price-down)'
  let label = '中立'
  let description = '市場平均に近い運動状態です。力場の拡散/収縮、PFS、PES、ステージ判定を併せて確認します。'
  if (pms != null && pms >= 2) {
    label = '強い上向きの力'
    description = '総合運動状態が市場平均を大きく上回っています。力が長期側へ拡散しているか、短期だけの過熱かをMA力場で確認します。'
  } else if (pms != null && pms >= 1) {
    label = '上向きの力が優勢'
    description = '市場平均より明確に強い運動状態です。PFSがプラスなら力が増加中、PESがプラスならエネルギーが残っています。'
  } else if (pms != null && pms >= 0.35) {
    label = 'やや上向き'
    description = '市場平均よりやや強い状態です。短期の力が長期側へ伝わっているか、MA力場で確認します。'
  } else if (pms != null && pms <= -2) {
    label = '強い下向きの力'
    description = '総合運動状態が市場平均を大きく下回っています。下向きの力が長期側へ拡散しているかを優先確認します。'
  } else if (pms != null && pms <= -1) {
    label = '下向きの力が優勢'
    description = '市場平均より弱い運動状態です。PFSもマイナスなら、下向きの力がまだ残っている可能性があります。'
  } else if (pms != null && pms <= -0.35) {
    label = 'やや下向き'
    description = '市場平均よりやや弱い状態です。力が収縮して反転準備に入っているのか、下方向へ拡散中なのかを確認します。'
  }

  const reasons = [
    `PMS ${fmtScore(pms)}`,
    trend === 'rising' ? 'PMS上昇中' : trend === 'falling' ? 'PMS低下中' : 'PMS横ばい',
    rank && total ? `市場上位 ${Math.max(1, Math.round((rank / total) * 100))}%` : '順位未取得',
    physicalSignalText(pfs, 'force'),
    physicalSignalText(pes, 'energy'),
    field?.label ?? 'MA力場未判定',
  ]

  return { label, description, color, reasons }
}

function physicalSignalText(value: number | null | undefined, kind: 'force' | 'energy'): string {
  if (value == null || !Number.isFinite(value)) return kind === 'force' ? '力の変化未判定' : 'エネルギー未判定'
  if (kind === 'force') {
    if (value >= 1) return '上向きの力が強い'
    if (value >= 0.35) return '上向きの力あり'
    if (value <= -1) return '下向きの力が強い'
    if (value <= -0.35) return '下向きの力あり'
    return '力の変化は中立'
  }
  if (value >= 1) return '運動エネルギーが高い'
  if (value >= 0.35) return '運動エネルギーあり'
  if (value <= -1) return '運動エネルギーが弱い'
  if (value <= -0.35) return '運動エネルギーはやや弱い'
  return '運動エネルギーは中立'
}

function scoreBarPercent(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 50
  const clipped = Math.max(-2.5, Math.min(2.5, value))
  return ((clipped + 2.5) / 5) * 100
}

function fmtScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return value.toFixed(2)
}

function fmtDecimal(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return value.toFixed(digits)
}

function fmtPctValue(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`
}

function fmtCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return new Intl.NumberFormat('ja-JP', {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value)
}

type StageKey =
  | 'daily_a_stage'
  | 'daily_b_stage'
  | 'weekly_a_stage'
  | 'weekly_b_stage'
  | 'monthly_a_stage'
  | 'monthly_b_stage'

interface SummaryStageEntry {
  date: string
  close: number | null
  ma_5: number | null
  ma_25: number | null
  ma_75: number | null
  ma_300: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}

const SUMMARY_STAGE_KEYS: { key: StageKey; label: string }[] = [
  { key: 'daily_a_stage', label: '日A' },
  { key: 'daily_b_stage', label: '日B' },
  { key: 'weekly_a_stage', label: '週A' },
  { key: 'weekly_b_stage', label: '週B' },
  { key: 'monthly_a_stage', label: '月A' },
  { key: 'monthly_b_stage', label: '月B' },
]

function CalendarRangeSelector({
  selectedRange,
  onRangeSelect,
  onClear,
}: {
  selectedRange: ChartDateRange | null
  onRangeSelect: (range: ChartDateRange) => void
  onClear: () => void
}) {
  const [startDate, setStartDate] = useState(selectedRange?.startDate ?? '')
  const [endDate, setEndDate] = useState(selectedRange?.endDate ?? '')
  const [error, setError] = useState('')

  useEffect(() => {
    setStartDate(selectedRange?.startDate ?? '')
    setEndDate(selectedRange?.endDate ?? '')
    setError('')
  }, [selectedRange?.startDate, selectedRange?.endDate])

  function applyRange(nextStart = startDate, nextEnd = endDate) {
    if (!nextStart || !nextEnd) {
      setError('開始日と終了日を選択してください。')
      return
    }
    const ordered =
      nextStart <= nextEnd
        ? { startDate: nextStart, endDate: nextEnd }
        : { startDate: nextEnd, endDate: nextStart }
    setError('')
    onRangeSelect(ordered)
  }

  function applyPreset(days: number) {
    const end = selectedRange?.endDate ?? isoTodayJst()
    const start = isoDaysBefore(end, days)
    setStartDate(start)
    setEndDate(end)
    setError('')
    onRangeSelect({ startDate: start, endDate: end })
  }

  function clearRange() {
    setStartDate('')
    setEndDate('')
    setError('')
    onClear()
  }

  return (
    <div className="card" style={calendarCardStyle}>
      <div style={calendarHeaderStyle}>
        <div>
          <strong style={{ fontSize: '12px' }}>期間をカレンダーで選択</strong>
          <div style={{ color: 'var(--text-muted)', fontSize: '10px', marginTop: '2px' }}>
            選択した期間はステージ表、日足・週足・月足チャート、サマリーへ同期します。
          </div>
        </div>
        <div style={presetGroupStyle}>
          <button type="button" onClick={() => applyPreset(30)} style={presetButtonStyle}>1か月</button>
          <button type="button" onClick={() => applyPreset(90)} style={presetButtonStyle}>3か月</button>
          <button type="button" onClick={() => applyPreset(365)} style={presetButtonStyle}>1年</button>
        </div>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          applyRange()
        }}
        style={calendarFormStyle}
      >
        <label style={dateInputLabelStyle}>
          <span>開始日</span>
          <input
            type="date"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
            style={dateInputStyle}
          />
        </label>
        <label style={dateInputLabelStyle}>
          <span>終了日</span>
          <input
            type="date"
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
            style={dateInputStyle}
          />
        </label>
        <button type="submit" style={applyButtonStyle}>適用</button>
        <button type="button" onClick={clearRange} style={clearButtonStyle}>解除</button>
      </form>
      {error && <div style={calendarErrorStyle}>{error}</div>}
    </div>
  )
}

function SelectedRangeSummary({ ticker, range }: { ticker: string; range: StockSelectedRange | null }) {
  const [entries, setEntries] = useState<SummaryStageEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!range) {
      setEntries([])
      setError('')
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError('')
    const params = new URLSearchParams({
      granularity: 'daily',
      startDate: range.startDate,
      endDate: range.endDate,
      count: '3000',
    })
    fetch(`/api/stage-history/${encodeURIComponent(ticker)}?${params.toString()}`, { cache: 'no-store' })
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
      .then((data) => {
        if (cancelled) return
        if (data.error) throw new Error(data.message ?? data.error)
        setEntries(data.history ?? [])
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [ticker, range?.startDate, range?.endDate])

  if (!range) {
    return (
      <div className="card" style={summaryCardStyle}>
        <div style={summaryTitleRowStyle}>
          <strong>選択期間サマリー</strong>
          <span>チャートをズーム/パン、またはステージ表のセルをクリック</span>
        </div>
        <p style={summaryEmptyStyle}>
          チャートの表示範囲とステージ変遷を同じ日付軸で結び、期間内のステージ変化・騰落率・MA状態をここに表示します。
        </p>
      </div>
    )
  }

  const summary = buildRangeSummary(entries)

  return (
    <div className="card" style={summaryCardStyle}>
      <div style={summaryTitleRowStyle}>
        <strong>選択期間サマリー</strong>
        <span>{range.sourceLabel} / {range.startDate} → {range.endDate}</span>
      </div>
      {loading ? (
        <p style={summaryEmptyStyle}>集計中...</p>
      ) : error ? (
        <p style={{ ...summaryEmptyStyle, color: 'var(--price-down)' }}>集計エラー: {error}</p>
      ) : !summary ? (
        <p style={summaryEmptyStyle}>集計対象データ不足</p>
      ) : (
        <>
          <div style={summaryGridStyle}>
            <SummaryMetric label="騰落率" value={fmtPct(summary.returnPct)} tone={summary.returnPct} />
            <SummaryMetric label="終値" value={`${fmtPrice(summary.startClose)} → ${fmtPrice(summary.endClose)}`} />
            <SummaryMetric label="データ数" value={`${summary.rows.toLocaleString('ja-JP')}営業日`} />
            <SummaryMetric label="ステージ変化" value={`${summary.stageChanges}回`} />
            <SummaryMetric label="MA配列" value={`${summary.startMaState} → ${summary.endMaState}`} />
            <SummaryMetric label="MA変化" value={summary.maChangeText} />
          </div>
          <div style={stageSummaryRowStyle}>
            {SUMMARY_STAGE_KEYS.map(({ key, label }) => (
              <span key={key} style={stageSummaryItemStyle}>
                <small>{label}</small>
                <StageMini stage={summary.startStages[key]} />
                <b>→</b>
                <StageMini stage={summary.endStages[key]} />
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function SummaryMetric({ label, value, tone }: { label: string; value: string; tone?: number | null }) {
  return (
    <div style={summaryMetricStyle}>
      <span>{label}</span>
      <strong style={{ color: tone == null ? 'var(--text-primary)' : tone >= 0 ? 'var(--price-up)' : 'var(--price-down)' }}>
        {value}
      </strong>
    </div>
  )
}

function StageMini({ stage }: { stage: number | null }) {
  if (!stage) return <i style={stageMiniEmptyStyle}>-</i>
  return (
    <i style={{
      ...stageMiniStyle,
      background: STAGE_BORDER_COLORS[stage],
    }}>
      {stage}
    </i>
  )
}

function buildRangeSummary(entries: SummaryStageEntry[]) {
  const rows = entries.filter((entry) => entry.date && entry.close != null && Number.isFinite(entry.close))
  if (entries.length === 0 || rows.length < 2) return null
  const startPriceRow = rows[0]
  const endPriceRow = rows[rows.length - 1]
  const startClose = Number(startPriceRow.close)
  const endClose = Number(endPriceRow.close)
  if (!Number.isFinite(startClose) || startClose === 0 || !Number.isFinite(endClose)) return null

  const startStageRow = entries.find((entry) => SUMMARY_STAGE_KEYS.some(({ key }) => entry[key] != null)) ?? entries[0]
  const endStageRow = [...entries].reverse().find((entry) => SUMMARY_STAGE_KEYS.some(({ key }) => entry[key] != null)) ?? entries[entries.length - 1]
  const startStages = Object.fromEntries(SUMMARY_STAGE_KEYS.map(({ key }) => [key, startStageRow?.[key] ?? null])) as Record<StageKey, number | null>
  const endStages = Object.fromEntries(SUMMARY_STAGE_KEYS.map(({ key }) => [key, endStageRow?.[key] ?? null])) as Record<StageKey, number | null>

  let stageChanges = 0
  for (const { key } of SUMMARY_STAGE_KEYS) {
    let prev: number | null = null
    for (const entry of entries) {
      const current = entry[key]
      if (current == null) continue
      if (prev != null && current !== prev) stageChanges += 1
      prev = current
    }
  }

  const startMaRow = entries.find((entry) => entry.ma_5 != null && entry.ma_25 != null && entry.ma_75 != null) ?? entries[0]
  const endMaRow = [...entries].reverse().find((entry) => entry.ma_5 != null && entry.ma_25 != null && entry.ma_75 != null) ?? entries[entries.length - 1]

  return {
    rows: entries.length,
    startClose,
    endClose,
    returnPct: ((endClose - startClose) / startClose) * 100,
    stageChanges,
    startStages,
    endStages,
    startMaState: maState(startMaRow),
    endMaState: maState(endMaRow),
    maChangeText: maChangeText(startMaRow, endMaRow),
  }
}

function maState(entry: Pick<SummaryStageEntry, 'ma_5' | 'ma_25' | 'ma_75'> | undefined): string {
  if (!entry || entry.ma_5 == null || entry.ma_25 == null || entry.ma_75 == null) return '不足'
  if (entry.ma_5 > entry.ma_25 && entry.ma_25 > entry.ma_75) return '上昇配列'
  if (entry.ma_5 < entry.ma_25 && entry.ma_25 < entry.ma_75) return '下降配列'
  return '混在'
}

function maChangeText(start: SummaryStageEntry | undefined, end: SummaryStageEntry | undefined): string {
  const changes = [
    ['5MA', pctChange(start?.ma_5, end?.ma_5)],
    ['25MA', pctChange(start?.ma_25, end?.ma_25)],
    ['75MA', pctChange(start?.ma_75, end?.ma_75)],
  ] as const
  const parts = changes
    .filter(([, value]) => value != null)
    .map(([label, value]) => `${label} ${fmtPct(value)}`)
  return parts.length > 0 ? parts.join(' / ') : '不足'
}

function pctChange(start: number | null | undefined, end: number | null | undefined): number | null {
  if (start == null || end == null || !Number.isFinite(start) || !Number.isFinite(end) || start === 0) return null
  return ((end - start) / start) * 100
}

function fmtPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${Math.round(value).toLocaleString('ja-JP')}円`
}

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function intervalLabel(interval: TvInterval): string {
  if (interval === 'D') return '日足'
  if (interval === 'W') return '週足'
  return '月足'
}

function isoTodayJst(): string {
  const now = new Date()
  const jst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
  return [
    jst.getFullYear(),
    String(jst.getMonth() + 1).padStart(2, '0'),
    String(jst.getDate()).padStart(2, '0'),
  ].join('-')
}

function isoDaysBefore(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

const physicalCardStyle: CSSProperties = {
  padding: '14px',
}

const physicalHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '12px',
  flexWrap: 'wrap',
  marginBottom: '10px',
}

const physicalSubTextStyle: CSSProperties = {
  marginTop: '4px',
  color: 'var(--text-muted)',
  fontSize: '11px',
}

const physicalDateBadgeStyle: CSSProperties = {
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-secondary)',
  fontFamily: 'var(--font-mono)',
  fontSize: '11px',
  fontWeight: 700,
  padding: '4px 8px',
}

const physicalHeroStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))',
  gap: '10px',
  alignItems: 'stretch',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'linear-gradient(180deg, #fff, var(--bg-elevated))',
  padding: '12px',
  marginBottom: '10px',
}

const physicalHeroMainStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  minWidth: 0,
}

const physicalHeroLabelStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: '10px',
  fontWeight: 700,
}

const physicalHeroTitleStyle: CSSProperties = {
  fontSize: '22px',
  fontWeight: 800,
  lineHeight: 1.15,
}

const physicalHeroDescriptionStyle: CSSProperties = {
  margin: 0,
  color: 'var(--text-secondary)',
  fontSize: '12px',
  lineHeight: 1.65,
}

const physicalReasonListStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
}

const physicalReasonPillStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: '999px',
  background: '#fff',
  color: 'var(--text-secondary)',
  fontSize: '10px',
  fontWeight: 700,
  padding: '4px 8px',
}

const physicalGaugeStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: '#fff',
  padding: '10px',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  gap: '8px',
  minWidth: 0,
}

const physicalGaugeValueRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '8px',
}

const physicalGaugeTrackStyle: CSSProperties = {
  position: 'relative',
  height: '10px',
  borderRadius: '999px',
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-subtle)',
  overflow: 'hidden',
}

const physicalGaugeFillStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  borderRadius: '999px',
  opacity: 0.85,
}

const physicalGaugeZeroStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: 0,
  bottom: 0,
  width: '1px',
  background: 'var(--text-muted)',
  opacity: 0.5,
  zIndex: 1,
}

const physicalGaugeScaleStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  color: 'var(--text-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: '9px',
}

const physicalGaugeMetaStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '8px',
  color: 'var(--text-secondary)',
  fontSize: '10px',
}

const physicalScoreGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
  gap: '8px',
  marginBottom: '10px',
}

const physicalScoreCardStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-elevated)',
  padding: '10px',
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
}

const physicalScoreTopStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '8px',
}

const physicalScoreLabelStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
  fontWeight: 800,
}

const physicalScoreTitleStyle: CSSProperties = {
  color: 'var(--text-primary)',
  fontSize: '12px',
  fontWeight: 800,
}

const physicalMeterTrackStyle: CSSProperties = {
  height: '5px',
  borderRadius: '999px',
  background: 'var(--bg-surface)',
  overflow: 'hidden',
}

const physicalMeterFillStyle: CSSProperties = {
  display: 'block',
  height: '100%',
  borderRadius: '999px',
  opacity: 0.82,
}

const physicalScoreSubStyle: CSSProperties = {
  color: 'var(--text-secondary)',
  fontSize: '10px',
  lineHeight: 1.4,
}

const physicalScoreGuideStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: '10px',
  lineHeight: 1.45,
}

const physicalBodyGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))',
  gap: '10px',
}

const physicalBreakdownPanelStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: '#fff',
  padding: '8px',
}

const physicalFieldPanelStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: '#fff',
  padding: '8px',
  minWidth: 0,
}

const physicalMiniHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '8px',
  color: 'var(--text-secondary)',
  fontSize: '11px',
  marginBottom: '8px',
}

const physicalFieldSummaryStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-elevated)',
  padding: '8px',
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  marginBottom: '8px',
}

const physicalFieldMetaStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: '8px',
  color: 'var(--text-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
  marginBottom: '8px',
}

const physicalAngleRowsStyle: CSSProperties = {
  display: 'grid',
  gap: '6px',
}

const physicalAngleRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '42px minmax(0, 1fr) 58px',
  alignItems: 'center',
  gap: '8px',
  color: 'var(--text-secondary)',
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
}

const physicalAngleTrackStyle: CSSProperties = {
  position: 'relative',
  height: '7px',
  borderRadius: '999px',
  background: 'var(--bg-surface)',
  overflow: 'hidden',
}

const physicalAngleZeroStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: 0,
  bottom: 0,
  width: '1px',
  background: 'var(--text-muted)',
  opacity: 0.5,
  zIndex: 1,
}

const physicalAngleFillStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  borderRadius: '999px',
  opacity: 0.82,
}

const physicalBreakdownGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(126px, 1fr))',
  gap: '6px',
}

const physicalBreakdownStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-elevated)',
  padding: '7px 8px',
  display: 'flex',
  flexDirection: 'column',
  gap: '3px',
}

const physicalSparklineBoxStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: '#fff',
  padding: '8px',
  minWidth: 0,
}

const physicalSparklineHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '8px',
  color: 'var(--text-secondary)',
  fontSize: '11px',
  marginBottom: '4px',
}

const physicalSparklineScaleStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  color: 'var(--text-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
}

const physicalSparklineEmptyStyle: CSSProperties = {
  ...physicalSparklineBoxStyle,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--text-muted)',
  fontSize: '11px',
  minHeight: '150px',
}

const calendarCardStyle: CSSProperties = {
  marginTop: '8px',
  padding: '12px',
}

const calendarHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '12px',
  flexWrap: 'wrap',
  marginBottom: '10px',
}

const presetGroupStyle: CSSProperties = {
  display: 'flex',
  gap: '6px',
  flexWrap: 'wrap',
  justifyContent: 'flex-end',
}

const presetButtonStyle: CSSProperties = {
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-secondary)',
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
  fontWeight: 700,
  padding: '5px 8px',
  cursor: 'pointer',
}

const calendarFormStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
  gap: '8px',
  alignItems: 'end',
}

const dateInputLabelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  color: 'var(--text-muted)',
  fontSize: '10px',
  fontWeight: 700,
}

const dateInputStyle: CSSProperties = {
  height: '34px',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  background: '#fff',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-mono)',
  fontSize: '12px',
  padding: '0 8px',
}

const applyButtonStyle: CSSProperties = {
  height: '34px',
  border: '1px solid var(--accent-primary)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--accent-primary)',
  color: '#fff',
  fontSize: '12px',
  fontWeight: 700,
  cursor: 'pointer',
}

const clearButtonStyle: CSSProperties = {
  height: '34px',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  background: '#fff',
  color: 'var(--text-secondary)',
  fontSize: '12px',
  fontWeight: 700,
  cursor: 'pointer',
}

const calendarErrorStyle: CSSProperties = {
  marginTop: '8px',
  color: 'var(--price-down)',
  fontSize: '11px',
  fontWeight: 700,
}

const summaryCardStyle: CSSProperties = {
  marginTop: '8px',
  padding: '12px',
}

const summaryTitleRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '12px',
  flexWrap: 'wrap',
  marginBottom: '8px',
}

const summaryEmptyStyle: CSSProperties = {
  margin: 0,
  color: 'var(--text-muted)',
  fontSize: '11px',
}

const summaryGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(138px, 1fr))',
  gap: '8px',
  marginBottom: '10px',
}

const summaryMetricStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-elevated)',
  padding: '8px',
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
}

const stageSummaryRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
}

const stageSummaryItemStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  padding: '4px 6px',
  background: '#fff',
}

const stageMiniStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '18px',
  height: '18px',
  borderRadius: '3px',
  color: '#fff',
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
  fontStyle: 'normal',
  fontWeight: 700,
}

const stageMiniEmptyStyle: CSSProperties = {
  ...stageMiniStyle,
  background: 'var(--bg-surface)',
  color: 'var(--text-muted)',
}

function fmtShares(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '---'
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}百万株`
  return `${Math.round(value).toLocaleString('ja-JP')}株`
}

function fmtChange(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value > 0 ? '+' : ''}${Math.round(value).toLocaleString('ja-JP')}株`
}

function MarginInfoCard({ info, fallbackType }: { info: StockMarginInfo | null; fallbackType?: string | null }) {
  const latest = info?.latest
  const latestHistory = info?.history?.[0]
  return (
    <div className="card" style={{ padding: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '8px' }}>
        <div style={{ fontSize: '11px', fontWeight: 600 }}>貸借/信用</div>
        <MarginBadges
          marginType={latest?.marginType ?? fallbackType}
          creditRatio={latest?.creditRatio ?? null}
          shortRatio={latest?.shortRatio ?? null}
          compact
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '4px 8px' }}>
        <InfoLine label="基準週" value={latest?.asOfDate ?? latestHistory?.date ?? '---'} />
        <InfoLine label="信用倍率" value={latest?.creditRatio == null ? '---' : `${latest.creditRatio.toFixed(2)}倍`} />
        <InfoLine label="買残" value={fmtShares(latest?.longMargin ?? latestHistory?.longMargin)} />
        <InfoLine label="売残" value={fmtShares(latest?.shortMargin ?? latestHistory?.shortMargin)} />
        <InfoLine label="買残増減" value={fmtChange(latest?.longChange ?? latestHistory?.longChange)} />
        <InfoLine label="売残増減" value={fmtChange(latest?.shortChange ?? latestHistory?.shortChange)} />
      </div>
    </div>
  )
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      padding: '4px 0',
      borderBottom: '1px solid var(--border-subtle)',
      gap: '8px',
    }}>
      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-primary)', textAlign: 'right' }}>{value}</span>
    </div>
  )
}

function Pill({ label, accent }: { label: string; accent?: boolean }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      fontSize: '10px',
      fontFamily: 'var(--font-mono)',
      background: accent ? 'var(--accent-dim)' : 'var(--bg-elevated)',
      color: accent ? 'var(--accent-primary)' : 'var(--text-secondary)',
      border: `1px solid ${accent ? 'var(--accent-primary)' : 'var(--border-base)'}`,
      borderRadius: 'var(--radius-sm)',
    }}>
      {label}
    </span>
  )
}

function BasicInfoCard({ quote }: { quote: StockQuote | null }) {
  const items = [
    { label: '時価総額', value: quote?.marketCap != null ? `${(quote.marketCap / 1e8).toLocaleString('ja-JP', { maximumFractionDigits: 0 })} 億円` : '---' },
    { label: '出来高', value: quote?.volume ? quote.volume.toLocaleString('ja-JP') : '---' },
    { label: '52週高値', value: quote?.fiftyTwoWeekHigh != null ? `¥${quote.fiftyTwoWeekHigh.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}` : '---' },
    { label: '52週安値', value: quote?.fiftyTwoWeekLow != null ? `¥${quote.fiftyTwoWeekLow.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}` : '---' },
  ]

  return (
    <div className="card" style={{ padding: '12px' }}>
      <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '8px' }}>基本情報</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '4px 8px' }}>
        {items.map(({ label, value }) => (
          <div key={label} style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            padding: '4px 0',
            borderBottom: '1px solid var(--border-subtle)',
          }}>
            <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{label}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-primary)' }}>{value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
