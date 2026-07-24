'use client'

import { useEffect, useState } from 'react'
import { BacktestHighlightChart, type HighlightChartPoint } from '@/components/charts/BacktestHighlightChart'

type Move = {
  direction: 'up' | 'down'
  rank: number
  startDate: string
  endDate: string
  startPrice: number | null
  endPrice: number | null
  returnPct: number | null
  tradingDays: number | null
  stagePath: Array<{ date: string; code: string }>
  chartSeries: HighlightChartPoint[]
  volumeSummary: {
    comment: string
    firstPhaseRatio?: number | null
    periodRatio?: number | null
    preAverage?: number | null
    startVolume?: number | null
    endVolume?: number | null
    periodAverage: number | null
    maxVolume: number | null
    maxVolumeDate: string | null
  } | null
}

type MoveTone = 'up' | 'down' | 'warning' | 'neutral'

type MoveProfile = {
  typeLabel: string
  typeTone: MoveTone
  rarityLabel: string
  rarityTone: MoveTone
  volumeLabel: string
  volumeTone: MoveTone
  stageLabel: string
  stageTone: MoveTone
  headline: string
  insight: string
  comparePoint: string
}

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function fmtPrice(value: number | null | undefined, currency: 'JPY' | 'USD'): string {
  if (value == null || !Number.isFinite(value)) return '-'
  if (currency === 'USD') {
    return `$${value.toLocaleString('en-US', { maximumFractionDigits: value >= 100 ? 1 : 2 })}`
  }
  return Math.round(value).toLocaleString('ja-JP')
}

function stagePathText(path: Array<{ date: string; code: string }>): string {
  if (path.length === 0) return '-'
  return path.map((item) => item.code).join(' → ')
}

function movePace(move: Move): number | null {
  if (move.returnPct == null || move.tradingDays == null || move.tradingDays <= 0) return null
  return Math.abs(move.returnPct) / move.tradingDays
}

function volumeProfile(move: Move): Pick<MoveProfile, 'volumeLabel' | 'volumeTone'> {
  const firstRatio = move.volumeSummary?.firstPhaseRatio ?? null
  const periodRatio = move.volumeSummary?.periodRatio ?? null
  if ((firstRatio ?? 0) >= 1.5) {
    return { volumeLabel: `初動出来高 ${firstRatio?.toFixed(1)}倍`, volumeTone: 'up' }
  }
  if ((periodRatio ?? 0) >= 1.25) {
    return { volumeLabel: `商い継続 ${periodRatio?.toFixed(1)}倍`, volumeTone: 'warning' }
  }
  if (periodRatio != null && periodRatio <= 0.75) {
    return { volumeLabel: `薄商い ${periodRatio.toFixed(1)}倍`, volumeTone: 'neutral' }
  }
  return { volumeLabel: '出来高は標準的', volumeTone: 'neutral' }
}

function stageProfile(move: Move): Pick<MoveProfile, 'stageLabel' | 'stageTone'> {
  const changes = Math.max(0, move.stagePath.length - 1)
  const first = move.stagePath[0]?.code
  const last = move.stagePath[move.stagePath.length - 1]?.code
  if (!first || !last) return { stageLabel: 'ステージ情報少なめ', stageTone: 'neutral' }
  if (changes >= 4) return { stageLabel: `多段階に変化 ${changes}回`, stageTone: 'warning' }
  if (move.direction === 'up') return { stageLabel: `改善局面 ${first}→${last}`, stageTone: 'up' }
  return { stageLabel: `悪化局面 ${first}→${last}`, stageTone: 'down' }
}

function moveProfile(move: Move): MoveProfile {
  const absReturn = Math.abs(move.returnPct ?? 0)
  const pace = movePace(move)
  const volume = volumeProfile(move)
  const stage = stageProfile(move)
  const isUp = move.direction === 'up'
  const directionNoun = isUp ? '上昇' : '下落'
  const oppositeNoun = isUp ? '失速' : '反発'

  let typeLabel = isUp ? 'じわ上げ型' : '弱含み継続型'
  let typeTone: MoveTone = isUp ? 'up' : 'down'
  if (pace != null && pace >= (isUp ? 1.8 : 1.4)) {
    typeLabel = isUp ? '急伸型' : '急落型'
    typeTone = isUp ? 'up' : 'down'
  } else if (volume.volumeTone === 'up') {
    typeLabel = isUp ? '出来高初動型' : '出来高崩れ型'
    typeTone = isUp ? 'up' : 'down'
  } else if (stage.stageTone === 'warning') {
    typeLabel = isUp ? '揉み合い上放れ型' : '段階的崩れ型'
    typeTone = 'warning'
  }

  let rarityLabel = '標準的な大局面'
  let rarityTone: MoveTone = 'neutral'
  if (absReturn >= 55 || (pace ?? 0) >= 2.2) {
    rarityLabel = 'かなり目立つ局面'
    rarityTone = 'warning'
  } else if (absReturn >= 30 || (pace ?? 0) >= 1.1) {
    rarityLabel = 'メジャーな局面'
    rarityTone = isUp ? 'up' : 'down'
  }

  const paceText = pace == null ? '' : `、1営業日あたり約${pace.toFixed(1)}%`
  const headline = `この銘柄内の${directionNoun}局面 #${move.rank}。${rarityLabel}${paceText}の動きです。`
  const insight = isUp
    ? `同じような上がり方を探すなら、ステージ改善と出来高の伴い方が再現しているかを見ます。上昇後は${oppositeNoun}の初期サインも比較対象です。`
    : `同じような下がり方を探すなら、ステージ悪化、短期線の下向き、出来高を伴う売りが重なっているかを見ます。戻り局面では${oppositeNoun}の強さが分岐点です。`
  const comparePoint = isUp
    ? '現在のチャートがこの局面に近いなら、上放れ後の継続性と過熱反転を同時に確認。'
    : '現在のチャートがこの局面に近いなら、戻り売り優勢か、下落加速の入口かを確認。'

  return {
    typeLabel,
    typeTone,
    rarityLabel,
    rarityTone,
    ...volume,
    ...stage,
    headline,
    insight,
    comparePoint,
  }
}

export function StockMovePeriods({
  ticker,
  market = 'JP',
  analysisDate = null,
}: {
  ticker: string
  market?: 'JP' | 'US'
  analysisDate?: string | null
}) {
  const [moves, setMoves] = useState<Move[]>([])
  const [openKey, setOpenKey] = useState('')
  const [loading, setLoading] = useState(true)
  const currency = market === 'US' ? 'USD' : 'JPY'

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const params = new URLSearchParams({ limit: '8', market })
    if (analysisDate) params.set('date', analysisDate)
    fetch(`/api/stock-move-periods/${encodeURIComponent(ticker)}?${params.toString()}`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        setMoves(Array.isArray(data.moves) ? data.moves : [])
      })
      .catch(() => { if (!cancelled) setMoves([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [analysisDate, ticker, market])

  if (loading) {
    return <div className="card stock-move-card">過去の上昇・下落局面を読込中...</div>
  }
  if (moves.length === 0) return null

  return (
    <div className="card stock-move-card">
      <div className="stock-move-head">
        <div>
          <h2>過去の上昇・下落局面</h2>
          <p>大きく動いた期間を、4本の移動平均線と6桁ステージ遷移で確認します。</p>
        </div>
      </div>
      <div className="stock-move-list">
        {moves.map((move) => {
          const key = `${move.direction}-${move.rank}`
          const isOpen = openKey === key
          const profile = moveProfile(move)
          return (
            <div className="stock-move-item" key={key}>
              <button type="button" onClick={() => setOpenKey(isOpen ? '' : key)} data-direction={move.direction}>
                <span data-direction={move.direction}>{move.direction === 'up' ? '上昇' : '下落'}</span>
                <strong>{move.startDate}〜{move.endDate}</strong>
                <em data-tone={profile.typeTone}>{profile.typeLabel}</em>
                <b className={move.direction === 'up' ? 'price-up' : 'price-down'}>{fmtPct(move.returnPct)}</b>
                <small>{move.tradingDays ?? '-'}営業日</small>
              </button>
              {isOpen && (
                <div className="stock-move-detail">
                  <div className="stock-move-summary" data-direction={move.direction}>
                    <strong>{profile.headline}</strong>
                    <p>{profile.insight}</p>
                  </div>
                  <div className="stock-move-signal-grid">
                    <div data-tone={profile.typeTone}>
                      <span>局面タイプ</span>
                      <strong>{profile.typeLabel}</strong>
                      <small>{move.direction === 'up' ? '買いが続いた形' : '売りが続いた形'}</small>
                    </div>
                    <div data-tone={profile.rarityTone}>
                      <span>よくある動きか</span>
                      <strong>{profile.rarityLabel}</strong>
                      <small>同銘柄の大局面 #{move.rank}</small>
                    </div>
                    <div data-tone={profile.volumeTone}>
                      <span>商いの裏付け</span>
                      <strong>{profile.volumeLabel}</strong>
                      <small>{move.volumeSummary?.maxVolumeDate ? `最大 ${move.volumeSummary.maxVolumeDate}` : '期間平均との差'}</small>
                    </div>
                    <div data-tone={profile.stageTone}>
                      <span>ステージの流れ</span>
                      <strong>{profile.stageLabel}</strong>
                      <small>形状比較の主材料</small>
                    </div>
                  </div>
                  <p className="stock-move-note">
                    {move.startDate}から{move.endDate}までに、株価が{fmtPct(move.returnPct)}動きました。
                    開始価格は{fmtPrice(move.startPrice, currency)}、終了価格は{fmtPrice(move.endPrice, currency)}です。
                    {profile.comparePoint}
                  </p>
                  <dl>
                    <div><dt>ステージ遷移</dt><dd>{stagePathText(move.stagePath)}</dd></div>
                    <div><dt>チャート表示</dt><dd>5日・25日・75日・200日MAと対象期間を重ねて表示します。</dd></div>
                    <div><dt>参考出来高</dt><dd>{move.volumeSummary?.comment ?? '-'}</dd></div>
                  </dl>
                  <BacktestHighlightChart
                    series={move.chartSeries}
                    highlightStart={move.startDate}
                    highlightEnd={move.endDate}
                    direction={move.direction}
                    stagePath={move.stagePath}
                    startPrice={move.startPrice}
                    endPrice={move.endPrice}
                    returnPct={move.returnPct}
                    currency={currency}
                    height={240}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
