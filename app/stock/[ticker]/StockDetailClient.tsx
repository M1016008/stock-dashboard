// app/stock/[ticker]/StockDetailClient.tsx
'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { MarketBadge } from '@/components/ui/MarketBadge'
import { MarginBadges } from '@/components/ui/MarginBadges'
import { PriceDisplay } from '@/components/ui/PriceDisplay'
import { CandlestickChart } from '@/components/charts/CandlestickChart'
import { PerformanceCard } from '@/components/stock/PerformanceCard'
import { EarningsCard } from '@/components/stock/EarningsCard'
import { WatchlistButton } from '@/components/ui/WatchlistButton'
import { StageTimeline } from '@/components/stock/StageTimeline'
import { StockMovePeriods } from '@/components/stock/StockMovePeriods'
import { StockMlInsights } from '@/components/stock/StockMlInsights'
import { ScenarioProjectionChart } from '@/components/stock/ScenarioProjectionChart'
import { TradeScenarioNotebook } from '@/components/stock/TradeScenarioNotebook'
import { StockScenarioAiPanel } from '@/components/stock/StockScenarioAiPanel'
import { findTicker } from '@/lib/master/tickers'
import { STAGE_BG_COLORS, STAGE_BORDER_COLORS, STAGE_LABELS } from '@/lib/hex-stage'
import { buildShortTermCheck, type ShortTermCheckTone } from '@/lib/short-term-check'
import { buildPhysicalMomentumView, type PhysicalMomentumCheck, type PhysicalMomentumTone } from '@/lib/physical-momentum-view'
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

export function StockDetailClient({ ticker }: StockDetailClientProps) {
  const [quote, setQuote] = useState<StockQuote | null>(null)
  const [smaster, setSmaster] = useState<SectorMasterRow | null>(null)
  const [marginInfo, setMarginInfo] = useState<StockMarginInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [analysisDate, setAnalysisDate] = useState<string | null>(null)

  const hardcoded = findTicker(ticker)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const date = params.get('date')
    setAnalysisDate(date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null)
  }, [ticker])

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

  const updateAnalysisDate = useCallback((date: string | null) => {
    setAnalysisDate(date)
    const url = new URL(window.location.href)
    if (date) {
      url.searchParams.set('date', date)
    } else {
      url.searchParams.delete('date')
    }
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  }, [])

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
        <BasicInfoCard ticker={ticker} quote={quote} />
        <MarketSnapshotCard ticker={ticker} marginInfo={marginInfo} fallbackType={displayMarginType} />
      </div>

      {/* 決算情報 */}
      <EarningsCard ticker={ticker} />

      <PhysicalMomentumSection ticker={ticker} analysisDate={analysisDate} />

      <AnalysisDateControl analysisDate={analysisDate} onChange={updateAnalysisDate} />

      <TradeScenarioNotebook
        ticker={ticker}
        name={name}
        quote={quote}
        selectedRange={null}
        context={{
          marketSegment: displayMarketSegment,
          marginType: displayMarginType,
          sector17: displaySectorLarge,
          sector33: displaySector33,
        }}
      />

      {/* ステージ変遷 */}
      <div>
        <div className="section-header">ステージ変遷</div>
        <StageTimeline ticker={ticker} />
      </div>

      {/* マルチタイムフレームチャート: 日足 / 2日足 / 週足 / 2週足 / 月足 / 2ヶ月足 */}
      <div>
        <div className="section-header">マルチタイムフレームチャート</div>
        <CandlestickChart
          ticker={ticker}
          interval="D"
          height={460}
          historyPeriod="all"
          showTimeframeSelector
          maLinesByInterval={{
            D: [3, 5, 25, 75],
            '2D': [3, 5, 25, 75],
            W: [3, 13, 26, 52],
            '2W': [3, 13, 26, 52],
            M: [3, 12, 24, 60],
            '2M': [3, 12, 24, 60],
          }}
        />
      </div>

      {/* 過去の大きな値動き */}
      <StockMovePeriods ticker={ticker} />

      <ScenarioProjectionChart ticker={ticker} name={name} analysisDate={analysisDate} />

      <StockScenarioAiPanel ticker={ticker} name={name} analysisDate={analysisDate} />

      {/* 最新ML類似候補 */}
      <StockMlInsights ticker={ticker} />

    </div>
  )
}

function AnalysisDateControl({
  analysisDate,
  onChange,
}: {
  analysisDate: string | null
  onChange: (date: string | null) => void
}) {
  const [draft, setDraft] = useState(analysisDate ?? '')

  useEffect(() => {
    setDraft(analysisDate ?? '')
  }, [analysisDate])

  const applyDraft = useCallback((next: string) => {
    setDraft(next)
    onChange(next || null)
  }, [onChange])

  return (
    <section className="card" style={analysisDateCardStyle}>
      <div>
        <div className="section-header" style={analysisDateTitleStyle}>シナリオ・AI分析基準日</div>
        <p style={analysisDateSubTextStyle}>
          日付を指定すると、その日付以前の価格・物理特徴量・ML候補だけでシナリオとAI回答を再構成します。
          未指定なら最新データで分析します。
        </p>
      </div>
      <div style={analysisDateControlsStyle}>
        <label style={analysisDateInputLabelStyle}>
          基準日
          <input
            type="date"
            value={draft}
            onInput={(event) => applyDraft((event.target as HTMLInputElement).value)}
            onChange={(event) => applyDraft(event.target.value)}
            style={analysisDateInputStyle}
          />
        </label>
        <button type="button" onClick={() => onChange(draft || null)} style={analysisDateApplyButtonStyle}>
          反映
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft('')
            onChange(null)
          }}
          style={analysisDateClearButtonStyle}
        >
          最新に戻す
        </button>
      </div>
      <div style={analysisDateBadgeStyle}>
        現在: {analysisDate ? `${analysisDate}時点` : '最新時点'}
      </div>
    </section>
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

interface PhysicalPlanCandidate {
  asOfDate: string
  direction: 'up' | 'down' | 'wait'
  rank: number
  score: number
  modelName: string | null
}

interface PhysicalPlanLevel {
  label: string
  value: number | null
  distancePct: number | null
}

interface PhysicalPlanLevels {
  baseDate: string
  close: number
  support: PhysicalPlanLevel
  resistance: PhysicalPlanLevel
  breakdown: PhysicalPlanLevel
}

interface PhysicalPlanHorizon {
  label: string
  horizonDays: number
  description: string
  statusLabel: string
  targetDirection: 'up' | 'down' | 'wait' | null
  hitRate: number | null
  baseRate: number | null
  lift: number | null
  confidenceScore: number | null
  confidenceLabel: string
  sampleCount: number | null
  adverseRate: number | null
  avgReturnPct: number | null
  avgMaxReturnPct: number | null
  avgMinReturnPct: number | null
  medianReturnPct: number | null
  evaluationDate: string | null
  candidates: PhysicalPlanCandidate[]
  levels: PhysicalPlanLevels | null
  suggestion: {
    tone: 'positive' | 'negative' | 'neutral' | 'warning'
    stance: string
    headline: string
    summary: string
    checklist: string[]
    invalidation: string
  }
}

interface PhysicalPlanResponse {
  ok: boolean
  available: boolean
  ticker: string
  featureSet?: string
  featureAsOfDate?: string | null
  requestedDate?: string | null
  priceAsOfDate?: string | null
  note?: string
  horizons: PhysicalPlanHorizon[]
}

function PhysicalMomentumSection({ ticker, analysisDate }: { ticker: string; analysisDate: string | null }) {
  const [data, setData] = useState<PhysicalMomentumResponse | null>(null)
  const [plan, setPlan] = useState<PhysicalPlanResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [planLoading, setPlanLoading] = useState(true)
  const [planError, setPlanError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setPlanLoading(true)
    setPlanError('')
    const planParams = analysisDate ? `?date=${encodeURIComponent(analysisDate)}` : ''
    Promise.allSettled([
      fetch(`/api/physical-momentum/${encodeURIComponent(ticker)}?market=JP&limit=260`, { cache: 'no-store' })
        .then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))),
      fetch(`/api/stock-physical-plan/${encodeURIComponent(ticker)}${planParams}`, { cache: 'no-store' })
        .then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))),
    ])
      .then(([momentumResult, planResult]) => {
        if (cancelled) return
        if (momentumResult.status === 'fulfilled') {
          setData(momentumResult.value)
        } else {
          setError((momentumResult.reason as Error).message)
        }
        if (planResult.status === 'fulfilled') {
          setPlan(planResult.value)
        } else {
          setPlanError((planResult.reason as Error).message)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
          setPlanLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [ticker, analysisDate])

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
            PMSは買い/売りの予測ではなく、直近20営業日の累積運動量です。足元の向きはPFS、過熱や大値幅はPESで分けて見ます。
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
                <div style={{ ...physicalHeroLabelStyle, color: insight.color }}>結論</div>
                <div style={{ ...physicalHeroTitleStyle, color: insight.color }}>{insight.label}</div>
                <p style={physicalHeroDescriptionStyle}>{insight.description}</p>
              </div>
              <div style={physicalReasonPanelStyle}>
                <div style={physicalReasonPanelTitleStyle}>根拠</div>
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
              label="20日累積の動き"
              code="PMS"
              title="方向+熱量の合成"
              value={latest.physicalMomentumScore}
              sub={data?.rank && data.totalRanked ? `市場順位 ${data.rank}/${data.totalRanked}` : '市場順位 -'}
              guide="高い=買いではなく、20営業日で大きく動いた状態。足元の向きはPFSで確認"
              trend={data?.trend ?? null}
            />
            <PhysicalScoreCard
              label="足元の力"
              code="PFS"
              title="初動/失速"
              value={latest.physicalForceScore}
              sub={physicalSignalText(latest.physicalForceScore, 'force')}
              guide="加速度とForce。上向き/下向きの力が増えているかを見る"
              trend={null}
            />
            <PhysicalScoreCard
              label="動きの熱量"
              code="PES"
              title="値幅/過熱"
              value={latest.physicalEnergyScore}
              sub={physicalSignalText(latest.physicalEnergyScore, 'energy')}
              guide="高いほど大きく動いた状態。方向ではなく、過熱・巻き戻しリスクも含めて見る"
              trend={null}
            />
          </div>

          <PhysicalActionPoints latest={latest} trend={data?.trend ?? null} field={fieldInsight} />

          <PhysicalTradePlanCards loading={planLoading} error={planError} plan={plan} />

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
  code,
  title,
  value,
  sub,
  guide,
  trend,
  valueFormatter = fmtScore,
}: {
  label: string
  code: string
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
        <span style={physicalScoreLabelWrapStyle}>
          <span style={physicalScoreLabelStyle}>{label}</span>
          <span style={physicalScoreCodeStyle}>{code}</span>
        </span>
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
  const angleNodes = angles.map((angle) => {
    const deg = angleDeg(angle.value)
    return {
      ...angle,
      deg,
      arrow: angleDirectionArrow(deg),
      labelText: angleDirectionLabel(deg),
      color: angleDirectionColor(deg),
    }
  })

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
      <div style={physicalFieldFlowStyle}>
        {angleNodes.map((node, index) => (
          <Fragment key={node.label}>
            <div style={{ ...physicalFieldNodeStyle, borderColor: node.color }}>
              <span style={physicalFieldNodeLabelStyle}>{node.label}</span>
              <strong style={{ ...physicalFieldNodeArrowStyle, color: node.color }}>{node.arrow}</strong>
              <span style={physicalFieldNodeMetaStyle}>{node.labelText}</span>
              <small style={physicalFieldNodeDegreeStyle}>{node.deg == null ? '-' : `${node.deg.toFixed(1)}°`}</small>
            </div>
            {index < angleNodes.length - 1 && (
              <span style={physicalFieldConnectorStyle}>→</span>
            )}
          </Fragment>
        ))}
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
    if (points.length === 0) return null
    const scoreMin = -2.5
    const scoreMax = 2.5
    const span = scoreMax - scoreMin
    const width = 520
    const height = 184
    const pad = { left: 40, right: 58, top: 18, bottom: 26 }
    const innerWidth = width - pad.left - pad.right
    const innerHeight = height - pad.top - pad.bottom
    const yFor = (value: number) => {
      const clipped = Math.max(scoreMin, Math.min(scoreMax, value))
      return pad.top + ((scoreMax - clipped) / span) * innerHeight
    }
    const xFor = (index: number) => pad.left + (points.length === 1 ? innerWidth : (index / (points.length - 1)) * innerWidth)
    const polyline = points
      .map((row, index) => {
        const x = xFor(index)
        const y = yFor(row.physicalMomentumScore as number)
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
    const latest = points[points.length - 1]
    const first = points[0]
    const latestScore = latest.physicalMomentumScore as number
    const firstScore = first.physicalMomentumScore as number
    const prev = points.length >= 2 ? points[points.length - 2] : null
    const prevScore = prev?.physicalMomentumScore ?? null
    const point20 = points.length >= 21 ? points[points.length - 21] : null
    const point60 = points.length >= 61 ? points[points.length - 61] : null
    return {
      points,
      polyline,
      width,
      height,
      pad,
      innerWidth,
      innerHeight,
      scoreMin,
      scoreMax,
      yFor,
      xFor,
      latest,
      latestScore,
      firstDate: first.date,
      lastDate: latest.date,
      latestX: xFor(points.length - 1),
      latestY: yFor(latestScore),
      deltaAll: latestScore - firstScore,
      deltaPrev: prevScore == null ? null : latestScore - prevScore,
      delta20: point20?.physicalMomentumScore == null ? null : latestScore - point20.physicalMomentumScore,
      delta60: point60?.physicalMomentumScore == null ? null : latestScore - point60.physicalMomentumScore,
    }
  }, [history])

  if (!chart) {
    return <div style={physicalSparklineEmptyStyle}>PMS時系列はまだ不足しています。</div>
  }

  const sparse = chart.points.length < 20
  const directionDelta = chart.delta20 ?? chart.delta60 ?? chart.deltaAll
  const trendLabel = trendLabelFromDelta(directionDelta)
  const latestTone = chart.latestScore >= 0 ? 'var(--price-up)' : 'var(--price-down)'
  const latestLabelX = chart.latestX > chart.width - 96 ? chart.latestX - 92 : chart.latestX + 8
  const latestLabelAnchor = chart.latestX > chart.width - 96 ? 'end' : 'start'

  return (
    <div style={physicalSparklineBoxStyle}>
      <div style={physicalSparklineHeaderStyle}>
        <div>
          <strong>PMS推移</strong>
          <small style={physicalTrendHeaderNoteStyle}>固定スケールで市場平均との差を表示</small>
        </div>
        <span>{chart.firstDate} → {chart.lastDate}</span>
      </div>
      {sparse ? (
        <div style={physicalSparseTrendStyle}>
          <div style={physicalSparseTrendMainStyle}>
            <strong style={{ color: latestTone }}>{scoreLevelLabel(chart.latestScore)}</strong>
            <span>
              PMS履歴が{chart.points.length}営業日分だけなので、推移チャートとしてはまだ弱いです。
              最新値と直近変化を中心に見てください。
            </span>
          </div>
          <div style={physicalSparsePointRowStyle}>
            {chart.points.map((point) => {
              const score = point.physicalMomentumScore ?? 0
              return (
                <span
                  key={point.date}
                  style={{
                    ...physicalSparsePointStyle,
                    background: score >= 0 ? 'rgba(220, 38, 38, 0.12)' : 'rgba(37, 99, 235, 0.12)',
                    color: score >= 0 ? 'var(--price-up)' : 'var(--price-down)',
                    borderColor: score >= 0 ? 'rgba(220, 38, 38, 0.28)' : 'rgba(37, 99, 235, 0.28)',
                  }}
                >
                  {fmtScore(score)}
                </span>
              )
            })}
          </div>
        </div>
      ) : (
        <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label="PMS時系列チャート" style={physicalTrendSvgStyle}>
          <rect
            x={chart.pad.left}
            y={chart.pad.top}
            width={chart.innerWidth}
            height={chart.yFor(1) - chart.pad.top}
            fill="rgba(220, 38, 38, 0.07)"
            rx="4"
          />
          <rect
            x={chart.pad.left}
            y={chart.yFor(-1)}
            width={chart.innerWidth}
            height={chart.pad.top + chart.innerHeight - chart.yFor(-1)}
            fill="rgba(37, 99, 235, 0.07)"
            rx="4"
          />
          {[-2, -1, 0, 1, 2].map((line) => (
            <g key={line}>
              <line
                x1={chart.pad.left}
                x2={chart.pad.left + chart.innerWidth}
                y1={chart.yFor(line)}
                y2={chart.yFor(line)}
                stroke={line === 0 ? 'var(--text-muted)' : 'var(--border-subtle)'}
                strokeDasharray={line === 0 ? '4 4' : undefined}
                opacity={line === 0 ? 0.62 : 0.8}
              />
              <text
                x={chart.pad.left - 8}
                y={chart.yFor(line) + 3}
                textAnchor="end"
                fontSize="10"
                fill="var(--text-muted)"
                fontFamily="var(--font-mono)"
              >
                {line > 0 ? `+${line}` : line}
              </text>
            </g>
          ))}
          <polyline
            points={chart.polyline}
            fill="none"
            stroke={latestTone}
            strokeWidth="3"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <circle cx={chart.latestX} cy={chart.latestY} r="4.8" fill="#fff" stroke={latestTone} strokeWidth="2.6" />
          <text
            x={latestLabelX}
            y={Math.max(16, chart.latestY - 7)}
            textAnchor={latestLabelAnchor}
            fontSize="11"
            fontWeight="800"
            fill={latestTone}
            fontFamily="var(--font-mono)"
          >
            {fmtScore(chart.latestScore)}
          </text>
          <text x={chart.pad.left} y={chart.height - 5} fontSize="10" fill="var(--text-muted)" fontFamily="var(--font-mono)">
            {chart.firstDate}
          </text>
          <text x={chart.pad.left + chart.innerWidth} y={chart.height - 5} textAnchor="end" fontSize="10" fill="var(--text-muted)" fontFamily="var(--font-mono)">
            {chart.lastDate}
          </text>
        </svg>
      )}
      <div style={physicalTrendLegendStyle}>
        <span><i style={{ ...physicalTrendLegendMarkerStyle, background: 'rgba(220, 38, 38, 0.16)' }} /> +1以上: 市場より強い</span>
        <span><i style={{ ...physicalTrendLegendMarkerStyle, background: 'rgba(37, 99, 235, 0.16)' }} /> -1以下: 市場より弱い</span>
        <span><i style={{ ...physicalTrendLegendMarkerStyle, background: 'var(--text-muted)' }} /> 0: 市場平均</span>
      </div>
      <div style={physicalTrendSummaryGridStyle}>
        <PhysicalTrendChip label="最新" value={fmtScore(chart.latestScore)} tone={chart.latestScore} />
        <PhysicalTrendChip label="全期間" value={formatDelta(chart.deltaAll)} tone={chart.deltaAll} />
        <PhysicalTrendChip label="20日変化" value={formatDelta(chart.delta20)} tone={chart.delta20} />
        <PhysicalTrendChip label="直近方向" value={trendLabel} tone={directionDelta} />
      </div>
    </div>
  )
}

function PhysicalTrendChip({ label, value, tone }: { label: string; value: string; tone: number | null | undefined }) {
  const color = tone == null || !Number.isFinite(tone) ? 'var(--text-primary)' : tone >= 0 ? 'var(--price-up)' : 'var(--price-down)'
  return (
    <div style={physicalTrendChipStyle}>
      <span>{label}</span>
      <strong style={{ color }}>{value}</strong>
    </div>
  )
}

function PhysicalActionPoints({
  latest,
  trend,
  field,
}: {
  latest: PhysicalMomentumApiRow
  trend: PhysicalMomentumResponse['trend']
  field: PhysicalMaFieldInsight | null
}) {
  const points = buildPhysicalActionPoints(latest, trend, field)
  return (
    <div style={physicalActionPanelStyle}>
      <div style={physicalMiniHeaderStyle}>
        <strong>だから、どう見る？</strong>
        <span>買い目線と空売り目線を分けて、次に確認する条件だけを表示します。</span>
      </div>
      <div style={physicalActionListStyle}>
        {points.map((point, index) => (
          <div key={`${point.label}-${point.text}`} style={{ ...physicalActionItemStyle, ...physicalActionToneStyle(point.tone) }}>
            <span style={{ ...physicalActionIndexStyle, ...physicalActionIndexToneStyle(point.tone) }}>{index + 1}</span>
            <span>
              <strong style={physicalActionLabelStyle}>{point.label}</strong>
              <span>{point.text}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function PhysicalTradePlanCards({
  loading,
  error,
  plan,
}: {
  loading: boolean
  error: string
  plan: PhysicalPlanResponse | null
}) {
  if (loading) {
    return (
      <div style={physicalTradePlanPanelStyle}>
        <div style={physicalMiniHeaderStyle}>
          <strong>短期・中期・長期プラン</strong>
          <span>統計と物理MLを確認中...</span>
        </div>
        <div style={physicalTradePlanGridStyle}>
          {['短期', '中期', '長期'].map((label) => (
            <div key={label} style={{ ...physicalTradePlanCardStyle, minHeight: 154, background: 'var(--surface-muted)' }} />
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div style={physicalTradePlanPanelStyle}>
        <div style={physicalMiniHeaderStyle}>
          <strong>短期・中期・長期プラン</strong>
          <span style={{ color: 'var(--price-down)' }}>取得エラー: {error}</span>
        </div>
      </div>
    )
  }

  if (!plan?.available || plan.horizons.length === 0) {
    return (
      <div style={physicalTradePlanPanelStyle}>
        <div style={physicalMiniHeaderStyle}>
          <strong>短期・中期・長期プラン</strong>
          <span>物理ML特徴量が不足しています</span>
        </div>
        <p style={summaryEmptyStyle}>現時点では時間軸別の統計解釈を作れません。</p>
      </div>
    )
  }

  return (
    <div style={physicalTradePlanPanelStyle}>
      <div style={physicalMiniHeaderStyle}>
        <strong>短期・中期・長期の観察プラン</strong>
        <span>{plan.featureAsOfDate ? `特徴量 ${plan.featureAsOfDate}` : '特徴量日付 -'}</span>
      </div>
      <div style={physicalTradePlanGridStyle}>
        {plan.horizons.map((horizon) => (
          <PhysicalTradePlanCard key={`${horizon.label}-${horizon.horizonDays}`} horizon={horizon} />
        ))}
      </div>
      <p style={physicalTradePlanNoteStyle}>
        {plan.note ?? 'この表示は現在形状と過去検証統計から作る観察メモです。売買を断定するものではありません。'}
      </p>
    </div>
  )
}

function PhysicalTradePlanCard({ horizon }: { horizon: PhysicalPlanHorizon }) {
  const tone = tradePlanToneStyle(horizon.suggestion.tone)
  const topCandidates = horizon.candidates
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 3)
  return (
    <div style={{ ...physicalTradePlanCardStyle, borderColor: tone.border, background: tone.background }}>
      <div style={physicalTradePlanTopStyle}>
        <div>
          <span style={physicalTradePlanLabelStyle}>{horizon.label}</span>
          <strong style={{ ...physicalTradePlanHeadlineStyle, color: tone.color }}>{horizon.suggestion.headline}</strong>
        </div>
        <span style={{ ...physicalTradePlanBadgeStyle, borderColor: tone.border, color: tone.color }}>
          {horizon.horizonDays}営業日
        </span>
      </div>
      <p style={physicalTradePlanStanceStyle}>{horizon.suggestion.stance}</p>
      <PhysicalPlanLevelStrip levels={horizon.levels} />
      <div style={physicalTradePlanMetricGridStyle}>
        <PhysicalPlanMetric label="的中率" value={fmtRate(horizon.hitRate)} sub={`base ${fmtRate(horizon.baseRate)}`} />
        <PhysicalPlanMetric label="lift" value={fmtLift(horizon.lift)} sub={`信頼 ${horizon.confidenceLabel}`} />
        <PhysicalPlanMetric label="平均順行" value={fmtPctRaw(horizon.avgMaxReturnPct)} sub={`逆行 ${fmtPctRaw(horizon.avgMinReturnPct)}`} />
      </div>
      <div style={physicalTradePlanCandidatesStyle}>
        {topCandidates.length > 0 ? topCandidates.map((candidate) => (
          <span key={`${candidate.direction}-${candidate.rank}`} style={physicalTradePlanCandidatePillStyle}>
            {directionLabelJa(candidate.direction)} #{candidate.rank}
          </span>
        )) : (
          <span style={physicalTradePlanCandidatePillStyle}>物理ML上位外</span>
        )}
        {horizon.sampleCount != null && (
          <span style={physicalTradePlanCandidatePillStyle}>検証 n={horizon.sampleCount.toLocaleString('ja-JP')}</span>
        )}
      </div>
      <div style={physicalTradePlanChecklistStyle}>
        {horizon.suggestion.checklist.slice(0, 2).map((item) => (
          <div key={item} style={physicalTradePlanCheckItemStyle}>
            <span style={{ ...physicalTradePlanDotStyle, background: tone.color }} />
            <span>{item}</span>
          </div>
        ))}
      </div>
      <div style={physicalTradePlanInvalidationStyle}>
        <strong>崩れる条件</strong>
        <span>{horizon.suggestion.invalidation}</span>
      </div>
      <div style={physicalTradePlanFooterStyle}>
        <span>{horizon.evaluationDate ? `検証 ${horizon.evaluationDate}` : '検証日 -'}</span>
      </div>
    </div>
  )
}

function PhysicalPlanLevelStrip({ levels }: { levels: PhysicalPlanLevels | null }) {
  if (!levels) return null
  return (
    <div style={physicalTradePlanLevelGridStyle}>
      <PhysicalPlanLevelChip label="基準" level={{ label: levels.baseDate, value: levels.close, distancePct: 0 }} tone="base" />
      <PhysicalPlanLevelChip label="支持/反発" level={levels.support} tone="support" />
      <PhysicalPlanLevelChip label="抵抗/反落" level={levels.resistance} tone="resistance" />
      <PhysicalPlanLevelChip label="割れ注意" level={levels.breakdown} tone="breakdown" />
    </div>
  )
}

function PhysicalPlanLevelChip({
  label,
  level,
  tone,
}: {
  label: string
  level: PhysicalPlanLevel
  tone: 'base' | 'support' | 'resistance' | 'breakdown'
}) {
  const color =
    tone === 'support' ? 'var(--price-up)'
      : tone === 'resistance' || tone === 'breakdown' ? 'var(--price-down)'
        : 'var(--text-primary)'
  return (
    <div style={physicalTradePlanLevelChipStyle}>
      <span style={physicalTradePlanLevelLabelStyle}>{label}</span>
      <strong style={{ ...physicalTradePlanLevelValueStyle, color }}>{fmtPrice(level.value)}</strong>
      <small style={physicalTradePlanLevelSubStyle}>
        {level.label}{level.distancePct != null ? ` ${fmtPct(level.distancePct)}` : ''}
      </small>
    </div>
  )
}

function PhysicalPlanMetric({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div style={physicalTradePlanMetricStyle}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{sub}</small>
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

function angleDirectionArrow(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '-'
  if (value >= 1.2) return '↗'
  if (value <= -1.2) return '↘'
  return '→'
}

function angleDirectionLabel(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '未判定'
  if (value >= 3) return '上向き強'
  if (value >= 1.2) return '上向き'
  if (value <= -3) return '下向き強'
  if (value <= -1.2) return '下向き'
  return '横ばい'
}

function angleDirectionColor(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'var(--text-muted)'
  if (value >= 1.2) return 'var(--price-up)'
  if (value <= -1.2) return 'var(--price-down)'
  return 'var(--text-secondary)'
}

function physicalToneColor(tone: PhysicalMomentumTone): string {
  if (tone === 'up') return 'var(--price-up)'
  if (tone === 'down') return 'var(--price-down)'
  if (tone === 'warning') return '#b45309'
  return 'var(--text-secondary)'
}

function physicalActionToneStyle(tone: PhysicalMomentumTone): CSSProperties {
  if (tone === 'up') {
    return {
      borderColor: 'rgba(220, 38, 38, 0.28)',
      background: 'linear-gradient(135deg, rgba(220, 38, 38, 0.08), #fff 72%)',
      color: 'var(--text-primary)',
    }
  }
  if (tone === 'down') {
    return {
      borderColor: 'rgba(37, 99, 235, 0.30)',
      background: 'linear-gradient(135deg, rgba(37, 99, 235, 0.09), #fff 72%)',
      color: 'var(--text-primary)',
    }
  }
  if (tone === 'warning') {
    return {
      borderColor: 'rgba(245, 158, 11, 0.34)',
      background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.12), #fff 72%)',
      color: 'var(--text-primary)',
    }
  }
  return {}
}

function physicalActionIndexToneStyle(tone: PhysicalMomentumTone): CSSProperties {
  const color = physicalToneColor(tone)
  return {
    color,
    borderColor: color,
    background: tone === 'neutral' ? 'var(--bg-elevated)' : '#fff',
  }
}

function buildPhysicalMomentumInsight(
  latest: PhysicalMomentumApiRow,
  rank: number | null,
  total: number,
  trend: PhysicalMomentumResponse['trend'],
  field: PhysicalMaFieldInsight | null,
) {
  const view = buildPhysicalMomentumView({
    pms: latest.physicalMomentumScore,
    pfs: latest.physicalForceScore,
    pes: latest.physicalEnergyScore,
    trend,
    rank,
    total,
    fieldLabel: field?.label,
  })

  return {
    label: view.label,
    description: view.summary,
    color: physicalToneColor(view.tone),
    reasons: view.badges,
  }
}

function buildPhysicalActionPoints(
  latest: PhysicalMomentumApiRow,
  trend: PhysicalMomentumResponse['trend'],
  field: PhysicalMaFieldInsight | null,
): PhysicalMomentumCheck[] {
  return buildPhysicalMomentumView({
    pms: latest.physicalMomentumScore,
    pfs: latest.physicalForceScore,
    pes: latest.physicalEnergyScore,
    trend,
    fieldLabel: field?.label,
  }).checks
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

function fmtRate(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${(value * 100).toFixed(0)}%`
}

function fmtLift(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value.toFixed(2)}x`
}

function fmtPctRaw(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function directionLabelJa(direction: 'up' | 'down' | 'wait'): string {
  if (direction === 'up') return '上昇'
  if (direction === 'down') return '下落'
  return '見送り'
}

function tradePlanToneStyle(tone: PhysicalPlanHorizon['suggestion']['tone']) {
  if (tone === 'positive') {
    return { color: 'var(--price-up)', border: 'rgba(22, 163, 74, 0.34)', background: 'rgba(22, 163, 74, 0.06)' }
  }
  if (tone === 'negative') {
    return { color: 'var(--price-down)', border: 'rgba(37, 99, 235, 0.34)', background: 'rgba(37, 99, 235, 0.06)' }
  }
  if (tone === 'warning') {
    return { color: '#b45309', border: 'rgba(245, 158, 11, 0.36)', background: 'rgba(245, 158, 11, 0.08)' }
  }
  return { color: 'var(--text-secondary)', border: 'var(--border-subtle)', background: 'var(--bg-elevated)' }
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

function formatDelta(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`
}

function trendLabelFromDelta(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '判定保留'
  if (value >= 0.35) return '改善'
  if (value <= -0.35) return '悪化'
  return '横ばい'
}

function scoreLevelLabel(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'PMS未判定'
  if (value >= 1) return '市場より強い'
  if (value >= 0.35) return 'やや強い'
  if (value <= -1) return '市場より弱い'
  if (value <= -0.35) return 'やや弱い'
  return '市場平均付近'
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

function fmtPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${Math.round(value).toLocaleString('ja-JP')}円`
}

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

const analysisDateCardStyle: CSSProperties = {
  padding: 14,
  display: 'flex',
  gap: 12,
  alignItems: 'center',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
}

const analysisDateTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
}

const analysisDateSubTextStyle: CSSProperties = {
  margin: '4px 0 0',
  color: 'var(--text-secondary)',
  fontSize: 12,
  lineHeight: 1.6,
}

const analysisDateControlsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'end',
  gap: 8,
  flexWrap: 'wrap',
}

const analysisDateInputLabelStyle: CSSProperties = {
  display: 'grid',
  gap: 4,
  color: 'var(--text-muted)',
  fontSize: 11,
  fontWeight: 900,
}

const analysisDateInputStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 8,
  padding: '8px 10px',
  fontSize: 13,
  color: 'var(--text-primary)',
  background: '#fff',
}

const analysisDateApplyButtonStyle: CSSProperties = {
  border: '1px solid var(--accent-primary)',
  borderRadius: 8,
  background: 'var(--accent-primary)',
  color: '#fff',
  fontSize: 12,
  fontWeight: 900,
  padding: '9px 12px',
  cursor: 'pointer',
}

const analysisDateClearButtonStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 8,
  background: '#fff',
  color: 'var(--text-secondary)',
  fontSize: 12,
  fontWeight: 900,
  padding: '9px 12px',
  cursor: 'pointer',
}

const analysisDateBadgeStyle: CSSProperties = {
  border: '1px solid rgba(37, 99, 235, 0.22)',
  borderRadius: 999,
  background: 'rgba(37, 99, 235, 0.06)',
  color: 'var(--accent-primary)',
  fontSize: 12,
  fontWeight: 900,
  padding: '7px 10px',
  whiteSpace: 'nowrap',
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
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))',
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
  alignSelf: 'flex-start',
  border: '1px solid currentColor',
  borderRadius: '999px',
  background: '#fff',
  color: 'var(--text-muted)',
  fontSize: '10px',
  fontWeight: 800,
  padding: '3px 8px',
}

const physicalHeroTitleStyle: CSSProperties = {
  fontSize: '24px',
  fontWeight: 800,
  lineHeight: 1.15,
}

const physicalHeroDescriptionStyle: CSSProperties = {
  margin: 0,
  color: 'var(--text-secondary)',
  fontSize: '12px',
  lineHeight: 1.65,
}

const physicalReasonPanelStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'rgba(255,255,255,0.72)',
  padding: '10px',
  minWidth: 0,
}

const physicalReasonPanelTitleStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: '10px',
  fontWeight: 800,
  marginBottom: '8px',
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

const physicalScoreLabelWrapStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  minWidth: 0,
}

const physicalScoreLabelStyle: CSSProperties = {
  color: 'var(--text-primary)',
  fontSize: '11px',
  fontWeight: 800,
}

const physicalScoreCodeStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: '999px',
  background: '#fff',
  color: 'var(--text-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: '9px',
  fontWeight: 800,
  padding: '1px 5px',
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

const physicalActionPanelStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'linear-gradient(180deg, #fff 0%, var(--bg-elevated) 100%)',
  padding: '10px',
  marginBottom: '10px',
}

const physicalActionListStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))',
  gap: '7px',
}

const physicalActionItemStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: '#fff',
  color: 'var(--text-secondary)',
  display: 'grid',
  gridTemplateColumns: '22px minmax(0, 1fr)',
  gap: '7px',
  alignItems: 'start',
  fontSize: '11px',
  lineHeight: 1.55,
  padding: '8px',
}

const physicalActionLabelStyle: CSSProperties = {
  display: 'block',
  color: 'var(--text-primary)',
  fontSize: '11px',
  fontWeight: 900,
  marginBottom: '2px',
}

const physicalActionIndexStyle: CSSProperties = {
  width: '20px',
  height: '20px',
  borderRadius: '999px',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-subtle)',
  color: 'var(--text-primary)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
  fontWeight: 800,
}

const physicalTradePlanPanelStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: '#fff',
  padding: '10px',
  marginBottom: '10px',
}

const physicalTradePlanGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))',
  gap: '8px',
}

const physicalTradePlanCardStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  padding: '10px',
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  minWidth: 0,
}

const physicalTradePlanTopStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: '8px',
  alignItems: 'flex-start',
}

const physicalTradePlanLabelStyle: CSSProperties = {
  display: 'block',
  color: 'var(--text-muted)',
  fontSize: '10px',
  fontWeight: 900,
  marginBottom: '3px',
}

const physicalTradePlanHeadlineStyle: CSSProperties = {
  display: 'block',
  fontSize: '14px',
  fontWeight: 900,
  lineHeight: 1.35,
}

const physicalTradePlanBadgeStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: '999px',
  background: '#fff',
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
  fontWeight: 900,
  padding: '3px 7px',
  whiteSpace: 'nowrap',
}

const physicalTradePlanStanceStyle: CSSProperties = {
  margin: 0,
  color: 'var(--text-primary)',
  fontSize: '12px',
  fontWeight: 900,
  lineHeight: 1.45,
}

const physicalTradePlanSummaryStyle: CSSProperties = {
  margin: 0,
  color: 'var(--text-secondary)',
  fontSize: '11px',
  lineHeight: 1.6,
}

const physicalTradePlanLevelGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: '5px',
}

const physicalTradePlanLevelChipStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: '7px',
  background: 'rgba(255,255,255,0.72)',
  padding: '6px',
  display: 'grid',
  gap: '2px',
  minWidth: 0,
}

const physicalTradePlanLevelLabelStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: '9px',
  fontWeight: 900,
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
}

const physicalTradePlanLevelValueStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '13px',
  fontWeight: 900,
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
}

const physicalTradePlanLevelSubStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: '9px',
  fontWeight: 700,
  lineHeight: 1.25,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const physicalTradePlanMetricGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: '5px',
}

const physicalTradePlanMetricStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: '7px',
  background: '#fff',
  padding: '7px',
  display: 'grid',
  gap: '2px',
  minWidth: 0,
}

const physicalTradePlanCandidatesStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '5px',
}

const physicalTradePlanCandidatePillStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: '999px',
  background: '#fff',
  color: 'var(--text-secondary)',
  fontSize: '10px',
  fontWeight: 800,
  padding: '3px 7px',
}

const physicalTradePlanChecklistStyle: CSSProperties = {
  display: 'grid',
  gap: '5px',
}

const physicalTradePlanCheckItemStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '8px minmax(0, 1fr)',
  gap: '6px',
  alignItems: 'start',
  color: 'var(--text-secondary)',
  fontSize: '11px',
  lineHeight: 1.5,
}

const physicalTradePlanDotStyle: CSSProperties = {
  width: '6px',
  height: '6px',
  borderRadius: '999px',
  marginTop: '6px',
  opacity: 0.85,
}

const physicalTradePlanInvalidationStyle: CSSProperties = {
  borderTop: '1px solid var(--border-subtle)',
  paddingTop: '7px',
  display: 'grid',
  gap: '3px',
  color: 'var(--text-secondary)',
  fontSize: '11px',
  lineHeight: 1.5,
}

const physicalTradePlanFooterStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: '8px',
  flexWrap: 'wrap',
  color: 'var(--text-muted)',
  fontSize: '10px',
  lineHeight: 1.4,
}

const physicalTradePlanNoteStyle: CSSProperties = {
  margin: '8px 0 0',
  color: 'var(--text-muted)',
  fontSize: '10px',
  lineHeight: 1.5,
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

const physicalFieldFlowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '5px',
  marginBottom: '9px',
}

const physicalFieldNodeStyle: CSSProperties = {
  minWidth: '64px',
  flex: '1 1 64px',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-elevated)',
  padding: '7px 6px',
  display: 'grid',
  justifyItems: 'center',
  gap: '2px',
}

const physicalFieldNodeLabelStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: '9px',
  fontWeight: 800,
}

const physicalFieldNodeArrowStyle: CSSProperties = {
  fontSize: '18px',
  lineHeight: 1,
}

const physicalFieldNodeMetaStyle: CSSProperties = {
  color: 'var(--text-secondary)',
  fontSize: '9px',
  fontWeight: 800,
  whiteSpace: 'nowrap',
}

const physicalFieldNodeDegreeStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: '9px',
}

const physicalFieldConnectorStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: '11px',
  textAlign: 'center',
  opacity: 0.72,
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
  marginBottom: '8px',
}

const physicalTrendHeaderNoteStyle: CSSProperties = {
  display: 'block',
  marginTop: '2px',
  color: 'var(--text-muted)',
  fontSize: '10px',
  fontWeight: 600,
}

const physicalTrendSvgStyle: CSSProperties = {
  width: '100%',
  height: '184px',
  display: 'block',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'linear-gradient(180deg, #fff 0%, var(--bg-elevated) 100%)',
}

const physicalTrendLegendStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px 10px',
  marginTop: '7px',
  color: 'var(--text-muted)',
  fontSize: '10px',
  lineHeight: 1.4,
}

const physicalTrendLegendMarkerStyle: CSSProperties = {
  display: 'inline-block',
  width: '9px',
  height: '9px',
  borderRadius: '2px',
  marginRight: '4px',
  verticalAlign: '-1px',
}

const physicalTrendSummaryGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
  gap: '6px',
  marginTop: '8px',
}

const physicalTrendChipStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-elevated)',
  padding: '6px 7px',
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  minWidth: 0,
}

const physicalSparseTrendStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'linear-gradient(180deg, #fff 0%, var(--bg-elevated) 100%)',
  padding: '10px',
}

const physicalSparseTrendMainStyle: CSSProperties = {
  display: 'grid',
  gap: '4px',
  color: 'var(--text-secondary)',
  fontSize: '11px',
  lineHeight: 1.55,
}

const physicalSparsePointRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '5px',
  marginTop: '9px',
}

const physicalSparsePointStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: '999px',
  padding: '4px 7px',
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
  fontWeight: 800,
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

const summaryEmptyStyle: CSSProperties = {
  margin: 0,
  color: 'var(--text-muted)',
  fontSize: '11px',
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

function MarketSnapshotCard({
  ticker,
  marginInfo,
  fallbackType,
}: {
  ticker: string
  marginInfo: StockMarginInfo | null
  fallbackType?: string | null
}) {
  return (
    <div className="card" style={marketSnapshotCardStyle}>
      <div style={marketSnapshotGridStyle}>
        <PerformanceCard ticker={ticker} embedded />
        <MarginInfoCard info={marginInfo} fallbackType={fallbackType} embedded />
      </div>
    </div>
  )
}

function MarginInfoCard({
  info,
  fallbackType,
  embedded = false,
}: {
  info: StockMarginInfo | null
  fallbackType?: string | null
  embedded?: boolean
}) {
  const latest = info?.latest
  const latestHistory = info?.history?.[0]
  return (
    <div className={embedded ? '' : 'card'} style={embedded ? marginEmbeddedStyle : { padding: '12px' }}>
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

const marketSnapshotCardStyle: CSSProperties = {
  padding: '12px',
}

const marketSnapshotGridStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
}

const marginEmbeddedStyle: CSSProperties = {
  minWidth: 0,
  borderTop: '1px solid var(--border-subtle)',
  paddingTop: '10px',
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

type BasicMlSimilar = {
  similarDirection: 'up' | 'down' | null
  similarityScore: number
}

type BasicMlResponse = {
  asOfDate?: string | null
  featureAsOfDate?: string | null
  count?: number
  similars?: BasicMlSimilar[]
  physicsAnalysis?: {
    physicsStatus?: string | null
    pullbackVerdict?: string | null
    summary?: string | null
  } | null
}

function BasicInfoCard({ ticker, quote }: { ticker: string; quote: StockQuote | null }) {
  const [latestStage, setLatestStage] = useState<SummaryStageEntry | null>(null)
  const [physical, setPhysical] = useState<PhysicalMomentumResponse | null>(null)
  const [ml, setMl] = useState<BasicMlResponse | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const code = ticker.replace(/\.T$/i, '')
    setSummaryLoading(true)

    Promise.allSettled([
      fetch(`/api/stage-history/${encodeURIComponent(code)}?granularity=daily&count=1`, { cache: 'no-store' }).then((res) => res.ok ? res.json() : null),
      fetch(`/api/physical-momentum/${encodeURIComponent(code)}?market=JP&limit=40`, { cache: 'no-store' }).then((res) => res.ok ? res.json() : null),
      fetch(`/api/ml/current-similars?ticker=${encodeURIComponent(code)}&limit=6`, { cache: 'no-store' }).then((res) => res.ok ? res.json() : null),
    ])
      .then(([stageResult, physicalResult, mlResult]) => {
        if (cancelled) return
        if (stageResult.status === 'fulfilled') {
          const history = Array.isArray(stageResult.value?.history) ? stageResult.value.history : []
          setLatestStage(history[history.length - 1] ?? null)
        } else {
          setLatestStage(null)
        }
        setPhysical(physicalResult.status === 'fulfilled' ? physicalResult.value as PhysicalMomentumResponse | null : null)
        setMl(mlResult.status === 'fulfilled' ? mlResult.value as BasicMlResponse | null : null)
      })
      .finally(() => {
        if (!cancelled) setSummaryLoading(false)
      })

    return () => { cancelled = true }
  }, [ticker])

  const items = [
    { label: '時価総額', value: quote?.marketCap != null ? `${(quote.marketCap / 1e8).toLocaleString('ja-JP', { maximumFractionDigits: 0 })} 億円` : '---' },
    { label: '出来高', value: quote?.volume ? quote.volume.toLocaleString('ja-JP') : '---' },
    { label: '52週高値', value: quote?.fiftyTwoWeekHigh != null ? `¥${quote.fiftyTwoWeekHigh.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}` : '---' },
    { label: '52週安値', value: quote?.fiftyTwoWeekLow != null ? `¥${quote.fiftyTwoWeekLow.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}` : '---' },
  ]
  const decision = buildBasicDecisionSummary(latestStage, physical, ml, quote)

  return (
    <div className="card" style={{ padding: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px', marginBottom: '8px' }}>
        <div style={{ fontSize: '11px', fontWeight: 600 }}>基本情報</div>
        {latestStage?.date && (
          <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            基準日 {latestStage.date}
          </span>
        )}
      </div>
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

      <div style={basicStageBlockStyle}>
        <div style={basicSubHeaderStyle}>
          <strong>6ステージ</strong>
          <span>{summaryLoading ? '読込中' : latestStage ? buildStageCode(latestStage) : '未取得'}</span>
        </div>
        {latestStage ? (
          <div style={basicStageGridStyle}>
            {SUMMARY_STAGE_KEYS.map(({ key, label }) => (
              <SixStageCell key={key} label={label} stage={latestStage[key]} />
            ))}
          </div>
        ) : (
          <p style={basicMutedTextStyle}>{summaryLoading ? '最新ステージを確認しています。' : '最新ステージデータがありません。'}</p>
        )}
      </div>

      <div style={{ ...basicDecisionStyle, borderColor: decision.border, background: decision.background }}>
        <div style={basicDecisionHeaderStyle}>
          <span style={basicDecisionLabelStyle}>短期チェック</span>
          <strong style={{ color: decision.color }}>{decision.label}</strong>
        </div>
        <p style={basicDecisionDescriptionStyle}>{decision.description}</p>
        <div style={basicReasonRowStyle}>
          {decision.reasons.map((reason) => (
            <span key={reason} style={basicReasonPillStyle}>{reason}</span>
          ))}
        </div>
        {decision.mlText && (
          <div style={basicMlLineStyle}>
            <span>ML類似</span>
            <b>{decision.mlText}</b>
          </div>
        )}
      </div>
    </div>
  )
}

function SixStageCell({ label, stage }: { label: string; stage: number | null }) {
  const validStage = normalizeStage(stage)
  const color = validStage ? STAGE_BORDER_COLORS[validStage] : 'var(--border-base)'
  const bg = validStage ? STAGE_BG_COLORS[validStage] : 'var(--bg-elevated)'
  const title = validStage ? STAGE_LABELS[validStage] : '未判定'
  return (
    <div title={`${label}: ${title}`} style={{ ...basicStageCellStyle, borderColor: color, background: bg }}>
      <span style={basicStageCellLabelStyle}>{label}</span>
      <strong style={{ ...basicStageCellNumberStyle, color }}>{validStage ?? '-'}</strong>
      <small style={basicStageCellTextStyle}>{validStage ? shortStageLabel(validStage) : '不足'}</small>
    </div>
  )
}

function buildStageCode(row: SummaryStageEntry | null): string {
  if (!row) return '------'
  return SUMMARY_STAGE_KEYS.map(({ key }) => normalizeStage(row[key]) ?? '-').join('')
}

function normalizeStage(stage: number | null | undefined): number | null {
  if (stage == null || !Number.isFinite(stage)) return null
  const rounded = Math.round(stage)
  return rounded >= 1 && rounded <= 6 ? rounded : null
}

function shortStageLabel(stage: number): string {
  if (stage === 1) return '安定上昇'
  if (stage === 2) return '調整'
  if (stage === 3) return '弱気移行'
  if (stage === 4) return '安定下降'
  if (stage === 5) return '反発兆し'
  return '強気初期'
}

function buildBasicDecisionSummary(
  stage: SummaryStageEntry | null,
  physical: PhysicalMomentumResponse | null,
  ml: BasicMlResponse | null,
  quote: StockQuote | null,
) {
  const latestPhysical = physical?.latest ?? null
  const similars = Array.isArray(ml?.similars) ? ml.similars : []
  const upCount = similars.filter((row) => row.similarDirection === 'up').length
  const downCount = similars.filter((row) => row.similarDirection === 'down').length
  const topSimilarity = similars.reduce((max, row) => Math.max(max, Number(row.similarityScore) || 0), 0)
  const check = buildShortTermCheck({
    stages: stage ? {
      dailyA: stage.daily_a_stage,
      dailyB: stage.daily_b_stage,
      weeklyA: stage.weekly_a_stage,
      weeklyB: stage.weekly_b_stage,
      monthlyA: stage.monthly_a_stage,
      monthlyB: stage.monthly_b_stage,
    } : null,
    physicalMomentumScore: latestPhysical?.physicalMomentumScore,
    physicalForceScore: latestPhysical?.physicalForceScore,
    changePercent: quote?.changePercent,
    mlUpCount: upCount,
    mlDownCount: downCount,
    mlSimilarCount: similars.length,
    mlTopSimilarity: topSimilarity || null,
    physicsStatus: ml?.physicsAnalysis?.physicsStatus ?? null,
  })
  const style = shortTermToneStyle(check.tone)

  return {
    ...check,
    ...style,
  }
}

function shortTermToneStyle(tone: ShortTermCheckTone) {
  if (tone === 'bullish') {
    return { color: 'var(--price-up)', border: 'rgba(22, 163, 74, 0.32)', background: 'rgba(22, 163, 74, 0.07)' }
  }
  if (tone === 'positive') {
    return { color: '#0f766e', border: 'rgba(20, 184, 166, 0.3)', background: 'rgba(20, 184, 166, 0.07)' }
  }
  if (tone === 'bearish') {
    return { color: 'var(--price-down)', border: 'rgba(37, 99, 235, 0.3)', background: 'rgba(37, 99, 235, 0.07)' }
  }
  if (tone === 'weak') {
    return { color: '#1d4ed8', border: 'rgba(37, 99, 235, 0.24)', background: 'rgba(37, 99, 235, 0.06)' }
  }
  return { color: 'var(--text-secondary)', border: 'var(--border-subtle)', background: 'var(--bg-elevated)' }
}

const basicStageBlockStyle: CSSProperties = {
  marginTop: '10px',
  paddingTop: '10px',
  borderTop: '1px solid var(--border-subtle)',
}

const basicSubHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '8px',
  marginBottom: '6px',
  color: 'var(--text-primary)',
  fontSize: '11px',
}

const basicStageGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
  gap: '4px',
}

const basicStageCellStyle: CSSProperties = {
  minWidth: 0,
  border: '1px solid var(--border-subtle)',
  borderRadius: '6px',
  padding: '5px 3px',
  display: 'grid',
  justifyItems: 'center',
  gap: '1px',
}

const basicStageCellLabelStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: '9px',
  fontWeight: 800,
  lineHeight: 1,
}

const basicStageCellNumberStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '16px',
  lineHeight: 1.05,
}

const basicStageCellTextStyle: CSSProperties = {
  maxWidth: '100%',
  color: 'var(--text-secondary)',
  fontSize: '8px',
  fontWeight: 700,
  lineHeight: 1.1,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const basicMutedTextStyle: CSSProperties = {
  margin: 0,
  color: 'var(--text-muted)',
  fontSize: '10px',
  lineHeight: 1.5,
}

const basicDecisionStyle: CSSProperties = {
  marginTop: '10px',
  border: '1px solid var(--border-subtle)',
  borderRadius: '8px',
  padding: '9px',
}

const basicDecisionHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '8px',
}

const basicDecisionLabelStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: '10px',
  fontWeight: 800,
}

const basicDecisionDescriptionStyle: CSSProperties = {
  margin: '6px 0 0',
  color: 'var(--text-secondary)',
  fontSize: '10px',
  lineHeight: 1.55,
  fontWeight: 650,
}

const basicReasonRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '4px',
  marginTop: '7px',
}

const basicReasonPillStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: '999px',
  background: '#fff',
  color: 'var(--text-secondary)',
  padding: '2px 6px',
  fontSize: '9px',
  fontWeight: 800,
}

const basicMlLineStyle: CSSProperties = {
  marginTop: '7px',
  display: 'flex',
  justifyContent: 'space-between',
  gap: '8px',
  borderTop: '1px solid var(--border-subtle)',
  paddingTop: '6px',
  color: 'var(--text-muted)',
  fontSize: '10px',
}
