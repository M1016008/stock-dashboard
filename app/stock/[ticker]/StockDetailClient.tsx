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

  return (
    <div className="card" style={physicalCardStyle}>
      <div style={physicalHeaderStyle}>
        <div>
          <div className="section-header" style={{ margin: 0 }}>Physical Momentum</div>
          <div style={physicalSubTextStyle}>
            速度・加速度・運動量・力・エネルギー・MA角度を横断Zスコア化した共通指標です。
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
          <div style={physicalScoreGridStyle}>
            <PhysicalScoreCard
              label="PMS"
              value={latest.physicalMomentumScore}
              sub={data?.rank && data.totalRanked ? `市場順位 ${data.rank}/${data.totalRanked}` : '市場順位 -'}
              trend={data?.trend ?? null}
            />
            <PhysicalScoreCard
              label="PFS"
              value={latest.physicalForceScore}
              sub="初動検出: Force + Acceleration"
              trend={null}
            />
            <PhysicalScoreCard
              label="PES"
              value={latest.physicalEnergyScore}
              sub="ブレイクアウト: Energy + Momentum"
              trend={null}
            />
            <PhysicalScoreCard
              label="MA角度"
              value={latest.maAngleAvg}
              sub="5/25/75/200MA平均"
              trend={null}
              valueFormatter={fmtAngleDeg}
            />
          </div>

          <div style={physicalBodyGridStyle}>
            <div style={physicalBreakdownGridStyle}>
              <PhysicalBreakdown label="Velocity" value={fmtPctValue(latest.velocity)} />
              <PhysicalBreakdown label="Acceleration" value={fmtDecimal(latest.acceleration, 4)} />
              <PhysicalBreakdown label="Momentum" value={fmtCompact(latest.momentum)} />
              <PhysicalBreakdown label="Force" value={fmtCompact(latest.force)} />
              <PhysicalBreakdown label="Energy" value={fmtCompact(latest.energy)} />
              <PhysicalBreakdown label="MA角度平均" value={fmtAngleDeg(latest.maAngleAvg)} />
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
  value,
  sub,
  trend,
  valueFormatter = fmtScore,
}: {
  label: string
  value: number | null
  sub: string
  trend: 'rising' | 'falling' | 'flat' | null
  valueFormatter?: (value: number | null | undefined) => string
}) {
  const tone = value == null ? 'var(--text-muted)' : value >= 0 ? 'var(--price-up)' : 'var(--price-down)'
  return (
    <div style={physicalScoreCardStyle}>
      <span>{label}</span>
      <strong style={{ color: tone }}>{valueFormatter(value)}</strong>
      <small>
        {trend === 'rising' ? '上昇中 / ' : trend === 'falling' ? '低下中 / ' : trend === 'flat' ? '横ばい / ' : ''}
        {sub}
      </small>
    </div>
  )
}

function PhysicalBreakdown({ label, value }: { label: string; value: string }) {
  return (
    <div style={physicalBreakdownStyle}>
      <span>{label}</span>
      <strong>{value}</strong>
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
    return { polyline, min, max, width, height, firstDate: points[0].date, lastDate: points[points.length - 1].date }
  }, [history])

  if (!chart) {
    return <div style={physicalSparklineEmptyStyle}>PMS時系列はまだ不足しています。</div>
  }

  return (
    <div style={physicalSparklineBoxStyle}>
      <div style={physicalSparklineHeaderStyle}>
        <strong>PMS時系列</strong>
        <span>{chart.firstDate} → {chart.lastDate}</span>
      </div>
      <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label="PMS時系列チャート" style={{ width: '100%', height: '128px' }}>
        <line x1="0" x2={chart.width} y1={chart.height / 2} y2={chart.height / 2} stroke="var(--border-subtle)" strokeDasharray="4 4" />
        <polyline points={chart.polyline} fill="none" stroke="var(--accent-primary)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div style={physicalSparklineScaleStyle}>
        <span>{fmtScore(chart.min)}</span>
        <span>{fmtScore(chart.max)}</span>
      </div>
    </div>
  )
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

function fmtAngleDeg(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${((value * 180) / Math.PI).toFixed(2)}°`
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
  gap: '4px',
}

const physicalBodyGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))',
  gap: '10px',
}

const physicalBreakdownGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(126px, 1fr))',
  gap: '6px',
}

const physicalBreakdownStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: '#fff',
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
