'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Card, CardHeader } from '@/components/ui/Card'

type Direction = 'up' | 'down' | 'wait'

type Candidate = {
  asOfDate: string
  direction: Direction
  horizonDays: number
  rank: number
  ticker: string
  name: string | null
  sector: string | null
  candidateScore: number
  modelName: string | null
  close: number | null
  stageCode: string | null
  maOrder: string | null
  confidenceLabel: string | null
  summary: string | null
  reasonHighlights: string[]
}

type CandidatesResponse = {
  ok: boolean
  available: boolean
  asOfDate?: string | null
  requestedDate?: string | null
  latestFeatureDate?: string | null
  stale?: boolean
  horizonDays: number
  direction: Direction
  totalCandidates?: number
  candidates: Candidate[]
  currentCandidate: Candidate | null
  notice?: string | null
  error?: string
}

const HORIZONS = [5, 10, 20, 40, 60, 90, 200] as const
const LIMITS = [20, 50, 120] as const
const DIRECTIONS: { value: Direction; label: string }[] = [
  { value: 'up', label: '上昇候補' },
  { value: 'down', label: '下落警戒' },
  { value: 'wait', label: '待機候補' },
]

function scoreText(value: number): string {
  return Number.isFinite(value) ? (value * 100).toFixed(1) : '-'
}

function priceText(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

function directionTone(direction: Direction): string {
  if (direction === 'up') return 'text-[var(--color-price-up)]'
  if (direction === 'down') return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-text-secondary)]'
}

function selectedButton(selected: boolean): string {
  return selected
    ? 'border-[var(--color-brand-800)] bg-[var(--color-brand-800)] text-white'
    : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)] hover:border-[var(--color-brand-500)] hover:text-[var(--color-brand-900)]'
}

export function UsPhysicalMlRanking({
  ticker,
  analysisDate,
}: {
  ticker: string
  analysisDate: string | null
}) {
  const [horizon, setHorizon] = useState<number>(20)
  const [direction, setDirection] = useState<Direction>('up')
  const [limit, setLimit] = useState<number>(20)
  const [data, setData] = useState<CandidatesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    const params = new URLSearchParams({
      ticker,
      horizon: String(horizon),
      direction,
      limit: String(limit),
    })
    if (analysisDate) params.set('date', analysisDate)

    fetch(`/api/us/ml-physics-candidates?${params.toString()}`, { cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json() as CandidatesResponse
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || `HTTP ${response.status}`)
        }
        return payload
      })
      .then((payload) => {
        if (!cancelled) setData(payload)
      })
      .catch((reason) => {
        if (!cancelled) {
          setData(null)
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [analysisDate, direction, horizon, limit, ticker])

  const current = data?.currentCandidate ?? null
  const total = data?.totalCandidates ?? 0

  return (
    <Card size="lg">
      <CardHeader
        title="US物理ML候補ランキング"
        hint="SMAの並び・速度・加速度・乖離と上位足構造を統合した市場内ランキング"
        action={data?.asOfDate ? `${data.asOfDate}時点` : undefined}
      />

      <div className="grid gap-3 border-b border-[var(--color-border-soft)] pb-4 lg:grid-cols-[1fr_auto_auto] lg:items-end">
        <fieldset>
          <legend className="mb-1.5 text-[10px] font-black text-[var(--color-text-tertiary)]">予測期間</legend>
          <div className="flex max-w-full gap-1 overflow-x-auto pb-1">
            {HORIZONS.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={horizon === value}
                onClick={() => setHorizon(value)}
                className={`h-8 shrink-0 rounded-[4px] border px-2.5 text-[10px] font-black ${selectedButton(horizon === value)}`}
              >
                {value}日
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-1.5 text-[10px] font-black text-[var(--color-text-tertiary)]">候補方向</legend>
          <div className="flex gap-1">
            {DIRECTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={direction === option.value}
                onClick={() => setDirection(option.value)}
                className={`h-8 rounded-[4px] border px-2.5 text-[10px] font-black ${selectedButton(direction === option.value)}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="block">
          <span className="mb-1.5 block text-[10px] font-black text-[var(--color-text-tertiary)]">表示件数</span>
          <select
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
            className="h-8 min-w-24 rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-black text-[var(--color-text-primary)]"
          >
            {LIMITS.map((value) => (
              <option key={value} value={value}>上位{value}件</option>
            ))}
          </select>
        </label>
      </div>

      <div className="py-4" aria-live="polite">
        {loading ? (
          <div className="border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-4 text-[12px] font-bold text-[var(--color-text-tertiary)]">
            US物理ML候補を読み込み中...
          </div>
        ) : error ? (
          <div className="border border-red-200 bg-red-50 p-4 text-[12px] font-bold text-red-800">
            ランキング取得エラー: {error}
          </div>
        ) : !data?.available ? (
          <div className="border border-blue-200 bg-blue-50 p-4 text-[12px] font-bold text-blue-900">
            {data?.notice ?? 'US物理ML候補ランキングを利用できません。'}
          </div>
        ) : (
          <>
            <div className="mb-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
              <div className={`border-l-4 px-3 py-2 ${
                current
                  ? 'border-[var(--color-market-red)] bg-red-50'
                  : 'border-[var(--color-border-strong)] bg-[var(--color-surface-subtle)]'
              }`}>
                <div className="text-[10px] font-black text-[var(--color-text-tertiary)]">
                  {ticker}の現在位置
                </div>
                <div className="mt-1 text-[14px] font-black text-[var(--color-text-primary)]">
                  {current
                    ? `${horizon}営業日・${DIRECTIONS.find((item) => item.value === direction)?.label}で第${current.rank}位`
                    : `${horizon}営業日・${DIRECTIONS.find((item) => item.value === direction)?.label}の上位${total}件外`}
                </div>
                <p className="mt-1 text-[11px] font-bold leading-5 text-[var(--color-text-secondary)]">
                  {current
                    ? `候補スコア ${scoreText(current.candidateScore)} / ${current.confidenceLabel ?? '信頼度は要確認'}`
                    : '候補外でも、特徴量・PMS・本質類似局面の分析は引き続き利用できます。'}
                </p>
              </div>
              <div className="text-left text-[10px] font-bold leading-5 text-[var(--color-text-tertiary)] md:text-right">
                <div>候補数 {total.toLocaleString('en-US')}件</div>
                <div>特徴量 {data.latestFeatureDate ?? '-'}</div>
              </div>
            </div>

            {data.notice && (
              <div className="mb-4 border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-900">
                {data.notice}
              </div>
            )}

            {data.candidates.length === 0 ? (
              <div className="border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-4 text-[12px] font-bold text-[var(--color-text-secondary)]">
                {data.notice ?? '指定条件の候補はありません。'}
              </div>
            ) : (
              <div className="overflow-x-auto border border-[var(--color-border-default)]">
                <table className="data-table w-full min-w-[1080px] border-collapse text-left text-[11px]">
                  <thead>
                    <tr>
                      <th className="w-16 border-r border-[var(--color-border-soft)] px-3 py-2">順位</th>
                      <th className="min-w-44 border-r border-[var(--color-border-soft)] px-3 py-2">銘柄</th>
                      <th className="w-28 whitespace-nowrap border-r border-[var(--color-border-soft)] px-3 py-2 text-right">候補スコア</th>
                      <th className="w-24 whitespace-nowrap border-r border-[var(--color-border-soft)] px-3 py-2">終値</th>
                      <th className="w-24 whitespace-nowrap border-r border-[var(--color-border-soft)] px-3 py-2">ステージ</th>
                      <th className="min-w-36 border-r border-[var(--color-border-soft)] px-3 py-2">セクター</th>
                      <th className="min-w-[360px] px-3 py-2">判定要旨</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.candidates.map((candidate) => {
                      const isCurrent = candidate.ticker === ticker
                      return (
                        <tr key={`${candidate.direction}-${candidate.horizonDays}-${candidate.ticker}`} className={isCurrent ? 'bg-amber-50' : undefined}>
                          <td className="border-r border-t border-[var(--color-border-soft)] px-3 py-2 font-black">#{candidate.rank}</td>
                          <td className="border-r border-t border-[var(--color-border-soft)] px-3 py-2">
                            <Link
                              href={`/us/stock/${encodeURIComponent(candidate.ticker)}`}
                              className="font-black text-[var(--color-brand-800)] hover:underline"
                            >
                              {candidate.ticker}
                            </Link>
                            {candidate.name && (
                              <div className="mt-0.5 max-w-52 truncate text-[10px] font-bold text-[var(--color-text-tertiary)]" title={candidate.name}>
                                {candidate.name}
                              </div>
                            )}
                          </td>
                          <td className={`whitespace-nowrap border-r border-t border-[var(--color-border-soft)] px-3 py-2 text-right text-[13px] font-black ${directionTone(candidate.direction)}`}>
                            {scoreText(candidate.candidateScore)}
                          </td>
                          <td className="whitespace-nowrap border-r border-t border-[var(--color-border-soft)] px-3 py-2 font-bold">{priceText(candidate.close)}</td>
                          <td className="whitespace-nowrap border-r border-t border-[var(--color-border-soft)] px-3 py-2 font-black">{candidate.stageCode ?? '-'}</td>
                          <td className="border-r border-t border-[var(--color-border-soft)] px-3 py-2 font-bold text-[var(--color-text-secondary)]">{candidate.sector ?? '-'}</td>
                          <td className="border-t border-[var(--color-border-soft)] px-3 py-2">
                            <div className="font-bold leading-5 text-[var(--color-text-primary)]">
                              {candidate.summary ?? candidate.reasonHighlights[0] ?? '判定要旨なし'}
                            </div>
                            <div className="mt-1 line-clamp-1 text-[10px] font-bold text-[var(--color-text-tertiary)]" title={candidate.maOrder ?? undefined}>
                              {candidate.maOrder ? `MA: ${candidate.maOrder}` : candidate.reasonHighlights[1] ?? ''}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      <p className="border-t border-[var(--color-border-soft)] pt-3 text-[10px] font-bold leading-5 text-[var(--color-text-tertiary)]">
        候補スコアは方向別の相対順位です。売買指示ではなく、決算・流動性・材料・指数環境を合わせて確認してください。
      </p>
    </Card>
  )
}
