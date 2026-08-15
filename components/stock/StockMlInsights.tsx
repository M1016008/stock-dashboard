'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { StageTag } from '@/components/ui/StageTag'
import { BacktestHighlightChart, type HighlightChartPoint, type StageMarkerPoint } from '@/components/charts/BacktestHighlightChart'
import { MlReliabilityStrip } from '@/components/ml/MlReliabilityStrip'
import { assessMlReliability } from '@/lib/ml/reliability'
import type { PhysicsAnalysis, PhysicsStatus } from '@/lib/ml/physics-analysis'

type SimilarInsight = {
  rank: number
  similarTicker: string
  similarityScore: number
  similarDirection: 'up' | 'down' | null
  payload: {
    similar?: {
      name?: string | null
      stageCode?: string | null
      maOrder?: string | null
      sector17Name?: string | null
      sector33Name?: string | null
    }
  }
  reason: Record<string, string>
}

type CaseStudy = {
  rank: number
  ticker: string
  name: string | null
  caseDate: string
  similarityScore: number
  stageCode: string | null
  maOrder: string | null
  sector17Name: string | null
  sector33Name: string | null
  pattern: string
  physicsStatus?: PhysicsStatus
  pullbackVerdict?: string
  stagePath: string[]
  summary: string
  maComment: string
  hint: string
  returns: {
    week1: number | null
    week2: number | null
    week3: number | null
    maxWeek3: number | null
    minWeek3: number | null
  }
  chart?: {
    series: HighlightChartPoint[]
    highlightStart: string
    highlightEnd: string | null
    direction: 'up' | 'down'
    startPrice: number | null
    endPrice: number | null
    returnPct: number | null
    stagePath: StageMarkerPoint[]
  }
  evolution: Array<{
    afterDays: number
    date: string
    close: number | null
    stageCode: string | null
    maOrder: string | null
    sma5Velocity5: number | null
    sma25Velocity5: number | null
    sma75Velocity5: number | null
    gap5To25Pct: number | null
    gap25To75Pct: number | null
    trend: string | null
  }>
}

type ApiResponse = {
  asOfDate: string | null
  featureAsOfDate: string | null
  source: string | null
  physicsAnalysis: PhysicsAnalysis | null
  similars: SimilarInsight[]
  caseStudies: CaseStudy[]
  predictions: Array<{
    asOfDate: string
    horizonDays: number
    direction: 'up' | 'down'
    rank: number
    score: number
    modelName: string | null
    outcome: {
      returnPct: number | null
      maxReturnPct: number | null
      minReturnPct: number | null
      hitLabel: boolean
    } | null
  }>
}

type MlBackendStatus = {
  modelDate?: string | null
  evaluationDate?: string | null
  validationRuns?: number | null
  validationSamples?: number | null
  healthIssueCount?: number | null
  items?: Array<{
    key?: string
    status?: string
    date?: string | null
    count?: number | null
    evidence?: string[]
  }>
}

function usValidationSamples(status: MlBackendStatus | null) {
  const evaluation = status?.items?.find((item) => item.key === 'evaluation')
  const sampleLine = evaluation?.evidence?.find((line) => /^sample\s/i.test(line))
  if (!sampleLine) return null
  const value = Number(sampleLine.replace(/[^0-9]/g, ''))
  return Number.isFinite(value) ? value : null
}

function backendReliability(status: MlBackendStatus | null, market: 'JP' | 'US') {
  if (market === 'US') {
    const model = status?.items?.find((item) => item.key === 'models')
    const evaluation = status?.items?.find((item) => item.key === 'evaluation')
    return {
      modelDate: model?.date ?? null,
      evaluationDate: evaluation?.date ?? null,
      validationRuns: evaluation?.count ?? null,
      validationSamples: usValidationSamples(status),
      healthIssueCount: status?.items?.filter((item) => item.status === 'warn' || item.status === 'missing').length ?? 0,
    }
  }

  return {
    modelDate: status?.modelDate ?? null,
    evaluationDate: status?.evaluationDate ?? null,
    validationRuns: status?.validationRuns ?? null,
    validationSamples: status?.validationSamples ?? null,
    healthIssueCount: status?.healthIssueCount ?? 0,
  }
}

async function requiredJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`)
  return response.json() as Promise<T>
}

async function optionalJson<T>(url: string): Promise<T | null> {
  try {
    return await requiredJson<T>(url)
  } catch {
    return null
  }
}

function fmtPct(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function fmtPrice(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-'
  return Math.round(value).toLocaleString('ja-JP')
}

function stageTags(code: string | null | undefined) {
  if (!code) return <span style={{ color: 'var(--text-muted)' }}>------</span>
  return (
    <span style={{ display: 'inline-flex', gap: 2, verticalAlign: 'middle' }}>
      {code.split('').slice(0, 6).map((char, index) => {
        const stage = Number(char)
        return Number.isFinite(stage) && stage >= 1 && stage <= 6
          ? <StageTag key={`${char}-${index}`} stage={stage} size="xs" />
          : (
            <span
              key={`${char}-${index}`}
              style={{
                display: 'inline-grid',
                placeItems: 'center',
                width: 16,
                height: 16,
                borderRadius: 999,
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-muted)',
                background: 'white',
                fontSize: 10,
                fontWeight: 900,
              }}
            >
              -
            </span>
          )
      })}
    </span>
  )
}

function similarityBand(score: number) {
  if (score >= 0.9) {
    return {
      label: '強い類似',
      description: '90%以上',
      border: 'rgba(20, 184, 166, 0.34)',
      background: 'rgba(20, 184, 166, 0.08)',
      color: '#0f766e',
    }
  }
  if (score >= 0.8) {
    return {
      label: '参考類似',
      description: '80〜90%',
      border: 'rgba(37, 99, 235, 0.24)',
      background: 'rgba(37, 99, 235, 0.07)',
      color: '#1d4ed8',
    }
  }
  return {
    label: '低確信の近似',
    description: '55〜80%',
    border: 'rgba(245, 158, 11, 0.3)',
    background: 'rgba(245, 158, 11, 0.08)',
    color: '#b45309',
  }
}

const SIMILAR_REASON_ORDER = [
  'stage',
  'maAngle',
  'maAcceleration',
  'maDistance',
  'maDistanceFlow',
  'upperTimeframe',
  'pricePosition',
  'context',
  'risk',
] as const

type SimilarReasonKey = typeof SIMILAR_REASON_ORDER[number]
type SimilarReasonSection = {
  key: SimilarReasonKey
  meta: { title: string; color: string; background: string; border: string }
  bullets: string[]
}

const SIMILAR_REASON_META: Record<string, { title: string; color: string; background: string; border: string }> = {
  stage: {
    title: '形の一致',
    color: '#0f766e',
    background: 'rgba(20, 184, 166, 0.08)',
    border: 'rgba(20, 184, 166, 0.34)',
  },
  maAngle: {
    title: '短期の勢い',
    color: '#b45309',
    background: 'rgba(245, 158, 11, 0.1)',
    border: 'rgba(245, 158, 11, 0.34)',
  },
  maAcceleration: {
    title: '急変度',
    color: '#b45309',
    background: 'rgba(245, 158, 11, 0.1)',
    border: 'rgba(245, 158, 11, 0.34)',
  },
  maDistance: {
    title: 'MA間距離',
    color: '#7c3aed',
    background: 'rgba(124, 58, 237, 0.08)',
    border: 'rgba(124, 58, 237, 0.3)',
  },
  maDistanceFlow: {
    title: '距離変化',
    color: '#7c3aed',
    background: 'rgba(124, 58, 237, 0.08)',
    border: 'rgba(124, 58, 237, 0.3)',
  },
  upperTimeframe: {
    title: '週足・月足',
    color: '#1d4ed8',
    background: 'rgba(37, 99, 235, 0.08)',
    border: 'rgba(37, 99, 235, 0.3)',
  },
  pricePosition: {
    title: '価格位置',
    color: '#475569',
    background: 'rgba(100, 116, 139, 0.08)',
    border: 'rgba(100, 116, 139, 0.26)',
  },
  context: {
    title: '地合い',
    color: '#15803d',
    background: 'rgba(22, 163, 74, 0.07)',
    border: 'rgba(22, 163, 74, 0.28)',
  },
  risk: {
    title: '総合・注意点',
    color: '#be123c',
    background: 'rgba(225, 29, 72, 0.07)',
    border: 'rgba(225, 29, 72, 0.3)',
  },
}

function stripSentenceEnd(text: string) {
  return text
    .replace(/です。/g, '。')
    .replace(/です$/g, '')
    .replace(/しています。/g, '。')
    .replace(/します。/g, '。')
    .trim()
}

function compactReasonBullets(key: string, text: string) {
  const value = stripSentenceEnd(text)

  if (key === 'stage') {
    const match = value.match(/6桁ステージは\s*(.+?)\s*と\s*(.+?)\s*で、6軸の一致度は約(.+?)%。?/)
    if (match) return [`基準 ${match[1]} / 候補 ${match[2]}`, `6軸一致度 約${match[3]}%`]
  }

  if (key === 'maAngle') {
    const match = value.match(/5日SMA速度は基準(?:銘柄)?が(.+?)、候補(?:銘柄)?が(.+?)(?:。|$)/)
    if (match) return [`5日SMA速度: 基準 ${match[1]}`, `候補 ${match[2]}`]
  }

  if (key === 'maAcceleration') {
    const match = value.match(/短期SMAの急変は、5日SMA加速度が基準(.+?)、候補(.+?)(?:。|$)/)
    if (match) return [`5日SMA加速度: 基準 ${match[1]}`, `候補 ${match[2]}`]
  }

  if (key === 'maDistance') {
    const match = value.match(/5-25距離は基準(.+?)・候補(.+?)、25-75距離は基準(.+?)・候補(.+?)(?:。|$)/)
    if (match) return [`5-25距離: 基準 ${match[1]} / 候補 ${match[2]}`, `25-75距離: 基準 ${match[3]} / 候補 ${match[4]}`]
  }

  if (key === 'maDistanceFlow') {
    const match = value.match(/距離変化は5-25の5日変化が基準(.+?)、候補(.+?)(?:。|$)/)
    if (match) return [`5-25距離の5日変化: 基準 ${match[1]}`, `候補 ${match[2]}`]
  }

  if (key === 'upperTimeframe') {
    const match = value.match(/週足はMA順が基準「(.+?)」・候補「(.+?)」、月足は基準「(.+?)」・候補「(.+?)」(?:。|$)/)
    if (match) {
      return [
        `週足MA順: 基準「${match[1]}」 / 候補「${match[2]}」`,
        `月足MA順: 基準「${match[3]}」 / 候補「${match[4]}」`,
        '週足/月足の速度・距離・価格位置も反映',
      ]
    }
  }

  if (key === 'pricePosition') {
    const match = value.match(/株価位置は5日SMA比が基準(.+?)・候補(.+?)、25日SMA比が基準(.+?)・候補(.+?)(?:。|$)/)
    if (match) return [`5日SMA比: 基準 ${match[1]} / 候補 ${match[2]}`, `25日SMA比: 基準 ${match[3]} / 候補 ${match[4]}`]
  }

  if (key === 'context') {
    const match = value.match(/地合いは市場25日SMA上銘柄比率が基準(.+?)・候補(.+?)、17業種5日騰落が基準(.+?)・候補(.+?)(?:。|$)/)
    if (match) return [`市場25日SMA上比率: 基準 ${match[1]} / 候補 ${match[2]}`, `17業種5日騰落: 基準 ${match[3]} / 候補 ${match[4]}`]
  }

  if (key === 'risk') {
    const match = value.match(/類似度は(.+?)に、(.+?)を重ねて(.+?)%。?失敗条件は(.+?)(?:。|$)/)
    if (match) return [`類似度 ${match[3]}%: ${match[1]} + ${match[2]}`, `失敗条件: ${match[4]}`]
  }

  return value
    .split('。')
    .map((part) => part.trim())
    .filter(Boolean)
}

function similarReasonSections(reason: Record<string, string>) {
  const sections: SimilarReasonSection[] = []
  for (const key of SIMILAR_REASON_ORDER) {
    const text = reason[key]
    if (!text) continue
    sections.push({
      key,
      meta: SIMILAR_REASON_META[key],
      bullets: compactReasonBullets(key, text),
    })
  }
  return sections
}

function trendLabel(value: string | null | undefined) {
  switch (value) {
    case 'up_acceleration': return '上向き加速'
    case 'up_deceleration': return '上向き鈍化'
    case 'down_acceleration': return '下向き加速'
    case 'down_deceleration': return '下向き鈍化'
    case 'sideways': return '横ばい'
    default: return '-'
  }
}

function statusColor(status: string | null | undefined) {
  if (status === '上昇加速' || status === '上昇継続' || status === '押し目形成' || status === '反発準備') return 'rgba(220, 38, 38, 0.08)'
  if (status === '下落加速' || status === '失速警戒') return 'rgba(37, 99, 235, 0.08)'
  if (status === '過熱注意') return 'rgba(245, 158, 11, 0.12)'
  return 'var(--surface-muted)'
}

function mlReadingTone(direction: 'up' | 'down' | 'mixed' | 'neutral' | 'none') {
  if (direction === 'up') return { color: 'var(--price-up)', border: 'rgba(22, 163, 74, 0.3)', background: 'rgba(22, 163, 74, 0.06)' }
  if (direction === 'down') return { color: 'var(--price-down)', border: 'rgba(37, 99, 235, 0.3)', background: 'rgba(37, 99, 235, 0.06)' }
  if (direction === 'mixed') return { color: '#b45309', border: 'rgba(245, 158, 11, 0.32)', background: 'rgba(245, 158, 11, 0.08)' }
  if (direction === 'neutral') return { color: '#64748b', border: 'rgba(100, 116, 139, 0.28)', background: 'rgba(100, 116, 139, 0.07)' }
  return { color: 'var(--text-secondary)', border: 'var(--border-subtle)', background: 'var(--surface-muted)' }
}

function buildMlReading(rows: SimilarInsight[], analysis: PhysicsAnalysis | null) {
  const strong = rows.filter((row) => row.similarityScore >= 0.9).length
  const reference = rows.filter((row) => row.similarityScore >= 0.8 && row.similarityScore < 0.9).length
  const weak = rows.filter((row) => row.similarityScore < 0.8).length
  const up = rows.filter((row) => row.similarDirection === 'up').length
  const down = rows.filter((row) => row.similarDirection === 'down').length
  const direction =
    rows.length === 0 ? 'none' :
    up + down === 0 ? 'neutral' :
    up > down ? 'up' :
    down > up ? 'down' :
    'mixed'
  const tone = mlReadingTone(direction)
  const label =
    direction === 'up' ? '類似形状は上方向寄り' :
    direction === 'down' ? '類似形状は下方向寄り' :
    direction === 'mixed' ? '類似形状は強弱混在' :
    direction === 'neutral' ? '近い形状はあるが方向は未確定' :
    '類似形状は未検出'
  const agreement =
    !analysis ? '物理ステータス未取得' :
    direction === 'up' && ['上昇加速', '上昇継続', '押し目形成', '反発準備'].includes(analysis.physicsStatus) ? '物理ステータスとも整合' :
    direction === 'down' && ['失速警戒', '下落加速', '過熱注意'].includes(analysis.physicsStatus) ? '物理ステータスとも整合' :
    direction === 'mixed' ? '物理ステータスで最終確認' :
    direction === 'neutral' ? '方向ラベル未付与' :
    '物理ステータスと差分あり'
  return {
    ...tone,
    label,
    details: [
      `強い類似 ${strong}件`,
      `参考類似 ${reference}件`,
      `低確信 ${weak}件`,
      `上昇寄り ${up}件`,
      `下落寄り ${down}件`,
      agreement,
    ],
    hint: rows.length > 0
      ? weak > 0 && strong + reference === 0
        ? '強い類似はないため、候補は「形が少し近い」程度に留め、物理ステータス・支持線/抵抗線・短期/中期/長期プランを主判断にします。'
        : 'まず90%以上の候補を優先し、次に物理ステータスと短期/中期/長期プランが同じ方向を示しているかを確認します。'
      : '現在は近い形状が少ないため、類似候補より6ステージと物理ステータスの確認を優先します。',
  }
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'white', padding: 8 }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ marginTop: 3, fontSize: 12, fontWeight: 900, color: 'var(--text-primary)' }}>{value}</div>
    </div>
  )
}

function SimilarReasonBlock({ reason }: { reason: Record<string, string> }) {
  const sections = similarReasonSections(reason)
  if (sections.length === 0) return null
  return (
    <div style={{ marginTop: 10, display: 'grid', gap: 7 }}>
      <div style={{ fontSize: 11, fontWeight: 900, color: 'var(--text-primary)' }}>
        類似根拠
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 7 }}>
        {sections.map((section) => (
          <div
            key={section.key}
            style={{
              border: `1px solid ${section.meta.border}`,
              borderLeft: `4px solid ${section.meta.color}`,
              borderRadius: 8,
              background: section.meta.background,
              padding: '8px 9px',
              display: 'grid',
              gap: 5,
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 900, color: section.meta.color }}>
              {section.meta.title}
            </div>
            <div style={{ display: 'grid', gap: 3 }}>
              {section.bullets.map((bullet, index) => (
                <div
                  key={`${section.key}-${index}-${bullet}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '12px minmax(0, 1fr)',
                    gap: 4,
                    alignItems: 'start',
                    fontSize: 11,
                    lineHeight: 1.5,
                    fontWeight: 750,
                    color: 'var(--text-secondary)',
                  }}
                >
                  <span style={{ color: section.meta.color, fontWeight: 1000 }}>・</span>
                  <span>{bullet}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function PhysicsAnalysisPanel({ analysis }: { analysis: PhysicsAnalysis }) {
  return (
    <div style={{
      border: '1px solid var(--border-subtle)',
      borderRadius: 8,
      background: statusColor(analysis.physicsStatus),
      padding: 10,
      display: 'grid',
      gap: 8,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>物理ステータス</div>
          <div style={{ marginTop: 3, fontSize: 16, fontWeight: 900, color: 'var(--text-primary)' }}>{analysis.physicsStatus}</div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'flex-end' }}>
          <span style={{ border: '1px solid var(--border-subtle)', borderRadius: 999, background: 'white', padding: '4px 8px', fontSize: 11, fontWeight: 800 }}>{analysis.momentumLabel}</span>
          <span style={{ border: '1px solid var(--border-subtle)', borderRadius: 999, background: 'white', padding: '4px 8px', fontSize: 11, fontWeight: 800 }}>{analysis.distanceLabel}</span>
          <span style={{ border: '1px solid var(--border-subtle)', borderRadius: 999, background: 'white', padding: '4px 8px', fontSize: 11, fontWeight: 800 }}>{analysis.pullbackVerdict}</span>
        </div>
      </div>
      <p style={{ margin: 0, fontSize: 12, lineHeight: 1.65, fontWeight: 700, color: 'var(--text-secondary)' }}>{analysis.summary}</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))', gap: 6 }}>
        <MiniMetric label="5SMA速度" value={fmtPct(analysis.metrics.sma5Velocity5)} />
        <MiniMetric label="5SMA加速度" value={fmtPct(analysis.metrics.sma5Acceleration5)} />
        <MiniMetric label="5-25距離" value={fmtPct(analysis.metrics.gap5To25Pct)} />
        <MiniMetric label="距離変化" value={fmtPct(analysis.metrics.gap5To25Velocity5)} />
      </div>
      <div style={{ display: 'grid', gap: 4 }}>
        {analysis.watchPoints.map((point) => (
          <div key={point} style={{ fontSize: 11, lineHeight: 1.55, fontWeight: 700, color: 'var(--text-secondary)' }}>
            {point}
          </div>
        ))}
      </div>
    </div>
  )
}

export function StockMlInsights({
  ticker,
  analysisDate = null,
  market = 'JP',
}: {
  ticker: string
  analysisDate?: string | null
  market?: 'JP' | 'US'
}) {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [caseStudies, setCaseStudies] = useState<CaseStudy[]>([])
  const [casesLoading, setCasesLoading] = useState(false)
  const [casesLoaded, setCasesLoaded] = useState(false)
  const [backendStatus, setBackendStatus] = useState<MlBackendStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    const code = market === 'US' ? ticker.toUpperCase() : ticker.replace(/\.T$/i, '')
    setCaseStudies([])
    setCasesLoaded(false)
    setCasesLoading(false)
    setBackendStatus(null)
    const similarParams = new URLSearchParams({ ticker: code, limit: '6' })
    const historyParams = new URLSearchParams({ ticker: code, limit: '80' })
    if (analysisDate) {
      similarParams.set('date', analysisDate)
      similarParams.set('fallback', '1')
      historyParams.set('date', analysisDate)
    }
    const similarEndpoint = market === 'US' ? '/api/us/ml-current-similars' : '/api/ml/current-similars'
    const historyRequest = market === 'US'
      ? Promise.resolve({ rows: [] })
      : optionalJson<{ rows?: ApiResponse['predictions'] }>(`/api/ml/prediction-history?${historyParams.toString()}`)
        .then((result) => result ?? { rows: [] })
    const statusEndpoint = market === 'US'
      ? `/api/us/ml-status/${encodeURIComponent(code)}${analysisDate ? `?date=${encodeURIComponent(analysisDate)}` : ''}`
      : '/api/ml/reliability-status'
    Promise.all([
      requiredJson<Partial<ApiResponse>>(`${similarEndpoint}?${similarParams.toString()}`),
      historyRequest,
      optionalJson<MlBackendStatus>(statusEndpoint),
    ])
      .then(([similarJson, historyJson, statusJson]) => {
        if (!cancelled) {
          setData({
            asOfDate: similarJson.asOfDate ?? null,
            featureAsOfDate: similarJson.featureAsOfDate ?? similarJson.asOfDate ?? null,
            source: similarJson.source ?? null,
            physicsAnalysis: similarJson.physicsAnalysis ?? null,
            similars: Array.isArray(similarJson.similars) ? similarJson.similars : [],
            caseStudies: [],
            predictions: Array.isArray(historyJson?.rows) ? historyJson.rows : [],
          })
          setBackendStatus(statusJson)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setData({ asOfDate: null, featureAsOfDate: null, source: null, physicsAnalysis: null, similars: [], caseStudies: [], predictions: [] })
          setBackendStatus(null)
        }
      })
    return () => { cancelled = true }
  }, [analysisDate, market, ticker])

  const rows = data?.similars ?? []
  const predictions = data?.predictions ?? []
  const mlReading = data ? buildMlReading(rows, data.physicsAnalysis) : null
  const reliabilityBackend = backendReliability(backendStatus, market)
  const completedPredictions = predictions.filter((prediction) => prediction.outcome != null)
  const reliability = data ? assessMlReliability({
    asOfDate: data.asOfDate,
    featureDate: data.featureAsOfDate,
    modelDate: reliabilityBackend.modelDate,
    evaluationDate: reliabilityBackend.evaluationDate,
    similarityScores: rows.map((row) => row.similarityScore),
    completedPredictions: completedPredictions.length,
    hitPredictions: completedPredictions.filter((prediction) => prediction.outcome?.hitLabel).length,
    validationRuns: reliabilityBackend.validationRuns,
    validationSamples: reliabilityBackend.validationSamples,
    healthIssueCount: reliabilityBackend.healthIssueCount,
  }) : null
  const loadCaseStudies = () => {
    if (market === 'US' || casesLoading || casesLoaded) return
    setCasesLoading(true)
    const code = ticker.replace(/\.T$/i, '')
    const params = new URLSearchParams({ ticker: code, limit: '6', includeCases: '1' })
    if (analysisDate) params.set('date', analysisDate)
    fetch(`/api/ml/current-similars?${params.toString()}`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((json) => {
        setCaseStudies(Array.isArray(json.caseStudies) ? json.caseStudies : [])
        setCasesLoaded(true)
      })
      .catch(() => {
        setCaseStudies([])
        setCasesLoaded(true)
      })
      .finally(() => setCasesLoading(false))
  }

  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="section-header" style={{ marginBottom: 8 }}>
        ML類似候補
      </div>
      <p style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', lineHeight: 1.6 }}>
        {analysisDate ? `${analysisDate}以前のデータ上で` : '最新データ上で'}、6桁ステージと5/25/75/200日MAの角度・距離感が近い銘柄です。
        90%以上は強い類似、80〜90%は参考類似、80%未満は「低確信の近似」として慎重に表示します。
        {data?.featureAsOfDate ? ` ML特徴量基準日: ${data.featureAsOfDate}` : data?.asOfDate ? ` 基準日: ${data.asOfDate}` : ''}
      </p>
      <div style={{ display: 'grid', gap: 8 }}>
        {!data && Array.from({ length: 3 }).map((_, index) => (
          <div key={index} style={{ minHeight: 56, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--surface-muted)' }} />
        ))}
        {reliability && <MlReliabilityStrip assessment={reliability} />}
        {data?.physicsAnalysis && <PhysicsAnalysisPanel analysis={data.physicsAnalysis} />}
        {mlReading && (
          <div style={{
            border: `1px solid ${mlReading.border}`,
            borderRadius: 8,
            background: mlReading.background,
            padding: 10,
            display: 'grid',
            gap: 7,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 13, color: mlReading.color }}>{mlReading.label}</strong>
              <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>
                ML類似候補の読み方
              </span>
            </div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {mlReading.details.map((detail) => (
                <span key={detail} style={{
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 999,
                  background: 'white',
                  padding: '3px 7px',
                  fontSize: 10,
                  fontWeight: 800,
                  color: 'var(--text-secondary)',
                }}>
                  {detail}
                </span>
              ))}
            </div>
            <p style={{ margin: 0, fontSize: 11, lineHeight: 1.55, color: 'var(--text-secondary)', fontWeight: 700 }}>
              {mlReading.hint}
            </p>
          </div>
        )}
        {data && rows.length === 0 && (
          <div style={{
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            background: 'var(--surface-muted)',
            padding: 10,
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--text-muted)',
          }}>
            ML類似候補は現在ありません。ML特徴量が未生成、または十分に近いMA形状がない場合は表示しません。
          </div>
        )}
        {data && rows.map((row) => {
          const direction = row.similarDirection === 'up' ? '上昇候補' : row.similarDirection === 'down' ? '下落警戒' : '近似形状'
          const band = similarityBand(row.similarityScore)
          return (
            <div
              key={`${row.similarTicker}-${row.rank}`}
              style={{
                border: `1px solid ${band.border}`,
                borderRadius: 8,
                background: band.background,
                padding: 10,
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                <div>
                  <Link href={market === 'US' ? `/us/stock/${row.similarTicker}#ml` : `/stock/${row.similarTicker}#ml`} style={{ fontWeight: 800, color: 'var(--accent-primary)' }}>
                    {row.similarTicker} {row.payload.similar?.name ?? ''}
                  </Link>
                  <div style={{ marginTop: 3, fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>
                    {direction} / 類似度 {Math.round(row.similarityScore * 100)}% / {stageTags(row.payload.similar?.stageCode)}
                  </div>
                </div>
                <div style={{ display: 'grid', justifyItems: 'end', gap: 4 }}>
                  <span style={{
                    border: `1px solid ${band.border}`,
                    borderRadius: 999,
                    background: 'white',
                    padding: '3px 8px',
                    fontSize: 10,
                    fontWeight: 900,
                    color: band.color,
                  }}>
                    {band.label}
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>
                    {row.payload.similar?.sector17Name ?? '業種なし'}
                  </span>
                </div>
              </div>
              <SimilarReasonBlock reason={row.reason} />
            </div>
          )
        })}
        {data && market === 'JP' && (
          <div style={{ marginTop: 4, borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-primary)' }}>
                  過去ケーススタディ
                </div>
                <div style={{ marginTop: 2, fontSize: 10, fontWeight: 700, color: 'var(--text-muted)' }}>
                  チャート付きの重い分析は必要な時だけ読み込みます
                </div>
              </div>
              {!casesLoaded && (
                <button
                  type="button"
                  onClick={loadCaseStudies}
                  disabled={casesLoading}
                  className="rounded-full border border-[var(--color-border-soft)] bg-white px-3 py-1.5 text-[11px] font-bold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)] disabled:opacity-60"
                >
                  {casesLoading ? '読み込み中...' : 'ケースを表示'}
                </button>
              )}
              {casesLoaded && caseStudies.length === 0 && (
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>類似度80%以上の過去ケースはありません</span>
              )}
            </div>
          </div>
        )}
        {caseStudies.length > 0 && (
          <div style={{ marginTop: 4, borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-primary)' }}>
                過去ケーススタディ
              </div>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)' }}>
                同じMA形状がその後どう動いたか
              </div>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {caseStudies.map((study) => (
                <div
                  key={`${study.ticker}-${study.caseDate}-${study.rank}`}
                  style={{
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 8,
                    background: 'var(--surface-muted)',
                    padding: 10,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <div>
                      <Link href={market === 'US' ? `/us/stock/${study.ticker}#ml` : `/stock/${study.ticker}#ml`} style={{ fontSize: 12, fontWeight: 900, color: 'var(--accent-primary)' }}>
                        {study.ticker} {study.name ?? ''}
                      </Link>
                      <div style={{ marginTop: 3, fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                        {study.caseDate} / {study.pattern} / {study.physicsStatus ?? '物理判定なし'} / 類似度 {Math.round(study.similarityScore * 100)}%
                      </div>
                    </div>
                    <div style={{ display: 'grid', gap: 3, justifyItems: 'end', fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>
                      <span>{stageTags(study.stageCode)}</span>
                      <span>{study.sector17Name ?? '業種なし'}</span>
                    </div>
                  </div>
                  <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
                    <p style={{ margin: 0, fontSize: 11, lineHeight: 1.6, color: 'var(--text-secondary)' }}>{study.summary}</p>
                    <p style={{ margin: 0, fontSize: 11, lineHeight: 1.6, color: 'var(--text-secondary)' }}>{study.maComment}</p>
                    {study.pullbackVerdict && (
                      <p style={{ margin: 0, fontSize: 11, lineHeight: 1.6, color: 'var(--text-secondary)', fontWeight: 800 }}>
                        押し目判定: {study.pullbackVerdict}
                      </p>
                    )}
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 10, fontWeight: 800 }}>
                      <span style={{ border: '1px solid var(--border-subtle)', borderRadius: 999, padding: '3px 7px', background: 'white' }}>1週 {fmtPct(study.returns.week1)}</span>
                      <span style={{ border: '1px solid var(--border-subtle)', borderRadius: 999, padding: '3px 7px', background: 'white' }}>2週 {fmtPct(study.returns.week2)}</span>
                      <span style={{ border: '1px solid var(--border-subtle)', borderRadius: 999, padding: '3px 7px', background: 'white' }}>3週 {fmtPct(study.returns.week3)}</span>
                      <span style={{ border: '1px solid var(--border-subtle)', borderRadius: 999, padding: '3px 7px', background: 'white' }}>最大 {fmtPct(study.returns.maxWeek3)}</span>
                      <span style={{ border: '1px solid var(--border-subtle)', borderRadius: 999, padding: '3px 7px', background: 'white' }}>最小 {fmtPct(study.returns.minWeek3)}</span>
                    </div>
                    {study.chart && study.chart.series.length > 0 && (
                      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'white', padding: 8 }}>
                        <BacktestHighlightChart
                          series={study.chart.series}
                          highlightStart={study.chart.highlightStart}
                          highlightEnd={study.chart.highlightEnd}
                          direction={study.chart.direction}
                          stagePath={study.chart.stagePath}
                          startPrice={study.chart.startPrice}
                          endPrice={study.chart.endPrice}
                          returnPct={study.chart.returnPct}
                          height={220}
                        />
                      </div>
                    )}
                    {study.evolution.length > 0 && (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))', gap: 6 }}>
                        {study.evolution.map((point) => (
                          <div key={`${study.ticker}-${point.date}-${point.afterDays}`} style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'white', padding: 8 }}>
                            <div style={{ fontSize: 10, fontWeight: 900, color: 'var(--text-primary)' }}>
                              {point.afterDays === 0 ? '発生日' : `${point.afterDays}営業日後`}
                            </div>
                            <div style={{ marginTop: 3, fontSize: 10, color: 'var(--text-muted)', fontWeight: 700 }}>{point.date}</div>
                            <div style={{ marginTop: 5, display: 'grid', gap: 3, fontSize: 10, color: 'var(--text-secondary)', fontWeight: 700 }}>
                              <span>{stageTags(point.stageCode)}</span>
                              <span>終値 {fmtPrice(point.close)}円</span>
                              <span>5日MA {fmtPct(point.sma5Velocity5)}</span>
                              <span>25日MA {fmtPct(point.sma25Velocity5)}</span>
                              <span>5-25距離 {fmtPct(point.gap5To25Pct)}</span>
                              <span>{trendLabel(point.trend)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {study.stagePath.length > 0 && (
                      <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-secondary)', fontWeight: 700 }}>
                        ステージ遷移: {study.stagePath.join(' → ')}
                      </div>
                    )}
                    <p style={{ margin: 0, fontSize: 11, lineHeight: 1.6, color: 'var(--text-primary)', fontWeight: 700 }}>
                      {study.hint}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {predictions.length > 0 && (
          <div style={{ marginTop: 4, borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 8 }}>
              過去のML予測と実績
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              {predictions.slice(0, 4).map((row) => (
                <div
                  key={`${row.asOfDate}-${row.horizonDays}-${row.direction}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(86px, 1fr) minmax(70px, auto) minmax(70px, auto)',
                    gap: 8,
                    alignItems: 'center',
                    fontSize: 11,
                    fontWeight: 700,
                    color: 'var(--text-secondary)',
                  }}
                >
                  <span>{row.asOfDate} / {row.horizonDays}日</span>
                  <span>{row.direction === 'up' ? '上昇候補' : '下落警戒'} #{row.rank}</span>
                  <span>
                    {row.outcome
                      ? `${row.outcome.hitLabel ? '的中' : '未達'} / ${fmtPct(row.outcome.returnPct)}`
                      : '結果待ち'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
